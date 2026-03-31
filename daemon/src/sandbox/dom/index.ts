/**
 * DOM detection + action module.
 *
 * Detection: Host-side CDP (Accessibility, DOMSnapshot, Runtime)
 * Actions:   CDP Input events or JS page-side fallback
 * Safety:    Popup dismiss, shadow DOM pierce, network settlement
 */

// Detection
export { getPageElementsCDP } from "./service.js";
export type { GetPageElementsOptions } from "./service.js";

// CDP Actions (real browser-level input events)
export { cdpClick, cdpClickAt, cdpDrag, cdpType } from "./cdp-actions.js";
export type { CDPClickResult, CDPClickAtResult, CDPTypeResult } from "./cdp-actions.js";

// Network settlement (CDP-based)
export { waitForNetworkIdle } from "./network-settle.js";

// JS Actions (browser-side fallback — used by select/check which need DOM access)
export {
  CLICK_ELEMENT_SCRIPT,
  FILL_ELEMENT_SCRIPT,
  SELECT_OPTION_SCRIPT,
  CHECK_ELEMENT_SCRIPT,
} from "./actions.js";

// Types
export type {
  CDPSession,
  PageElement,
  DiscoveryResult,
  DOMElement,
  DOMRect,
} from "./types.js";
