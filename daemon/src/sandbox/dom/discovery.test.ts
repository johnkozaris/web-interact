import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import { getPageElementsCDP } from "./service.js";

const browserName = "dom-discovery";

const STATE_PAGE_HTML = `<!doctype html>
<title>States</title>
<label><input type="checkbox" id="on" checked> Checked box</label>
<label><input type="checkbox" id="off"> Unchecked box</label>
<label><input type="checkbox" id="mixed"> Mixed box</label>
<label><input type="radio" name="size" id="small"> Small</label>
<label><input type="radio" name="size" id="large" checked> Large</label>
<div role="checkbox" aria-checked="false" tabindex="0">ARIA unchecked</div>
<button aria-pressed="true">Bold</button>
<button aria-pressed="false">Italic</button>
<button aria-pressed="mixed">Underline</button>
<script>document.getElementById("mixed").indeterminate = true;</script>`;

describe("DOM discovery state", () => {
  let browserRootDir = "";
  let manager: BrowserManager;

  beforeAll(async () => {
    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "web-interact-dom-discovery-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
    await manager.ensureBrowser(browserName, {
      headless: true,
    });
  }, 180_000);

  afterAll(async () => {
    await manager.stopAll();
    await rm(browserRootDir, {
      recursive: true,
      force: true,
    });
  }, 180_000);

  it("reports checked and pressed only when they are on", async () => {
    const page = await manager.getPage(browserName, "states");
    await page.setContent(STATE_PAGE_HTML);

    const { result } = await getPageElementsCDP(page);
    const lineFor = (name: string): string => {
      const line = result.serialized.split("\n").find((entry) => entry.includes(`"${name}"`));
      expect(line, `no discover line for ${name}:\n${result.serialized}`).toBeDefined();
      return line!;
    };

    expect(lineFor("Checked box")).toContain("[checked]");
    expect(lineFor("Unchecked box")).not.toContain("checked]");
    expect(lineFor("Mixed box")).toContain("[checked=mixed]");
    expect(lineFor("Small")).not.toContain("checked]");
    expect(lineFor("Large")).toContain("[checked]");
    expect(lineFor("ARIA unchecked")).not.toContain("checked]");
    expect(lineFor("Bold")).toContain("[pressed]");
    expect(lineFor("Italic")).not.toContain("pressed");
    expect(lineFor("Underline")).toContain("[pressed=mixed]");
  }, 120_000);
});
