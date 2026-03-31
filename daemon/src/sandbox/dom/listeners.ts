/**
 * JavaScript event listener detection via CDP.
 *
 * Detection pattern:
 *   1. Runtime.evaluate with includeCommandLineAPI to access getEventListeners()
 *   2. Get array of element references
 *   3. Batch-resolve to backendNodeIds via DOM.describeNode
 *
 * This catches React onClick, Vue @click, Angular (click), and all other
 * framework-attached event handlers that have no HTML attribute indicators.
 */

import type { CDPSession } from "./types.js";

/**
 * Detect all elements with click/pointer event listeners via CDP.
 * Returns a set of backendNodeIds that have JS click handlers.
 */
export async function getEventListeners(
  session: CDPSession
): Promise<Set<number>> {
  const listeners = new Set<number>();

  try {
    // Step 1: Find elements with click-related listeners
    const evalResult = (await session.send("Runtime.evaluate", {
      expression: `
        (() => {
          if (typeof getEventListeners !== 'function') return null;
          const found = [];
          const all = document.querySelectorAll('*');
          for (let i = 0; i < all.length; i++) {
            try {
              const l = getEventListeners(all[i]);
              if (l.click || l.mousedown || l.pointerdown ||
                  l.mouseup || l.pointerup) {
                found.push(all[i]);
              }
            } catch(e) {}
          }
          return found;
        })()
      `,
      includeCommandLineAPI: true,
      returnByValue: false,
    })) as {
      result?: { objectId?: string; type?: string; subtype?: string };
    };

    const objectId = evalResult?.result?.objectId;
    if (!objectId) return listeners;

    // Step 2: Get array properties
    const props = (await session.send("Runtime.getProperties", {
      objectId,
      ownProperties: true,
    })) as {
      result?: Array<{
        name: string;
        value?: { objectId?: string };
      }>;
    };

    // Step 3: Batch-resolve each element to its backendNodeId
    const resolvePromises: Promise<number | null>[] = [];
    for (const prop of props.result ?? []) {
      if (typeof prop.name === "string" && /^\d+$/.test(prop.name)) {
        const elObjectId = prop.value?.objectId;
        if (elObjectId) {
          resolvePromises.push(
            (session.send("DOM.describeNode", { objectId: elObjectId }) as Promise<{
              node?: { backendNodeId?: number };
            }>)
              .then((info) => info?.node?.backendNodeId ?? null)
              .catch(() => null)
          );
        }
      }
    }

    const results = await Promise.all(resolvePromises);
    for (const bid of results) {
      if (bid !== null) listeners.add(bid);
    }
  } catch {
    // getEventListeners may not be available (e.g., non-Chrome browsers)
    // Non-critical — other detection methods still work
  }

  return listeners;
}
