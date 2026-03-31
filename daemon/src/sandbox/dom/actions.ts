/**
 * Browser-side action scripts.
 *
 * These run in the PAGE CONTEXT via page.evaluate(), not in the QuickJS sandbox
 * or on the host. They perform native DOM operations that bypass Playwright's
 * actionability checks and retry loops — zero timeout risk.
 *
 * Click uses proper MouseEvent dispatch with bubbles + composed flags.
 * Fill uses native input setter + React _valueTracker reset.
 * All scripts support both CSS selectors and xpath= prefixed XPaths.
 */

// ---------------------------------------------------------------------------
// Helper: resolve element from selector (CSS or xpath=)
// ---------------------------------------------------------------------------

const FIND_ELEMENT_JS = `
  function resolveElement(selector) {
    if (selector && selector.indexOf("xpath=") === 0) {
      var xp = selector.substring(6);
      return document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    }
    return document.querySelector(selector);
  }
`;

// ---------------------------------------------------------------------------
// Click
// ---------------------------------------------------------------------------

export const CLICK_ELEMENT_SCRIPT = `
(function clickElement(selector, action) {
  "use strict";
  ${FIND_ELEMENT_JS}

  action = action || "click";
  var el = resolveElement(selector);
  if (!el) return { success: false, error: "Element not found: " + selector };

  try {
    if (action === "click") {
      // Proper MouseEvent with bubbles + composed
      // composed: true ensures events cross shadow DOM boundaries
      try {
        var event = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          composed: true,
          detail: 1,
          view: el.ownerDocument && el.ownerDocument.defaultView || window
        });
        el.dispatchEvent(event);
      } catch (me) {
        el.click(); // Fallback
      }
    } else if (action === "focus") {
      el.focus();
    } else if (action === "scrollIntoView") {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return {
      success: true,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").trim().substring(0, 100)
    };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
})
`;

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------

export const FILL_ELEMENT_SCRIPT = `
(function fillElement(selector, value) {
  "use strict";
  ${FIND_ELEMENT_JS}

  var el = resolveElement(selector);
  if (!el) return { success: false, error: "Element not found: " + selector };

  // Redirect label → associated form control
  var tag = el.tagName.toLowerCase();
  if (tag === "label") {
    var forAttr = el.getAttribute("for");
    if (forAttr) {
      var target = document.getElementById(forAttr);
      if (target) { el = target; tag = el.tagName.toLowerCase(); }
    } else {
      var nested = el.querySelector("input, select, textarea");
      if (nested) { el = nested; tag = el.tagName.toLowerCase(); }
    }
  }

  try {
    el.focus();

    // Native value setter to bypass React/Vue controlled components
    var filled = false;
    try {
      var proto = tag === "textarea"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      var descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, value);
        filled = true;
      }
    } catch (e) {}

    if (!filled) el.value = value;

    // Reset React's internal value tracker
    try { if (el._valueTracker) el._valueTracker.setValue(value); } catch(vt) {}

    // Dispatch proper InputEvent (inputType "insertText")
    try {
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, composed: true, data: value, inputType: "insertText"
      }));
    } catch(ie) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));

    return { success: true, tag: tag, value: el.value };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
})
`;

// ---------------------------------------------------------------------------
// Select option
// ---------------------------------------------------------------------------

export const SELECT_OPTION_SCRIPT = `
(function selectOption(selector, optionValue) {
  "use strict";
  ${FIND_ELEMENT_JS}

  var el = resolveElement(selector);
  if (!el) return { success: false, error: "Element not found: " + selector };

  // Redirect label → select
  var tag = el.tagName.toLowerCase();
  if (tag === "label") {
    var forAttr = el.getAttribute("for");
    if (forAttr) { var t = document.getElementById(forAttr); if (t) { el = t; tag = el.tagName.toLowerCase(); } }
    else { var n = el.querySelector("select"); if (n) { el = n; tag = "select"; } }
  }
  if (tag !== "select") return { success: false, error: "Not a select: " + tag };

  // Match by value, then text, then fuzzy
  var matched = false;
  for (var i = 0; i < el.options.length; i++) {
    if (el.options[i].value === optionValue || el.options[i].text.trim() === optionValue) {
      el.selectedIndex = i; matched = true; break;
    }
  }
  if (!matched) {
    var lower = optionValue.toLowerCase();
    for (var j = 0; j < el.options.length; j++) {
      if (el.options[j].text.toLowerCase().indexOf(lower) !== -1 ||
          el.options[j].value.toLowerCase().indexOf(lower) !== -1) {
        el.selectedIndex = j; matched = true; break;
      }
    }
  }
  if (!matched) {
    return { success: false, error: "Option not found: " + optionValue,
      available: Array.from(el.options).slice(0, 10).map(function(o) { return o.text.trim() || o.value; })
    };
  }

  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return { success: true, tag: "select", selectedValue: el.options[el.selectedIndex].value, selectedText: el.options[el.selectedIndex].text.trim() };
})
`;

// ---------------------------------------------------------------------------
// Check / uncheck
// ---------------------------------------------------------------------------

export const CHECK_ELEMENT_SCRIPT = `
(function checkElement(selector, checked) {
  "use strict";
  ${FIND_ELEMENT_JS}

  var el = resolveElement(selector);
  if (!el) return { success: false, error: "Element not found: " + selector };

  // Redirect label → input
  var tag = el.tagName.toLowerCase();
  if (tag === "label") {
    var forAttr = el.getAttribute("for");
    if (forAttr) { var t = document.getElementById(forAttr); if (t) { el = t; tag = el.tagName.toLowerCase(); } }
    else { var n = el.querySelector("input[type=checkbox], input[type=radio]"); if (n) { el = n; tag = "input"; } }
  }
  if (tag !== "input") return { success: false, error: "Not a checkbox/radio: " + tag };
  var type = (el.type || "").toLowerCase();
  if (type !== "checkbox" && type !== "radio") return { success: false, error: "Input type is not checkbox/radio: " + type };

  if (checked === undefined) el.click();
  else if (el.checked !== checked) el.click();

  return { success: true, tag: "input", type: type, checked: el.checked };
})
`;

// DOM settlement is now handled by network-settle.ts via CDP Network events.
// The old MutationObserver-based script has been removed.
