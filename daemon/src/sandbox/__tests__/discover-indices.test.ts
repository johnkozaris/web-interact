import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import { runScript } from "../script-runner-quickjs.js";
import { ensureSandboxClientBundle } from "./bundle-test-helpers.js";

// Each button records its own click on the document it belongs to, so a click that
// lands on an old document leaves the current one unmarked.
function indexPageHtml({ banner = false, saved = false } = {}): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Index Actions</title>
  </head>
  <body>
    ${banner ? `<button id="dismiss" type="button" onclick="document.body.dataset.clicked = this.id">Dismiss</button>` : ""}
    ${saved ? `<p id="saved">Saved</p>` : ""}
    <button id="mark" type="button" onclick="document.body.dataset.clicked = this.id">Mark</button>
    <form method="post"><button id="save">Save</button></form>
  </body>
</html>`;
}

const INPUTS_PAGE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Index Typing</title>
  </head>
  <body>
    <input id="first" placeholder="First" autofocus>
    <input id="second" placeholder="Second">
  </body>
</html>`;

// Corner sits at the viewport's top-left, where a click aimed at an element with no box
// used to land.
const CORNER_PAGE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Index Corner</title>
  </head>
  <body>
    <button id="corner" type="button" style="position: fixed; left: 0; top: 0" onclick="document.body.dataset.clicked = this.id">Corner</button>
    <button id="target" type="button" style="margin: 120px 0 0 200px" onclick="document.body.dataset.clicked = this.id">Target</button>
  </body>
</html>`;

// After discover, the test disables, hides and redirects these; Plain keeps focus throughout.
const UNFOCUSABLE_PAGE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Index Focus</title>
  </head>
  <body>
    <input id="plain" aria-label="Plain" autofocus>
    <input id="disabled" aria-label="Disabled later">
    <input id="hidden" aria-label="Hidden later">
    <input id="redirecting" aria-label="Redirecting">
  </body>
</html>`;

// Fields that take focus in their own way: an editable div, and inputs in an open and a
// closed shadow root. The closed one copies its value to its host so tests can read it.
const WIDGETS_PAGE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Index Widgets</title>
  </head>
  <body>
    <div id="notes" contenteditable="true" role="textbox" aria-label="Notes"></div>
    <div id="open-host"></div>
    <div id="closed-host"></div>
    <script>
      document.getElementById("open-host").attachShadow({ mode: "open" }).innerHTML =
        '<input aria-label="Open shadow">';
      const closedHost = document.getElementById("closed-host");
      const closedRoot = closedHost.attachShadow({ mode: "closed" });
      closedRoot.innerHTML = '<input aria-label="Closed shadow">';
      closedRoot.querySelector("input").addEventListener("input", (event) => {
        closedHost.dataset.value = event.target.value;
      });
    </script>
  </body>
</html>`;

interface IndexTestSite {
  origin: string;
  close: () => Promise<void>;
}

async function startIndexTestSite(): Promise<IndexTestSite> {
  let shiftingLoads = 0;
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");
    let html: string;
    if (pathname === "/form") {
      // The form posts back to its own URL, like a server-rendered save.
      html = indexPageHtml({ saved: request.method === "POST" });
    } else if (pathname === "/shifting") {
      // From the second load on, a new button pushes Mark down one index.
      shiftingLoads += 1;
      html = indexPageHtml({ banner: shiftingLoads > 1 });
    } else if (pathname === "/inputs") {
      html = INPUTS_PAGE_HTML;
    } else if (pathname === "/corner") {
      html = CORNER_PAGE_HTML;
    } else if (pathname === "/unfocusable") {
      html = UNFOCUSABLE_PAGE_HTML;
    } else if (pathname === "/widgets") {
      html = WIDGETS_PAGE_HTML;
    } else {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }

    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("acting by discover index", () => {
  let browserRootDir = "";
  let manager: BrowserManager;
  let site: IndexTestSite;

  // Every step is its own script, like separate CLI commands.
  const run = async (script: string): Promise<string> => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    await runScript(
      script,
      manager,
      "default",
      {
        onStdout: (data) => {
          stdout.push(data);
        },
        onStderr: (data) => {
          stderr.push(data);
        },
      },
      { timeout: 60_000 }
    );
    expect(stderr.join("")).toBe("");
    return stdout.join("").trim();
  };

  const open = (pageName: string, url: string): Promise<string> =>
    run(`await (await browser.getPage(${JSON.stringify(pageName)})).goto(${JSON.stringify(url)});`);

  const discoverNames = async (pageName: string): Promise<string[]> =>
    JSON.parse(
      await run(`
        const { elements } = await browser.discover(${JSON.stringify(pageName)});
        console.log(JSON.stringify(elements.map((element) => element.name)));
      `)
    );

  const click = async (pageName: string, index: number): Promise<{ success: boolean; error?: string }> =>
    JSON.parse(
      await run(`console.log(JSON.stringify(await browser.click(${JSON.stringify(pageName)}, ${index})));`)
    );

  const clicked = (pageName: string): Promise<string> =>
    run(`
      const page = await browser.getPage(${JSON.stringify(pageName)});
      console.log(await page.evaluate(() => document.body.dataset.clicked ?? "nothing"));
    `);

  const type = async (
    pageName: string,
    index: number,
    text: string,
    options: { clearFirst?: boolean } = {}
  ): Promise<{ success: boolean; error?: string }> =>
    JSON.parse(
      await run(
        `console.log(JSON.stringify(await browser.type(${JSON.stringify(pageName)}, ${index}, ${JSON.stringify(text)}, ${JSON.stringify(options)})));`
      )
    );

  // The values of the inputs page's First and Second fields, as "first|second".
  const fieldValues = (pageName: string): Promise<string> =>
    run(`
      const page = await browser.getPage(${JSON.stringify(pageName)});
      console.log(await page.evaluate(() =>
        document.getElementById("first").value + "|" + document.getElementById("second").value
      ));
    `);

  beforeAll(async () => {
    await ensureSandboxClientBundle();
    site = await startIndexTestSite();

    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "web-interact-indices-"));
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

  it("clicks by index after a same-URL goto, a reload and a form post", async () => {
    const url = `${site.origin}/form`;
    await open("same-url", url);
    const names = await discoverNames("same-url");
    const mark = names.indexOf("Mark") + 1;
    const save = names.indexOf("Save") + 1;
    expect(mark, names.join(", ")).toBeGreaterThan(0);
    expect(save, names.join(", ")).toBeGreaterThan(0);

    // No discover between these steps: each one loads a new document at the same URL.
    await open("same-url", url);
    expect(await click("same-url", mark)).toMatchObject({ success: true });
    expect(await clicked("same-url")).toBe("mark");

    await run(`await (await browser.getPage("same-url")).reload();`);
    expect(await clicked("same-url")).toBe("nothing");
    expect(await click("same-url", mark)).toMatchObject({ success: true });
    expect(await clicked("same-url")).toBe("mark");

    expect(await click("same-url", save)).toMatchObject({ success: true });
    await run(`await (await browser.getPage("same-url")).waitForSelector("#saved");`);
    expect(await clicked("same-url")).toBe("nothing");
    expect(await click("same-url", mark)).toMatchObject({ success: true });
    expect(await clicked("same-url")).toBe("mark");
  }, 120_000);

  it("refuses an index that names another element after a same-URL reload", async () => {
    await open("shifting", `${site.origin}/shifting`);
    const mark = (await discoverNames("shifting")).indexOf("Mark") + 1;
    expect(mark).toBe(1);

    // The reload inserts Dismiss above Mark, so index 1 now names Dismiss.
    await run(`await (await browser.getPage("shifting")).reload();`);
    expect(await click("shifting", mark)).toEqual({
      success: false,
      error:
        'Element [1] was button "Mark" before the page reloaded and is now button "Dismiss". Run discover again.',
    });
    expect(await clicked("shifting")).toBe("nothing");
  }, 120_000);

  it("refuses to click an element that was replaced or hidden since discover", async () => {
    const refused = { success: false, error: expect.stringContaining("nothing was clicked") };

    // Like a re-render: Target is swapped for a copy in the same document, so the URL and
    // document are unchanged and the discovered node is detached.
    await open("corner", `${site.origin}/corner`);
    const target = (await discoverNames("corner")).indexOf("Target") + 1;
    expect(target).toBeGreaterThan(0);
    await run(`
      await (await browser.getPage("corner")).evaluate(() => {
        const old = document.getElementById("target");
        old.replaceWith(old.cloneNode(true));
      });
    `);
    expect(await click("corner", target)).toMatchObject(refused);
    expect(await clicked("corner")).toBe("nothing");

    const fresh = (await discoverNames("corner")).indexOf("Target") + 1;
    expect(await click("corner", fresh)).toMatchObject({ success: true });
    expect(await clicked("corner")).toBe("target");

    await open("corner", `${site.origin}/corner`);
    const hidden = (await discoverNames("corner")).indexOf("Target") + 1;
    await run(`
      await (await browser.getPage("corner")).evaluate(() => {
        document.getElementById("target").style.display = "none";
      });
    `);
    expect(await click("corner", hidden)).toMatchObject(refused);
    expect(await clicked("corner")).toBe("nothing");
  }, 120_000);

  it("types by index into the discovered field after a same-URL reload", async () => {
    await open("typing", `${site.origin}/inputs`);
    const second = (await discoverNames("typing")).indexOf("Second") + 1;
    expect(second).toBeGreaterThan(0);

    // The reload puts focus back on First, which is where keys sent to a stale node land.
    await run(`await (await browser.getPage("typing")).reload();`);
    expect(await type("typing", second, "typed")).toMatchObject({ success: true });
    expect(await fieldValues("typing")).toBe("|typed");
  }, 120_000);

  it("refuses to type into a field that was replaced since discover", async () => {
    await open("replaced", `${site.origin}/inputs`);
    const second = (await discoverNames("replaced")).indexOf("Second") + 1;
    expect(second).toBeGreaterThan(0);

    // Like a re-render: Second is swapped for a copy in the same document, so the URL
    // and document are unchanged, the discovered node is detached, and First has focus.
    await run(`
      const page = await browser.getPage("replaced");
      await page.evaluate(() => {
        const old = document.getElementById("second");
        old.replaceWith(old.cloneNode());
      });
    `);
    const refused = { success: false, error: expect.stringContaining("could not be focused") };
    expect(await type("replaced", second, "typed")).toMatchObject(refused);
    expect(await type("replaced", second, "filled", { clearFirst: true })).toMatchObject(refused);
    expect(await fieldValues("replaced")).toBe("|");

    const fresh = (await discoverNames("replaced")).indexOf("Second") + 1;
    expect(await type("replaced", fresh, "typed")).toMatchObject({ success: true });
    expect(await fieldValues("replaced")).toBe("|typed");
  }, 120_000);

  it("refuses to type into a field that is disabled, hidden or hands focus away", async () => {
    await open("unfocusable", `${site.origin}/unfocusable`);
    const names = await discoverNames("unfocusable");
    await run(`
      const page = await browser.getPage("unfocusable");
      await page.evaluate(() => {
        document.getElementById("disabled").disabled = true;
        document.getElementById("hidden").style.display = "none";
        const plain = document.getElementById("plain");
        document.getElementById("redirecting").addEventListener("focus", () => plain.focus());
      });
    `);
    for (const name of ["Disabled later", "Hidden later", "Redirecting"]) {
      const index = names.indexOf(name) + 1;
      expect(index, names.join(", ")).toBeGreaterThan(0);
      expect(await type("unfocusable", index, "x"), name).toMatchObject({
        success: false,
        error: expect.stringContaining("could not be focused"),
      });
    }
    expect(
      await run(`
        const page = await browser.getPage("unfocusable");
        console.log(await page.evaluate(() =>
          [...document.querySelectorAll("input")].map((input) => input.value).join("|")
        ));
      `)
    ).toBe("|||");
  }, 120_000);

  it("types by index into an editable div and inputs in shadow roots", async () => {
    await open("widgets", `${site.origin}/widgets`);
    const names = await discoverNames("widgets");
    for (const name of ["Notes", "Open shadow", "Closed shadow"]) {
      const index = names.indexOf(name) + 1;
      expect(index, names.join(", ")).toBeGreaterThan(0);
      expect(await type("widgets", index, name.toLowerCase())).toMatchObject({ success: true });
    }
    expect(
      await run(`
        const page = await browser.getPage("widgets");
        console.log(await page.evaluate(() => [
          document.getElementById("notes").textContent,
          document.getElementById("open-host").shadowRoot.querySelector("input").value,
          document.getElementById("closed-host").dataset.value,
        ].join("|")));
      `)
    ).toBe("notes|open shadow|closed shadow");
  }, 120_000);

  it("re-discovers after navigating to another URL", async () => {
    await open("other-url", `${site.origin}/form`);
    const mark = (await discoverNames("other-url")).indexOf("Mark") + 1;
    expect(mark).toBeGreaterThan(0);

    await open("other-url", `${site.origin}/form?step=2`);
    expect(await click("other-url", mark)).toMatchObject({ success: true });
    expect(await clicked("other-url")).toBe("mark");
  }, 120_000);
});
