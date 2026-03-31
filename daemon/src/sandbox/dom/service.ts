/**
 * CDP-based interactive element detection service.
 *
 * Main orchestrator that:
 *   1. Fetches AX tree, DOMSnapshot, and JS listeners in parallel via CDP
 *   2. Merges all three data sources into unified DOMElement nodes
 *   3. Filters by visibility + interactivity using Chrome's computed data
 *   4. Applies paint order occlusion filtering
 *   5. Serializes for LLM consumption
 *
 * CDP-based interactive element detection using AX tree + DOMSnapshot + JS listener fusion.
 */

import type { Page } from "patchright";
import type {
  CDPSession,
  PageElement,
  DiscoveryResult,
  DOMElement,
  ScrollRegion,
} from "./types.js";
import { getAccessibilityNodes } from "./accessibility.js";
import { getLayoutSnapshot } from "./snapshot.js";
import { getEventListeners } from "./listeners.js";
import { findHiddenByOverlap } from "./overlap-filter.js";
import { pickSelector, generateXPaths } from "./selectors.js";
import { trimText, summarizePage, getElementHint, formatElement } from "./serialize.js";
import { setupDialogHandler } from "./dialog-handler.js";
import { setupShadowAccess } from "./shadow-access.js";

// ---------------------------------------------------------------------------
// CDP session helper
// ---------------------------------------------------------------------------

async function withCDPSession<T>(
  page: Page,
  fn: (session: CDPSession) => Promise<T>
): Promise<T> {
  // Patchright's newCDPSession returns an untyped CDP session
  const session = (await page.context().newCDPSession(page)) as unknown as CDPSession;
  try {
    return await fn(session);
  } finally {
    await session.detach().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// DOM tree walk + merge
// ---------------------------------------------------------------------------

/** Tags that are never interactive content */
const SKIP_TAGS = new Set([
  "html", "body", "head", "script", "style", "noscript", "meta", "link",
  "br", "hr", "wbr", "title",
  // SVG children are decorative
  "svg", "path", "circle", "rect", "line", "polygon", "polyline",
  "ellipse", "g", "defs", "clippath", "mask", "use", "symbol",
  // Media elements
  "img", "picture", "source", "track",
  // NOTE: <canvas> is NOT skipped — we show it as a hint to the LLM
  // that content is rendered visually and needs keyboard/coordinate interaction
]);

/** ARIA roles that indicate an interactive widget */
const ACTIONABLE_ROLES = new Set([
  "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "radio", "checkbox", "tab", "textbox", "combobox",
  "slider", "spinbutton", "switch", "searchbox", "treeitem",
  "listbox", "menu", "menubar", "tablist",
]);

/** AX properties whose presence implies interactive */
const ACTIONABLE_AX_PROPS = new Set([
  "focusable", "editable", "settable",
  "checked", "expanded", "pressed", "selected",
  "required", "autocomplete",
]);

/** Noise roles to filter out for generic elements */
const INERT_ROLES = new Set(["generic", "none", "presentation", ""]);

/** Generic container tags that need name/role to be shown */
const STRUCTURAL_TAGS = new Set([
  "div", "span", "td", "tr", "li", "nav", "section", "article",
  "header", "footer", "main", "aside", "form",
]);

function isActionable(el: DOMElement): boolean {
  if (SKIP_TAGS.has(el.tag)) return false;

  // AX disabled/hidden → not interactive
  for (const prop of el.axProperties) {
    if (prop.name === "disabled" && prop.value === true) return false;
    if (prop.name === "hidden" && prop.value === true) return false;
  }

  // Chrome says clickable (from DOMSnapshot.isClickable)
  if (el.isClickable) return true;

  // Has JS event listeners (from CDP Runtime)
  if (el.hasJSListener) return true;

  // AX role is interactive widget (Chrome computed)
  if (el.role && ACTIONABLE_ROLES.has(el.role)) return true;

  // AX properties indicate interactivity
  for (const prop of el.axProperties) {
    if (ACTIONABLE_AX_PROPS.has(prop.name) && prop.value) return true;
  }

  // Native interactive tags (fallback for poor accessibility)
  const nativeTags = new Set(["a", "button", "input", "select", "textarea", "details", "summary"]);
  if (nativeTags.has(el.tag)) {
    if (el.tag === "input" && el.attributes["type"] === "hidden") return false;
    return true;
  }

  // Content editable
  if (el.attributes["contenteditable"] === "true" || el.attributes["contenteditable"] === "") return true;

  // Inline handlers
  if ("onclick" in el.attributes || "onmousedown" in el.attributes || "onpointerdown" in el.attributes) return true;

  // tabindex
  if ("tabindex" in el.attributes && el.attributes["tabindex"] !== "-1") return true;

  // Cursor pointer (final fallback)
  if (el.cursorStyle === "pointer") return true;

  return false;
}

/**
 * Walk the DOM tree (from CDP DOM.getDocument) and merge with AX + Snapshot data.
 */
function buildElementTree(
  root: Record<string, unknown>,
  axLookup: Map<number, { role: string; name: string; description: string; properties: Array<{ name: string; value: unknown }> }>,
  snapLookup: Map<number, import("./types.js").LayoutNode>,
  jsListeners: Set<number>
): DOMElement[] {
  const elements: DOMElement[] = [];

  function walk(node: Record<string, unknown>): void {
    const nodeType = node.nodeType as number;
    if (nodeType !== 1) {
      // Still recurse children/shadow/content
      const children = node.children as Record<string, unknown>[] | undefined;
      if (children) for (const c of children) walk(c);
      const contentDoc = node.contentDocument as Record<string, unknown> | undefined;
      if (contentDoc) walk(contentDoc);
      const shadows = node.shadowRoots as Record<string, unknown>[] | undefined;
      if (shadows) for (const s of shadows) walk(s);
      return;
    }

    const bid = node.backendNodeId as number;
    const tag = ((node.nodeName as string) ?? "").toLowerCase();

    // Parse flat attribute array
    const attrs: Record<string, string> = {};
    const rawAttrs = node.attributes as string[] | undefined;
    if (rawAttrs) {
      for (let i = 0; i < rawAttrs.length; i += 2) {
        const k = rawAttrs[i];
        if (k) attrs[k] = rawAttrs[i + 1] ?? "";
      }
    }

    // Merge AX data
    const ax = axLookup.get(bid);

    // Merge snapshot data
    const snap = snapLookup.get(bid);

    // Visibility from computed styles
    let isVisible = true;
    if (snap?.computedStyles) {
      const cs = snap.computedStyles;
      if (cs["display"] === "none") isVisible = false;
      if (cs["visibility"] === "hidden") isVisible = false;
      const op = parseFloat(cs["opacity"] ?? "1");
      if (op <= 0 || !isFinite(op)) isVisible = false;
    }
    if (snap?.bounds && (snap.bounds.width <= 0 || snap.bounds.height <= 0)) isVisible = false;
    if (!snap?.bounds) isVisible = false;

    elements.push({
      backendNodeId: bid,
      tag,
      attributes: attrs,
      role: ax?.role ?? "",
      name: ax?.name ?? "",
      description: ax?.description ?? "",
      axProperties: ax?.properties ?? [],
      isClickable: snap?.isClickable ?? false,
      hasJSListener: jsListeners.has(bid),
      isVisible,
      cursorStyle: snap?.cursorStyle ?? null,
      bounds: snap?.bounds ?? null,
      paintOrder: snap?.paintOrder ?? null,
      backgroundColor: snap?.backgroundColor ?? null,
      computedStyles: snap?.computedStyles ?? null,
    });

    // Recurse
    const children = node.children as Record<string, unknown>[] | undefined;
    if (children) for (const c of children) walk(c);
    const contentDoc = node.contentDocument as Record<string, unknown> | undefined;
    if (contentDoc) walk(contentDoc);
    const shadows = node.shadowRoots as Record<string, unknown>[] | undefined;
    if (shadows) for (const s of shadows) walk(s);
  }

  walk(root);
  return elements;
}

// ---------------------------------------------------------------------------
// Select options (browser-side)
// ---------------------------------------------------------------------------

async function fetchSelectOptions(
  session: CDPSession,
  backendNodeIds: number[]
): Promise<Map<number, { total: number; preview: string[]; remaining: number }>> {
  const map = new Map<number, { total: number; preview: string[]; remaining: number }>();
  for (const bid of backendNodeIds) {
    try {
      const { object } = (await session.send("DOM.resolveNode", { backendNodeId: bid })) as {
        object?: { objectId?: string };
      };
      if (!object?.objectId) continue;
      const res = (await session.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: `function() {
          if (this.tagName.toLowerCase() !== 'select') return null;
          var o = this.options, t = o.length, p = [], l = Math.min(t, 5);
          for (var i = 0; i < l; i++) p.push(o[i].text.trim() || o[i].value);
          return { total: t, preview: p, remaining: t - l };
        }`,
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      if (res?.result?.value) map.set(bid, res.result.value as { total: number; preview: string[]; remaining: number });
      await session.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
    } catch { /* skip */ }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Scroll info (browser-side)
// ---------------------------------------------------------------------------

async function fetchScrollInfo(page: Page): Promise<ScrollRegion[]> {
  try {
    return (await page.evaluate(`
      (() => {
        const r = [];
        for (const el of document.querySelectorAll('*')) {
          const s = window.getComputedStyle(el);
          const ov = s.overflowY || s.overflow;
          if (ov !== 'scroll' && ov !== 'auto') continue;
          const h = el.scrollHeight - el.clientHeight;
          if (h <= 10) continue;
          let sel = el.tagName.toLowerCase();
          if (el.id) sel = '#' + el.id;
          else if (el.className && typeof el.className === 'string') {
            const c = el.className.trim().split(/\\s+/)[0];
            if (c) sel += '.' + c;
          }
          r.push({ selector: sel, hiddenPixels: h, hiddenPages: parseFloat((h / el.clientHeight).toFixed(1)) });
        }
        return r;
      })()
    `)) as ScrollRegion[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface GetPageElementsOptions {
  maxElements?: number;
  maxTextLength?: number;
  includePaintOrder?: boolean;
}

export async function getPageElementsCDP(
  page: Page,
  options?: GetPageElementsOptions,
  previousSelectors?: Set<string>
): Promise<{ result: DiscoveryResult; currentSelectors: Set<string> }> {
  const maxElements = options?.maxElements ?? 200;
  const maxTextLength = options?.maxTextLength ?? 100;
  const includePaintOrder = options?.includePaintOrder !== false;

  return await withCDPSession(page, async (session) => {
    await session.send("DOM.enable").catch(() => {});

    // Install popup handler to prevent dialog hangs
    const popup = await setupDialogHandler(session).catch(() => null);

    // Install shadow DOM piercer for closed root access
    await setupShadowAccess(session).catch(() => {});

    // --- Parallel CDP calls ---
    const [axLookup, snapLookup, jsListeners] = await Promise.all([
      getAccessibilityNodes(session),
      getLayoutSnapshot(session),
      getEventListeners(session),
    ]);

    // --- Walk DOM tree + merge all data sources ---
    const domTree = (await session.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    })) as { root: Record<string, unknown> };

    const allElements = buildElementTree(domTree.root, axLookup, snapLookup, jsListeners);

    // --- Paint order occlusion ---
    const occluded = includePaintOrder ? findHiddenByOverlap(allElements) : new Set<number>();

    // --- Filter: visible + interactive + minimal noise removal ---
    // The LLM decides what matters. We only skip elements that are:
    //   1. Not visible or occluded
    //   2. Not interactive (per Chrome's AX tree + isClickable + JS listeners)
    //   3. Readonly cells (can't be acted on)
    //   4. Nameless generic containers with no role and no ID (universally useless)
    const interactive: DOMElement[] = [];
    for (const el of allElements) {
      if (!el.isVisible) continue;
      if (occluded.has(el.backendNodeId)) continue;

      // Canvas elements: always include large ones as a hint to the LLM
      // "content here is visual, use keyboard/clickAt"
      if (el.tag === "canvas" && el.bounds && el.bounds.width > 200 && el.bounds.height > 200) {
        interactive.push(el);
        continue;
      }

      if (!isActionable(el)) continue;

      // Skip readonly elements that have no other interactive signal
      const isReadonly = el.axProperties.some(p => p.name === "readonly" && p.value === true);
      if (isReadonly && !el.isClickable && !el.hasJSListener) continue;

      // Skip nameless generic containers — universally useless to an LLM
      if (STRUCTURAL_TAGS.has(el.tag) && !el.name && INERT_ROLES.has(el.role) && !el.attributes["id"]) continue;

      interactive.push(el);
      if (interactive.length >= maxElements) break;
    }

    // --- Generate selectors + XPaths in parallel ---
    const bids = interactive.map((e) => e.backendNodeId);
    const selectBids = interactive.filter((e) => e.tag === "select").map((e) => e.backendNodeId);

    const [xpaths, selectOpts] = await Promise.all([
      generateXPaths(session, bids),
      fetchSelectOptions(session, selectBids),
    ]);

    // --- Build output ---
    const elements: PageElement[] = [];
    const lines: string[] = [];
    const currentSelectors = new Set<string>();

    for (const [i, el] of interactive.entries()) {
      const index = i + 1;
      const xpath = xpaths.get(el.backendNodeId) ?? "";
      const selector = pickSelector(el, xpath || undefined);
      const isNew = previousSelectors ? !previousSelectors.has(selector) : false;
      const compoundHint = getElementHint(el);

      // Select options hint
      let selectHint: string | null = null;
      const so = selectOpts.get(el.backendNodeId);
      if (so) {
        let optStr = so.preview.join(", ");
        if (so.remaining > 0) optStr += `, ... ${so.remaining} more`;
        selectHint = `(${so.total} options: ${optStr})`;
      }

      const ie: PageElement = {
        index,
        backendNodeId: el.backendNodeId,
        tag: el.tag,
        role: el.role,
        name: trimText(el.name, maxTextLength),
        selector,
        xpath,
        attributes: el.attributes,
        axProperties: el.axProperties,
        bounds: el.bounds,
      };

      elements.push(ie);
      currentSelectors.add(selector);
      lines.push(formatElement(ie, el.axProperties, compoundHint, selectHint, isNew));
    }

    // --- Scroll areas ---
    const scrollAreas = (await fetchScrollInfo(page)).filter((s) => s.hiddenPages > 0.3);
    if (scrollAreas.length > 0) {
      lines.push("");
      lines.push("--- Scrollable areas ---");
      for (const s of scrollAreas) {
        lines.push(`  ${s.selector} (~${s.hiddenPages} pages hidden below)`);
      }
    }

    // --- Viewport ---
    let viewport = { width: 0, height: 0, scrollX: 0, scrollY: 0 };
    try {
      viewport = (await page.evaluate(`({
        width: window.innerWidth, height: window.innerHeight,
        scrollX: window.scrollX, scrollY: window.scrollY
      })`)) as typeof viewport;
    } catch { /* */ }

    // Detect large canvas elements (visual content areas)
    // These don't show up reliably through the CDP pipeline but are
    // critical for the LLM to know about
    try {
      const canvasInfo = (await page.evaluate(`
        (() => {
          const results = [];
          for (const c of document.querySelectorAll('canvas')) {
            const r = c.getBoundingClientRect();
            if (r.width > 200 && r.height > 200) {
              results.push({ width: Math.round(r.width), height: Math.round(r.height) });
            }
          }
          return results;
        })()
      `)) as Array<{ width: number; height: number }>;

      if (canvasInfo.length > 0) {
        for (const c of canvasInfo) {
          lines.push(`[canvas] visual content area (${c.width}x${c.height}) — use keyboard or clickAt(x,y) for content`);
        }
      }
    } catch { /* non-critical */ }

    // Page summary at the top (helps LLM understand structure)
    const summary = summarizePage(
      elements.map(e => ({ role: e.role, name: e.name, tag: e.tag, bounds: e.bounds })),
      viewport
    );
    lines.unshift(summary);
    lines.splice(1, 0, ""); // blank line after summary

    // Include dismissed dialogs in result if any appeared
    const dismissed = popup?.getDismissed() ?? [];
    if (dismissed.length > 0) {
      lines.push("");
      lines.push("--- Dismissed dialogs ---");
      for (const d of dismissed) {
        lines.push(`  ${d.type}: ${d.message.substring(0, 100)}`);
      }
    }

    // Cleanup popup handler
    popup?.dispose();

    return {
      result: {
        count: elements.length,
        serialized: lines.join("\n"),
        elements,
        scrollableAreas: scrollAreas,
        viewport,
      },
      currentSelectors,
    };
  });
}
