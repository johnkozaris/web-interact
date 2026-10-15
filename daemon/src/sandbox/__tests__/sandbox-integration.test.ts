import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import { runScript } from "../script-runner-quickjs.js";
import { ensureSandboxClientBundle } from "./bundle-test-helpers.js";
import {
  LOCAL_TEST_PAGE_TITLE,
  startLocalTestSite,
  type LocalTestSite,
} from "./local-test-site.js";

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

function createOutput(): CapturedOutput & {
  sink: {
    onStdout: (data: string) => void;
    onStderr: (data: string) => void;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    sink: {
      onStdout: (data) => {
        stdout.push(data);
      },
      onStderr: (data) => {
        stderr.push(data);
      },
    },
  };
}

describe("QuickJS sandbox integration", () => {
  let browserRootDir = "";
  let manager: BrowserManager;
  let site: LocalTestSite;

  beforeAll(async () => {
    await ensureSandboxClientBundle();
    site = await startLocalTestSite();

    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "web-interact-quickjs-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
    await manager.ensureBrowser("default", {
      headless: true,
    });
  }, 180_000);

  afterAll(async () => {
    await manager.stopAll();
    await site?.close();
    await rm(browserRootDir, {
      recursive: true,
      force: true,
    });
  }, 180_000);

  it("navigates through QuickJS and logs the page title", async () => {
    const output = createOutput();

    await runScript(
      `
        const page = await browser.getPage("nav");
        await page.goto(${JSON.stringify(site.url)});
        console.log(await page.title());
      `,
      manager,
      "default",
      output.sink,
      {
        timeout: 60_000,
      }
    );

    expect(output.stdout.join("")).toContain(LOCAL_TEST_PAGE_TITLE);
    expect(output.stderr.join("")).toBe("");
  }, 120_000);

  it("supports locator operations", async () => {
    const output = createOutput();

    await runScript(
      `
        const page = await browser.getPage("locator");
        await page.goto(${JSON.stringify(site.url)});
        console.log(await page.locator("h1").textContent());
      `,
      manager,
      "default",
      output.sink,
      {
        timeout: 60_000,
      }
    );

    expect(output.stdout.join("")).toContain(LOCAL_TEST_PAGE_TITLE);
  }, 120_000);

  it("supports page.evaluate", async () => {
    const output = createOutput();

    await runScript(
      `
        const page = await browser.getPage("evaluate");
        await page.goto(${JSON.stringify(site.url)});
        console.log(await page.evaluate(() => document.title));
      `,
      manager,
      "default",
      output.sink,
      {
        timeout: 60_000,
      }
    );

    expect(output.stdout.join("")).toContain(LOCAL_TEST_PAGE_TITLE);
  }, 120_000);

  it("reports thrown script errors", async () => {
    const output = createOutput();

    await expect(
      runScript(
        `
          throw new Error("boom");
        `,
        manager,
        "default",
        output.sink
      )
    ).rejects.toThrow("boom");
  });

  it("enforces CPU timeouts", async () => {
    const output = createOutput();

    await expect(
      runScript(
        `
          while (true) {}
        `,
        manager,
        "default",
        output.sink,
        {
          timeout: 25,
        }
      )
    ).rejects.toThrow(/timed out|interrupted/i);
  }, 120_000);

  it("enforces wall-clock timeouts for async scripts", async () => {
    const output = createOutput();

    await expect(
      runScript(
        `
          await new Promise((resolve) => setTimeout(resolve, 100));
        `,
        manager,
        "default",
        output.sink,
        {
          timeout: 25,
        }
      )
    ).rejects.toThrow(/timed out|terminated/i);
  }, 120_000);

  it("keeps browser.route() mocks across scripts until browser.unroute()", async () => {
    const run = async (script: string): Promise<string> => {
      const output = createOutput();
      await runScript(script, manager, "default", output.sink, { timeout: 60_000 });
      expect(output.stderr.join("")).toBe("");
      return output.stdout.join("").trim();
    };
    const fetchStatus = `
      const page = await browser.getPage("persistent-route");
      console.log(await page.evaluate(async () => {
        const response = await fetch("/api/user");
        return response.status + " " + (await response.text());
      }));
    `;

    await run(`
      const page = await browser.getPage("persistent-route");
      await page.goto(${JSON.stringify(site.url)});
      await browser.route("persistent-route", "**/api/user", {
        status: 200,
        contentType: "application/json",
        body: '{"name":"Mock"}',
      });
      await browser.route("persistent-route", "**/api/blocked", { abort: true });
    `);
    expect(await run(fetchStatus)).toBe('200 {"name":"Mock"}');
    expect(
      await run(`
        const page = await browser.getPage("persistent-route");
        console.log(await page.evaluate(() => fetch("/api/blocked").then(() => "loaded", () => "failed")));
      `)
    ).toBe("failed");

    // A second route for the same pattern replaces the first.
    await run(`await browser.route("persistent-route", "**/api/user", { status: 503, body: "down" });`);
    expect(await run(fetchStatus)).toBe("503 down");

    await run(`await browser.unroute("persistent-route", "**/api/user");`);
    expect(await run(fetchStatus)).toBe("404 not found");

    await run(`await browser.unroute("persistent-route");`);
    expect(
      await run(`
        const page = await browser.getPage("persistent-route");
        console.log(await page.evaluate(() => fetch("/api/blocked").then((r) => String(r.status), () => "failed")));
      `)
    ).toBe("404");
  }, 120_000);

  it("rejects invalid browser.route() responses", async () => {
    const output = createOutput();
    await expect(
      runScript(
        `await browser.route("persistent-route", "**/api/user", { status: 42 });`,
        manager,
        "default",
        output.sink
      )
    ).rejects.toThrow(/status must be an HTTP status code/);
  });

  it("routes console output to stdout", async () => {
    const output = createOutput();

    await runScript(
      `
        console.log("sandbox", 42, { ok: true });
      `,
      manager,
      "default",
      output.sink
    );

    expect(output.stdout.join("")).toContain("sandbox 42 { ok: true }");
    expect(output.stderr.join("")).toBe("");
  });
});
