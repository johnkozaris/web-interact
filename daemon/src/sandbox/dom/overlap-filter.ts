/**
 * Paint order occlusion detection.
 *
 * CDP-based implementation.py.
 * Uses Chrome's paint order data from DOMSnapshot.captureSnapshot to determine
 * which elements are visually hidden behind others.
 *
 * Algorithm: O(n) per paint layer via a disjoint rectangle union.
 */

import type { DOMElement } from "./types.js";

// ---------------------------------------------------------------------------
// Rect — axis-aligned rectangle with fast geometric operations
// ---------------------------------------------------------------------------

interface Rect {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

function intersects(a: Rect, b: Rect): boolean {
  return !(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1);
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    outer.x1 <= inner.x1 &&
    outer.y1 <= inner.y1 &&
    outer.x2 >= inner.x2 &&
    outer.y2 >= inner.y2
  );
}

// ---------------------------------------------------------------------------
// RectUnion — disjoint rectangle set ()
// "No external dependencies — fine for a few thousand rectangles."
// ---------------------------------------------------------------------------

class RectUnion {
  private rects: Rect[] = [];

  /** Return up to 4 rectangles = a \ b (a minus b). Assumes intersection. */
  private splitDiff(a: Rect, b: Rect): Rect[] {
    const parts: Rect[] = [];
    if (a.y1 < b.y1) parts.push({ x1: a.x1, y1: a.y1, x2: a.x2, y2: b.y1 });
    if (b.y2 < a.y2) parts.push({ x1: a.x1, y1: b.y2, x2: a.x2, y2: a.y2 });
    const yLo = Math.max(a.y1, b.y1);
    const yHi = Math.min(a.y2, b.y2);
    if (a.x1 < b.x1) parts.push({ x1: a.x1, y1: yLo, x2: b.x1, y2: yHi });
    if (b.x2 < a.x2) parts.push({ x1: b.x2, y1: yLo, x2: a.x2, y2: yHi });
    return parts;
  }

  /** True if r is fully covered by the current union. */
  isCovered(r: Rect): boolean {
    if (this.rects.length === 0) return false;
    let stack = [r];
    for (const s of this.rects) {
      const next: Rect[] = [];
      for (const piece of stack) {
        if (contains(s, piece)) continue;
        if (intersects(piece, s)) next.push(...this.splitDiff(piece, s));
        else next.push(piece);
      }
      if (next.length === 0) return true;
      stack = next;
    }
    return false;
  }

  /** Insert r unless already covered. */
  add(r: Rect): void {
    if (this.isCovered(r)) return;
    let pending = [r];
    for (const s of this.rects) {
      const next: Rect[] = [];
      for (const piece of pending) {
        if (intersects(piece, s)) next.push(...this.splitDiff(piece, s));
        else next.push(piece);
      }
      pending = next;
    }
    this.rects.push(...pending);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find elements that are visually occluded by higher paint-order opaque elements.
 *
 * 
 *   1. Group elements by paint order (descending — topmost first)
 *   2. For each layer, check if elements are fully covered by the union
 *   3. Skip transparent/low-opacity elements from the union (they don't occlude)
 *
 * Returns the set of backendNodeIds that are occluded.
 */
export function findHiddenByOverlap(elements: DOMElement[]): Set<number> {
  const occluded = new Set<number>();

  const withPO = elements.filter(
    (el) => el.paintOrder !== null && el.bounds !== null
  );
  if (withPO.length === 0) return occluded;

  // Group by paint order
  const grouped = new Map<number, DOMElement[]>();
  for (const el of withPO) {
    const po = el.paintOrder!;
    let group = grouped.get(po);
    if (!group) { group = []; grouped.set(po, group); }
    group.push(el);
  }

  // Process highest paint order first (painted last = on top)
  const sortedKeys = [...grouped.keys()].sort((a, b) => b - a);
  const union = new RectUnion();

  for (const po of sortedKeys) {
    const nodes = grouped.get(po)!;
    const toAdd: Rect[] = [];

    for (const node of nodes) {
      const b = node.bounds!;
      if (b.width <= 0 || b.height <= 0) continue;
      const rect: Rect = { x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height };

      if (union.isCovered(rect)) {
        occluded.add(node.backendNodeId);
        continue;
      }

      // Don't add transparent/low-opacity elements (they don't occlude)
      // "highly vibes based number"
      const bg = node.backgroundColor ?? "rgba(0, 0, 0, 0)";
      const opacity = node.computedStyles
        ? parseFloat(node.computedStyles["opacity"] ?? "1")
        : 1;
      if (bg === "rgba(0, 0, 0, 0)" || opacity < 0.8) continue;

      toAdd.push(rect);
    }

    for (const r of toAdd) union.add(r);
  }

  return occluded;
}
