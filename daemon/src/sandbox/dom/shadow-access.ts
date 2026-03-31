/**
 * Shadow DOM piercing via attachShadow monkey-patch.
 *
 * Accesses closed shadow roots via CDP for element detection.
 *
 * Patches Element.prototype.attachShadow to track ALL shadow roots (including
 * closed ones) in a WeakMap. Exposes a backdoor API at window.__webInteract__
 * for CDP-based access to closed roots.
 *
 * This is injected into pages via Page.addScriptToEvaluateOnNewDocument or
 * via Runtime.evaluate early in the page lifecycle.
 *
 * Properties:
 *   - Non-invasive: only records, doesn't alter shadow root behavior
 *   - WeakMap: no memory leak, roots GC'd with hosts
 *   - Idempotent: safe to inject multiple times
 *   - Per-mode counters: tracks open vs closed separately
 */

/**
 * The injectable script that patches attachShadow.
 * Runs in the PAGE CONTEXT via page.evaluate() or addInitScript().
 */
export const SHADOW_ACCESS_SCRIPT = `
(function setupShadowAccess() {
  "use strict";

  // Idempotent: check if already installed
  var currentFn = Element.prototype.attachShadow;
  if (currentFn.__webInteractPatched) {
    // Already patched — reuse existing state, rebind backdoor
    var existingState = currentFn.__webInteractState;
    if (existingState) {
      window.__webInteract__ = {
        getClosedRoot: function(host) {
          return existingState.hostToRoot.get(host);
        },
        stats: function() {
          return {
            installed: true,
            url: window.location.href,
            isTop: window === window.top,
            open: existingState.openCount,
            closed: existingState.closedCount
          };
        }
      };
    }
    return;
  }

  // First-time install
  var state = {
    hostToRoot: new WeakMap(),
    openCount: 0,
    closedCount: 0
  };

  var original = Element.prototype.attachShadow;

  function patched(init) {
    var root = original.call(this, init);
    state.hostToRoot.set(this, root);
    if (init && init.mode === "closed") {
      state.closedCount++;
    } else {
      state.openCount++;
    }
    return root;
  }

  patched.__webInteractPatched = true;
  patched.__webInteractState = state;

  Element.prototype.attachShadow = patched;

  // Expose backdoor API
  window.__webInteract__ = {
    getClosedRoot: function(host) {
      return state.hostToRoot.get(host);
    },
    stats: function() {
      return {
        installed: true,
        url: window.location.href,
        isTop: window === window.top,
        open: state.openCount,
        closed: state.closedCount
      };
    }
  };

  // Optionally tag pre-existing open shadow roots
  try {
    var walker = document.createTreeWalker(
      document.documentElement || document,
      NodeFilter.SHOW_ELEMENT
    );
    var node;
    while (node = walker.nextNode()) {
      if (node.shadowRoot && !state.hostToRoot.has(node)) {
        state.hostToRoot.set(node, node.shadowRoot);
        state.openCount++;
      }
    }
  } catch(e) {
    // DOM may not be ready yet — that's fine, new roots will be caught by the patch
  }
})();
`;

/**
 * Install the shadow DOM piercer on a CDP session.
 * Uses Page.addScriptToEvaluateOnNewDocument so it runs on every navigation.
 */
export async function setupShadowAccess(
  session: import("./types.js").CDPSession
): Promise<void> {
  try {
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: SHADOW_ACCESS_SCRIPT,
    });
  } catch {
    // May fail on some pages — non-critical
  }

  // Also run immediately on current page
  try {
    await session.send("Runtime.evaluate", {
      expression: SHADOW_ACCESS_SCRIPT,
      returnByValue: true,
    });
  } catch {
    // Page may not be ready
  }
}
