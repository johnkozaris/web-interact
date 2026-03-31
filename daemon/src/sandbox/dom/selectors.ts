/**
 * Selector generation for discovered elements.
 *
 * Generates both CSS selectors (from HTML attributes) and XPaths (via CDP).
 * CSS selectors are preferred when unique; XPath is the fallback.
 *
 * XPath generation uses CDP DOM.resolveNode + Runtime.callFunctionOn,
 * adapted from CDP patterns.
 */

import type { CDPSession, DOMElement } from "./types.js";

// ---------------------------------------------------------------------------
// CSS selector generation (from HTML attributes)
// ---------------------------------------------------------------------------

/**
 * Generate the best available CSS selector for an element.
 * Prefers: data-testid > id > aria-label > name > placeholder > xpath fallback
 */
export function generateCSSSelector(el: DOMElement): string | null {
  const tag = el.tag;

  if (el.attributes["data-testid"]) {
    return `[data-testid=${JSON.stringify(el.attributes["data-testid"])}]`;
  }

  const id = el.attributes["id"];
  if (id && /^[a-zA-Z][\w-]*$/.test(id)) {
    return `#${id}`;
  }

  if (el.attributes["aria-label"]) {
    return `${tag}[aria-label=${JSON.stringify(el.attributes["aria-label"])}]`;
  }

  if (el.attributes["name"]) {
    return `${tag}[name=${JSON.stringify(el.attributes["name"])}]`;
  }

  if (tag === "input" && el.attributes["placeholder"]) {
    return `input[placeholder=${JSON.stringify(el.attributes["placeholder"])}]`;
  }

  if (tag === "input" && el.attributes["type"]) {
    return `input[type=${JSON.stringify(el.attributes["type"])}]`;
  }

  // No unique CSS selector available
  return null;
}

// ---------------------------------------------------------------------------
// XPath generation via CDP (
// ---------------------------------------------------------------------------

const XPATH_FUNCTION = `function() {
  let el = this;
  const parts = [];
  while (el && el.nodeType === 1) {
    let tag = el.tagName.toLowerCase();
    let parent = el.parentNode;
    if (!parent) { parts.unshift("/" + tag); break; }
    let idx = 1;
    let sib = el.previousSibling;
    while (sib) {
      if (sib.nodeType === 1 && sib.tagName && sib.tagName.toLowerCase() === tag) idx++;
      sib = sib.previousSibling;
    }
    let hasMultiple = false;
    let next = el.nextSibling;
    while (next) {
      if (next.nodeType === 1 && next.tagName && next.tagName.toLowerCase() === tag) {
        hasMultiple = true; break;
      }
      next = next.nextSibling;
    }
    parts.unshift("/" + tag + ((hasMultiple || idx > 1) ? "[" + idx + "]" : ""));
    el = parent;
    if (el.nodeType === 9 || el.nodeType === 11) break;
  }
  return parts.join("");
}`;

/**
 * Batch-generate XPaths for a list of backendNodeIds via CDP.
 * Uses DOM.resolveNode → Runtime.callFunctionOn pattern .
 */
export async function generateXPaths(
  session: CDPSession,
  backendNodeIds: number[]
): Promise<Map<number, string>> {
  const xpaths = new Map<number, string>();

  // Process in batches to avoid overwhelming the CDP session
  const BATCH = 50;
  for (let i = 0; i < backendNodeIds.length; i += BATCH) {
    const batch = backendNodeIds.slice(i, i + BATCH);
    const promises = batch.map(async (bid) => {
      try {
        const { object } = (await session.send("DOM.resolveNode", {
          backendNodeId: bid,
        })) as { object?: { objectId?: string } };
        if (!object?.objectId) return;

        const result = (await session.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: XPATH_FUNCTION,
          returnByValue: true,
        })) as { result?: { value?: string } };

        if (result?.result?.value) {
          xpaths.set(bid, result.result.value);
        }

        // Release to prevent memory leaks
        await session
          .send("Runtime.releaseObject", { objectId: object.objectId })
          .catch(() => {});
      } catch {
        // Element may have been removed from DOM
      }
    });
    await Promise.all(promises);
  }

  return xpaths;
}

/**
 * Generate the best selector for an element — CSS if unique, XPath as fallback.
 * Returns a string that can be used with document.querySelector (CSS) or
 * document.evaluate (xpath= prefix).
 */
export function pickSelector(
  el: DOMElement,
  xpath: string | undefined
): string {
  const css = generateCSSSelector(el);
  if (css) return css;
  if (xpath) return `xpath=${xpath}`;
  return el.tag;
}
