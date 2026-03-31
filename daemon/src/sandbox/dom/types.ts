/**
 * Types for the CDP-based DOM detection pipeline.
 *
 * Uses devtools-protocol for proper CDP typing. Data structures adapted from
 * upstream (EnhancedDOMTreeNode, EnhancedLayoutNode) and upstream (A11yNode).
 */

import type { Protocol } from "devtools-protocol";

// Re-export Protocol types used across the module
export type AXNode = Protocol.Accessibility.AXNode;
export type AXProperty = Protocol.Accessibility.AXProperty;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface DOMRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// CDP session abstraction (Patchright's CDPSession is untyped)
// ---------------------------------------------------------------------------

export interface CDPSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Snapshot data (from DOMSnapshot.captureSnapshot)
// Ported 's EnhancedLayoutNode
// ---------------------------------------------------------------------------

export interface LayoutNode {
  /** Chrome's own isClickable determination */
  isClickable: boolean;
  /** CSS cursor property */
  cursorStyle: string | null;
  /** Bounding box in CSS pixels */
  bounds: DOMRect | null;
  /** Paint order for occlusion detection */
  paintOrder: number | null;
  /** Computed CSS styles */
  computedStyles: Record<string, string> | null;
  /** Background color for transparency detection */
  backgroundColor: string | null;
}

// ---------------------------------------------------------------------------
// Merged element (DOM + AX + Snapshot combined)
// Ported 's EnhancedDOMTreeNode concept
// ---------------------------------------------------------------------------

export interface DOMElement {
  backendNodeId: number;
  tag: string;
  attributes: Record<string, string>;
  /** AX role (Chrome computed: "button", "link", "textbox", etc.) */
  role: string;
  /** AX name (Chrome computed accessible name) */
  name: string;
  /** AX description */
  description: string;
  /** AX properties (checked, expanded, pressed, etc.) */
  axProperties: Array<{ name: string; value: unknown }>;
  /** Chrome's isClickable from DOMSnapshot */
  isClickable: boolean;
  /** Has JS click event listeners (from CDP Runtime) */
  hasJSListener: boolean;
  /** Is visible (computed styles + bounds) */
  isVisible: boolean;
  /** CSS cursor style */
  cursorStyle: string | null;
  /** Bounding box in CSS pixels */
  bounds: DOMRect | null;
  /** Paint order for occlusion detection */
  paintOrder: number | null;
  /** Background color */
  backgroundColor: string | null;
  /** Computed styles */
  computedStyles: Record<string, string> | null;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface PageElement {
  index: number;
  backendNodeId: number;
  tag: string;
  role: string;
  name: string;
  selector: string;
  xpath: string;
  attributes: Record<string, string>;
  axProperties: Array<{ name: string; value: unknown }>;
  bounds: DOMRect | null;
}

export interface ScrollRegion {
  selector: string;
  hiddenPixels: number;
  hiddenPages: number;
}

export interface DiscoveryResult {
  count: number;
  serialized: string;
  elements: PageElement[];
  scrollableAreas: ScrollRegion[];
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
}

// ---------------------------------------------------------------------------
// Required computed styles for DOMSnapshot.captureSnapshot
// From upstream's REQUIRED_COMPUTED_STYLES
// ---------------------------------------------------------------------------

export const REQUIRED_COMPUTED_STYLES = [
  "display",
  "visibility",
  "opacity",
  "overflow",
  "overflow-x",
  "overflow-y",
  "cursor",
  "pointer-events",
  "position",
  "background-color",
] as const;
