/**
 * DOMSnapshot parsing — extracts visibility, clickability, bounds, paint order.
 *
 * CDP-based implementation.py + build_snapshot_lookup().
 * Parses Chrome's DOMSnapshot.captureSnapshot response into a lookup table
 * keyed by backendNodeId.
 */

import type { CDPSession, DOMRect, LayoutNode } from "./types.js";
import { REQUIRED_COMPUTED_STYLES } from "./types.js";

/**
 * Fetch DOMSnapshot via CDP and build a lookup table.
 *
 * 
 *   - Parses isClickable from rare boolean data
 *   - Converts device pixels → CSS pixels using device pixel ratio
 *   - Extracts computed styles, paint order, cursor style
 */
export async function getLayoutSnapshot(
  session: CDPSession
): Promise<Map<number, LayoutNode>> {
  const snapshot = (await session.send("DOMSnapshot.captureSnapshot", {
    computedStyles: [...REQUIRED_COMPUTED_STYLES],
    includePaintOrder: true,
    includeDOMRects: true,
  })) as {
    documents: Array<{
      nodes: {
        backendNodeId?: number[];
        isClickable?: { index: number[] };
      };
      layout: {
        nodeIndex?: number[];
        bounds?: number[][];
        styles?: number[][];
        paintOrders?: number[];
      };
    }>;
    strings: string[];
  };

  const lookup = new Map<number, LayoutNode>();
  if (!snapshot.documents || snapshot.documents.length === 0) return lookup;

  const strings = snapshot.strings;

  // Get device pixel ratio for coordinate conversion
  let dpr = 1;
  try {
    const metrics = (await session.send("Page.getLayoutMetrics")) as {
      visualViewport?: { clientWidth?: number };
      cssVisualViewport?: { clientWidth?: number };
    };
    const devW = metrics.visualViewport?.clientWidth ?? 0;
    const cssW = metrics.cssVisualViewport?.clientWidth ?? devW;
    if (cssW > 0 && devW > 0) dpr = devW / cssW;
  } catch {
    /* default 1 */
  }

  for (const doc of snapshot.documents) {
    const nodes = doc.nodes;
    const layout = doc.layout;

    // backendNodeId → snapshot index
    const beToIdx = new Map<number, number>();
    if (nodes.backendNodeId) {
      for (let i = 0; i < nodes.backendNodeId.length; i++) {
        beToIdx.set(nodes.backendNodeId[i]!, i);
      }
    }

    // snapshot index → layout index (first occurrence wins, )
    const layoutMap = new Map<number, number>();
    if (layout.nodeIndex) {
      for (let li = 0; li < layout.nodeIndex.length; li++) {
        const ni = layout.nodeIndex[li]!;
        if (!layoutMap.has(ni)) layoutMap.set(ni, li);
      }
    }

    // isClickable rare boolean indices
    const clickableIndices = new Set(nodes.isClickable?.index ?? []);

    for (const [backendNodeId, snapIdx] of beToIdx) {
      const isClickable = clickableIndices.has(snapIdx);
      let cursorStyle: string | null = null;
      let bounds: DOMRect | null = null;
      let paintOrder: number | null = null;
      let computedStyles: Record<string, string> | null = null;
      let backgroundColor: string | null = null;

      const layoutIdx = layoutMap.get(snapIdx);
      if (layoutIdx !== undefined) {
        // Bounds (device pixels → CSS pixels)
        if (layout.bounds && layoutIdx < layout.bounds.length) {
          const b = layout.bounds[layoutIdx];
          if (b && b.length >= 4) {
            bounds = {
              x: b[0]! / dpr,
              y: b[1]! / dpr,
              width: b[2]! / dpr,
              height: b[3]! / dpr,
            };
          }
        }

        // Computed styles
        if (layout.styles && layoutIdx < layout.styles.length) {
          const si = layout.styles[layoutIdx];
          if (si) {
            computedStyles = {};
            for (let j = 0; j < si.length && j < REQUIRED_COMPUTED_STYLES.length; j++) {
              const strIdx = si[j]!;
              const name = REQUIRED_COMPUTED_STYLES[j];
              if (name && strIdx >= 0 && strIdx < strings.length) {
                computedStyles[name] = strings[strIdx]!;
              }
            }
            cursorStyle = computedStyles["cursor"] ?? null;
            backgroundColor = computedStyles["background-color"] ?? null;
          }
        }

        // Paint order
        if (layout.paintOrders && layoutIdx < layout.paintOrders.length) {
          paintOrder = layout.paintOrders[layoutIdx] ?? null;
        }
      }

      lookup.set(backendNodeId, {
        isClickable,
        cursorStyle,
        bounds,
        paintOrder,
        computedStyles,
        backgroundColor,
      });
    }
  }

  return lookup;
}
