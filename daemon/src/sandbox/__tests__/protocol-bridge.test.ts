import type { Browser, Page } from "patchright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProtocolBridge, type ProtocolBridge } from "../protocol-bridge.js";
import type { PlaywrightClientLike } from "../playwright-internals.js";
import {
  LOCAL_TEST_PAGE_TITLE,
  startLocalTestSite,
  type LocalTestSite,
} from "./local-test-site.js";

describe("protocol bridge", () => {
  let bridge: ProtocolBridge;
  let playwright: PlaywrightClientLike;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let site: LocalTestSite;

  beforeAll(async () => {
    site = await startLocalTestSite();
    bridge = createProtocolBridge();
    playwright = await bridge.initializePlaywright();
  }, 60_000);

  afterAll(async () => {
    if (page && !page.isClosed()) {
      await page.close();
    }

    if (browser?.isConnected()) {
      await browser.close();
    }

    await bridge.dispose("test teardown");
    await site?.close();
  }, 60_000);

  it("initializes Playwright through the bridge", () => {
    expect(playwright.chromium).toBeDefined();
  });

  it("launches a Chromium-based browser and executes core page operations", async () => {
    browser = await playwright.chromium.launch({ headless: true });
    page = await browser.newPage();

    await page.goto(site.url);

    await expect(page.title()).resolves.toBe(LOCAL_TEST_PAGE_TITLE);
    await expect(page.locator("h1").textContent()).resolves.toBe(LOCAL_TEST_PAGE_TITLE);
    await expect(page.evaluate(() => document.title)).resolves.toBe(LOCAL_TEST_PAGE_TITLE);
  }, 120_000);

  it("cleans up page, browser, and bridge connection", async () => {
    const activePage = page;
    const activeBrowser = browser;

    expect(activePage).toBeDefined();
    expect(activeBrowser).toBeDefined();

    await activePage?.close();
    expect(activePage?.isClosed()).toBe(true);

    await activeBrowser?.close();
    expect(activeBrowser?.isConnected()).toBe(false);

    await bridge.dispose("test cleanup");
  }, 60_000);
});
