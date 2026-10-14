import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import { QuickJSSandbox } from "../quickjs-sandbox.js";
import {
  LOCAL_TEST_PAGE_TITLE,
  startLocalTestSite,
  type LocalTestSite,
} from "./local-test-site.js";

const browserName = "named-pages";

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

function pageNames(pages: Array<{ name: string | null }>): string[] {
  return pages
    .map((page) => page.name)
    .filter((name): name is string => typeof name === "string")
    .sort((left, right) => left.localeCompare(right));
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

function outputLines(output: CapturedOutput): string[] {
  return output.stdout.map((line) => line.trim()).filter((line) => line.length > 0);
}

describe("QuickJS named page management", () => {
  let browserRootDir = "";
  let manager: BrowserManager;
  let site: LocalTestSite;

  beforeAll(async () => {
    site = await startLocalTestSite();
    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "web-interact-quickjs-named-pages-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
  }, 180_000);

  afterEach(async () => {
    await manager.stopBrowser(browserName);
  }, 180_000);

  afterAll(async () => {
    await manager.stopAll();
    await site?.close();
    await rm(browserRootDir, {
      recursive: true,
      force: true,
    });
  }, 180_000);

  async function createSandbox(output: ReturnType<typeof createOutput>): Promise<QuickJSSandbox> {
    await manager.ensureBrowser(browserName, {
      headless: true,
    });

    const sandbox = new QuickJSSandbox({
      manager,
      browserName,
      onStdout: output.sink.onStdout,
      onStderr: output.sink.onStderr,
      timeoutMs: 60_000,
    });
    await sandbox.initialize();
    return sandbox;
  }

  async function runUserScript(sandbox: QuickJSSandbox, script: string): Promise<void> {
    await sandbox.executeScript(`(async () => {\n${script}\n})()`);
  }

  it("persists named pages across script executions", async () => {
    const output = createOutput();
    const sandbox = await createSandbox(output);

    try {
      await runUserScript(
        sandbox,
        `
        const page = await browser.getPage("persist");
        await page.goto(${JSON.stringify(site.url)});
        await page.evaluate(() => {
          window.name = "persisted-state";
        });
        console.log(await page.title());
      `
      );

      await runUserScript(
        sandbox,
        `
        const page = await browser.getPage("persist");
        console.log(page.url());
        console.log(await page.title());
        console.log(await page.evaluate(() => window.name));
      `
      );
    } finally {
      await sandbox.dispose();
    }

    expect(output.stderr).toEqual([]);
    expect(outputLines(output)).toContain(site.url);
    expect(outputLines(output)).toContain(LOCAL_TEST_PAGE_TITLE);
    expect(outputLines(output)).toContain("persisted-state");
    expect(pageNames(await manager.listPages(browserName))).toEqual(["persist"]);
  }, 120_000);

  it("cleans up anonymous pages after each script execution", async () => {
    const output = createOutput();
    await manager.ensureBrowser(browserName, {
      headless: true,
    });
    const entry = await manager.ensureBrowser(browserName);
    const baselinePageCount = entry.context.pages().filter((page) => !page.isClosed()).length;
    const sandbox = await createSandbox(output);

    try {
      await runUserScript(
        sandbox,
        `
        const page = await browser.newPage();
        await page.goto(${JSON.stringify(site.url)});
        console.log(await page.title());
      `
      );
    } finally {
      await sandbox.dispose();
    }

    const livePages = entry.context.pages().filter((page) => !page.isClosed());

    expect(output.stderr).toEqual([]);
    expect(outputLines(output)).toContain(LOCAL_TEST_PAGE_TITLE);
    expect(livePages).toHaveLength(baselinePageCount);
    expect(livePages.map((page) => page.url())).not.toContain(site.url);
    expect(pageNames(await manager.listPages(browserName))).toEqual([]);
  }, 120_000);

  it("lists the current named pages", async () => {
    const output = createOutput();
    const sandbox = await createSandbox(output);

    try {
      await runUserScript(
        sandbox,
        `
        await browser.getPage("beta");
        await browser.getPage("alpha");
        console.log(JSON.stringify(await browser.listPages()));
      `
      );
    } finally {
      await sandbox.dispose();
    }

    expect(output.stderr).toEqual([]);
    const listedPages = JSON.parse(outputLines(output).at(-1) ?? "[]") as Array<{
      id: string;
      title: string;
      url: string;
      name: string | null;
    }>;

    expect(listedPages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(String),
          name: "alpha",
          title: expect.any(String),
          url: expect.any(String),
        }),
        expect.objectContaining({
          id: expect.any(String),
          name: "beta",
          title: expect.any(String),
          url: expect.any(String),
        }),
      ])
    );
    expect(pageNames(listedPages)).toEqual(["alpha", "beta"]);
    expect(pageNames(await manager.listPages(browserName))).toEqual(["alpha", "beta"]);
  }, 120_000);

  it("closes named pages by name", async () => {
    const output = createOutput();
    const sandbox = await createSandbox(output);

    try {
      await runUserScript(
        sandbox,
        `
        await browser.getPage("close-me");
      `
      );
      await runUserScript(
        sandbox,
        `
        console.log(JSON.stringify(await browser.listPages()));
        await browser.closePage("close-me");
        console.log(JSON.stringify(await browser.listPages()));
      `
      );
    } finally {
      await sandbox.dispose();
    }

    expect(output.stderr).toEqual([]);
    const listedBeforeClose = JSON.parse(outputLines(output).at(0) ?? "[]") as Array<{
      name: string | null;
    }>;
    const listedAfterClose = JSON.parse(outputLines(output).at(1) ?? "[]") as Array<{
      name: string | null;
    }>;

    expect(pageNames(listedBeforeClose)).toEqual(["close-me"]);
    expect(pageNames(listedAfterClose)).toEqual([]);
    expect(pageNames(await manager.listPages(browserName))).toEqual([]);
  }, 120_000);
});
