/**
 * CDP-based element actions — click, fill, type via Chrome DevTools Protocol.
 *
 * These bypass ALL JavaScript layers (React, Vue, Angular, Playwright) by
 * operating at the browser's input layer:
 *   - Click: Input.dispatchMouseEvent (real mouse events)
 *   - Type: Input.dispatchKeyEvent (real keyboard events)
 *   - Scroll: DOM.scrollIntoViewIfNeeded (browser-native scroll)
 *
 * CDP-based element actions using Input.dispatchMouseEvent/KeyEvent.
 * Uses backendNodeId for element resolution — no CSS selectors needed.
 */

import type { CDPSession } from "./types.js";

// ---------------------------------------------------------------------------
// Element geometry resolution
// Three methods: ContentQuads → BoxModel → JS getBoundingClientRect
// ---------------------------------------------------------------------------

interface Point {
  x: number;
  y: number;
}

async function getElementCenter(
  session: CDPSession,
  backendNodeId: number
): Promise<Point | null> {
  // Method 1: DOM.getContentQuads (best for inline elements)
  try {
    const quadsResult = (await session.send("DOM.getContentQuads", {
      backendNodeId,
    })) as { quads?: number[][] };
    if (quadsResult.quads && quadsResult.quads.length > 0) {
      const q = quadsResult.quads[0]!;
      if (q.length >= 8) {
        const cx = (q[0]! + q[2]! + q[4]! + q[6]!) / 4;
        const cy = (q[1]! + q[3]! + q[5]! + q[7]!) / 4;
        return { x: cx, y: cy };
      }
    }
  } catch { /* try next method */ }

  // Method 2: DOM.getBoxModel
  try {
    const boxResult = (await session.send("DOM.getBoxModel", {
      backendNodeId,
    })) as { model?: { content?: number[] } };
    const content = boxResult.model?.content;
    if (content && content.length >= 8) {
      const cx = (content[0]! + content[2]! + content[4]! + content[6]!) / 4;
      const cy = (content[1]! + content[3]! + content[5]! + content[7]!) / 4;
      return { x: cx, y: cy };
    }
  } catch { /* try next method */ }

  // Method 3: JS getBoundingClientRect via CDP
  try {
    const { object } = (await session.send("DOM.resolveNode", {
      backendNodeId,
    })) as { object?: { objectId?: string } };
    if (!object?.objectId) return null;

    const boundsResult = (await session.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function() {
        var r = this.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }`,
      returnByValue: true,
    })) as { result?: { value?: Point } };

    await session.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});

    return boundsResult.result?.value ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scroll into view via CDP
// ---------------------------------------------------------------------------

async function scrollIntoView(
  session: CDPSession,
  backendNodeId: number
): Promise<void> {
  try {
    await session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    // Brief pause for scroll to complete
    await new Promise((r) => setTimeout(r, 50));
  } catch {
    // Not critical
  }
}

// ---------------------------------------------------------------------------
// CDP Click
// Uses Input.dispatchMouseEvent for real mouse events
// ---------------------------------------------------------------------------

export interface CDPClickResult {
  success: boolean;
  method: "cdp-mouse" | "cdp-js-click" | "failed";
  error?: string;
}

/**
 * Randomized dwell time between mousedown and mouseup.
 * From anti-detection research: humans dwell 40-120ms with variation.
 * Fixed dwell times are a detection signal.
 */
function randomDwell(): number {
  return 40 + Math.floor(Math.random() * 80);
}

export async function cdpClick(
  session: CDPSession,
  backendNodeId: number,
  options?: { button?: "left" | "right" | "middle" }
): Promise<CDPClickResult> {
  const button = options?.button ?? "left";

  try {
    // Scroll element into view first
    await scrollIntoView(session, backendNodeId);

    // Get click coordinates
    const center = await getElementCenter(session, backendNodeId);

    if (center) {
      try {
        // Step 1: Move mouse to element
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: center.x,
          y: center.y,
        });

        // Step 2: Randomized dwell between move and click (anti-detection)
        await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 30)));

        // Step 3: mousePressed
        await session.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: center.x,
          y: center.y,
          button,
          clickCount: 1,
        });

        // Step 4: Randomized dwell time (40-120ms, from anti-detection research)
        await new Promise((r) => setTimeout(r, randomDwell()));

        // Step 5: mouseReleased
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: center.x,
          y: center.y,
          button,
          clickCount: 1,
        });

        return { success: true, method: "cdp-mouse" };
      } catch {
        // Fall through to JS click
      }
    }

    // Fallback: JS click via CDP Runtime.callFunctionOn
    let objectId: string | undefined;
    try {
      const { object } = (await session.send("DOM.resolveNode", {
        backendNodeId,
      })) as { object?: { objectId?: string } };
      objectId = object?.objectId;

      if (!objectId) {
        return { success: false, method: "failed", error: "Could not resolve element" };
      }

      await session.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function() { this.click(); }",
      });

      return { success: true, method: "cdp-js-click" };
    } finally {
      // Always release objectId (prevents memory leaks)
      if (objectId) {
        await session.send("Runtime.releaseObject", { objectId }).catch(() => {});
      }
    }
  } catch (e) {
    return {
      success: false,
      method: "failed",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// CDP Focus
// ---------------------------------------------------------------------------

async function cdpFocus(
  session: CDPSession,
  backendNodeId: number
): Promise<void> {
  // Method 1: DOM.focus
  try {
    await session.send("DOM.focus", { backendNodeId });
    return;
  } catch { /* try fallback */ }

  // Method 2: JS focus via CDP
  try {
    const { object } = (await session.send("DOM.resolveNode", {
      backendNodeId,
    })) as { object?: { objectId?: string } };
    if (object?.objectId) {
      await session.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: "function() { this.focus(); }",
      });
      await session.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// CDP Type
// Uses Input.dispatchKeyEvent for real keyboard events
// ---------------------------------------------------------------------------

export interface CDPTypeResult {
  success: boolean;
  method: "cdp-keys" | "cdp-insert" | "failed";
  error?: string;
}

/**
 * Type text into an element using CDP keyboard events.
 *
 * Sends keyDown → char → keyUp for each character.
 * This works with React controlled inputs, Canvas apps, Google Sheets — anything.
 */
/**
 * Randomized inter-keystroke delay.
 * From anti-detection research: humans type at 50-200ms per char with
 * Gaussian distribution. Fixed delays are a detection signal.
 */
function randomKeystrokeDelay(baseDelay: number): number {
  if (baseDelay <= 0) return 0;
  // Gaussian-like distribution: base ± 30%
  const jitter = baseDelay * 0.3;
  return Math.max(1, baseDelay + (Math.random() - 0.5) * 2 * jitter);
}

export async function cdpType(
  session: CDPSession,
  backendNodeId: number,
  text: string,
  options?: { clearFirst?: boolean; delay?: number }
): Promise<CDPTypeResult> {
  const clearFirst = options?.clearFirst ?? false;
  const delay = options?.delay ?? 5; // 5ms base → randomized to ~3-7ms

  try {
    await scrollIntoView(session, backendNodeId);
    await cdpFocus(session, backendNodeId);

    // Clear existing text if requested — uses native value setter to work with React/Vue controlled inputs
    if (clearFirst) {
      const resolved = await session.send("DOM.resolveNode", { backendNodeId }) as { object: { objectId: string } };
      await session.send("Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: `function() {
          const proto = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) {
            setter.call(this, '');
          } else {
            this.value = '';
          }
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
      });
      await new Promise((r) => setTimeout(r, 20));
    }

    // Type character by character
    for (const char of text) {
      if (char === "\n") {
        await session.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
        await new Promise((r) => setTimeout(r, delay));
        await session.send("Input.dispatchKeyEvent", {
          type: "char",
          text: "\r",
          key: "Enter",
        });
        await session.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
      } else if (char === "\t") {
        await session.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
        });
        await session.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
        });
      } else {
        // Regular character: keyDown (NO text) → char (WITH text) → keyUp
        // keyDown must NOT include text, char must include text
        await session.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: char,
        });
        await new Promise((r) => setTimeout(r, delay));
        await session.send("Input.dispatchKeyEvent", {
          type: "char",
          text: char,
          key: char,
        });
        await session.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: char,
        });
      }

      if (delay > 0) {
        await new Promise((r) => setTimeout(r, randomKeystrokeDelay(delay)));
      }
    }

    return { success: true, method: "cdp-keys" };
  } catch (e) {
    // Fallback: try insertText (simpler but less compatible)
    try {
      await cdpFocus(session, backendNodeId);
      await session.send("Input.insertText", { text });
      return { success: true, method: "cdp-insert" };
    } catch {
      return {
        success: false,
        method: "failed",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// CDP Scroll
// ---------------------------------------------------------------------------

// cdpScrollIntoView removed — scrollIntoView() (line 82) is the internal helper
// used by cdpClick/cdpType. No external API needed.

// ---------------------------------------------------------------------------
// CDP Click At Coordinates (for canvas/WebGL apps)
// Uses Input.dispatchMouseEvent at absolute viewport coordinates.
// The LLM determines coordinates from screenshots or known layouts.
// ---------------------------------------------------------------------------

export interface CDPClickAtResult {
  success: boolean;
  x: number;
  y: number;
  error?: string;
}

/**
 * Click at specific viewport coordinates. For canvas apps where there are
 * no DOM elements to target — the LLM determines coordinates from screenshots.
 *
 * Coordinates are CSS pixels relative to the viewport top-left (0,0).
 */
export async function cdpClickAt(
  session: CDPSession,
  x: number,
  y: number,
  options?: { button?: "left" | "right" | "middle"; doubleClick?: boolean }
): Promise<CDPClickAtResult> {
  const button = options?.button ?? "left";
  const clickCount = options?.doubleClick ? 2 : 1;

  try {
    // Move mouse to position
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 30)));

    // Press
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      clickCount,
    });
    await new Promise((r) => setTimeout(r, randomDwell()));

    // Release
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      clickCount,
    });

    return { success: true, x, y };
  } catch (e) {
    return {
      success: false,
      x,
      y,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// CDP Drag (for canvas drawing, slider dragging, etc.)
// ---------------------------------------------------------------------------

export async function cdpDrag(
  session: CDPSession,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  options?: { steps?: number }
): Promise<{ success: boolean; error?: string }> {
  const steps = options?.steps ?? 10;

  try {
    // Move to start
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: fromX,
      y: fromY,
    });
    await new Promise((r) => setTimeout(r, 30));

    // Press at start
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: fromX,
      y: fromY,
      button: "left",
      clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 50));

    // Move in steps (smooth drag)
    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      const cx = fromX + (toX - fromX) * progress;
      const cy = fromY + (toY - fromY) * progress;
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(cx),
        y: Math.round(cy),
      });
      await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 10)));
    }

    // Release at end
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: toX,
      y: toY,
      button: "left",
      clickCount: 1,
    });

    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
