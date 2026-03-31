/**
 * Serialization — format interactive elements for LLM consumption.
 *
 * Formats interactive elements as compact strings for LLM consumption:
 *   - Format: `[id] role: name`
 *   - Attribute display: `[id]<tag attrs />` with compound hints
 *   - Text cleaning: PUA char removal, NBSP normalization
 */

import type { PageElement, DOMElement } from "./types.js";

// ---------------------------------------------------------------------------
// Text cleaning
// ---------------------------------------------------------------------------

/**
 * Remove Private Use Area chars, normalize NBSP variants, collapse whitespace.
 */
export function trimText(text: string, maxLen = 100): string {
  let out = "";
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xe000 && code <= 0xf8ff) continue; // PUA
    if (code === 0x00a0 || code === 0x202f || code === 0x2007 || code === 0xfeff) {
      if (!prevSpace) { out += " "; prevSpace = true; }
      continue;
    }
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (!prevSpace) { out += " "; prevSpace = true; }
      continue;
    }
    out += ch;
    prevSpace = false;
  }
  const trimmed = out.trim();
  return trimmed.length > maxLen ? trimmed.substring(0, maxLen) + "..." : trimmed;
}

// ---------------------------------------------------------------------------
// Compound component hints
// ---------------------------------------------------------------------------

const FORMAT_MAP: Record<string, string> = {
  date: "YYYY-MM-DD",
  "datetime-local": "YYYY-MM-DDTHH:MM",
  month: "YYYY-MM",
  week: "YYYY-W##",
  time: "HH:MM",
};

export function getElementHint(el: DOMElement): string | null {
  if (el.tag !== "input") return null;
  const type = (el.attributes["type"] ?? "").toLowerCase();

  if (FORMAT_MAP[type]) return `format=${FORMAT_MAP[type]}`;
  if (type === "range") {
    return `range ${el.attributes["min"] ?? "0"}-${el.attributes["max"] ?? "100"} current=${el.attributes["value"] ?? ""}`;
  }
  if (type === "file") return `accepts=${el.attributes["accept"] ?? "*"}`;
  if (type === "color") return `color=${el.attributes["value"] ?? "#000000"}`;
  if (type === "number") {
    const parts: string[] = [];
    if (el.attributes["min"]) parts.push(`min=${el.attributes["min"]}`);
    if (el.attributes["max"]) parts.push(`max=${el.attributes["max"]}`);
    if (el.attributes["step"] && el.attributes["step"] !== "1")
      parts.push(`step=${el.attributes["step"]}`);
    return parts.length > 0 ? parts.join(" ") : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Element serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a single interactive element to a compact string.
 *
 * Format: `[index] tag "name" key=value (hint) [state]`
 *
 * Combines attribute display with clean `[id] role: name` readability.
 */
export function formatElement(
  el: PageElement,
  axProps: Array<{ name: string; value: unknown }>,
  compoundHint: string | null,
  selectHint: string | null,
  isNew: boolean
): string {
  const parts: string[] = [];

  // Index with optional new marker
  parts.push(`${isNew ? "*" : ""}[${el.index}]`);

  // Canvas hint: show dimensions and indicate visual content
  if (el.tag === "canvas" && el.bounds) {
    parts.push(`canvas (${Math.round(el.bounds.width)}x${Math.round(el.bounds.height)}) — visual content area, use keyboard or clickAt(x,y)`);
    return parts.join(" ");
  }

  // Tag + type or role
  let tagDisplay = el.tag;
  if (el.tag === "input" && el.attributes["type"]) {
    tagDisplay = `input[${el.attributes["type"]}]`;
  } else if (
    el.role &&
    !["generic", "none", "presentation"].includes(el.role) &&
    ["div", "span", "td", "tr", "li", "section"].includes(el.tag)
  ) {
    tagDisplay = `${el.tag}[role="${el.role}"]`;
  }
  parts.push(tagDisplay);

  // Accessible name
  const name = trimText(el.name);
  if (name) {
    parts.push(JSON.stringify(name));
  } else if (el.attributes["id"]) {
    parts.push(`id="${el.attributes["id"]}"`);
  }

  // Key display attributes
  if (el.attributes["placeholder"] && el.attributes["placeholder"] !== el.name) {
    parts.push(`placeholder=${JSON.stringify(trimText(el.attributes["placeholder"]))}`);
  }
  if (el.attributes["href"]) {
    let href = el.attributes["href"];
    if (href.length > 60) href = href.substring(0, 60) + "...";
    parts.push(`href=${JSON.stringify(href)}`);
  }

  // Compound hint (date format, range state, etc.)
  if (compoundHint) parts.push(`(${compoundHint})`);

  // Select options
  if (selectHint) parts.push(selectHint);

  // Keyboard shortcuts (from AX properties)
  if (el.attributes["aria-keyshortcuts"]) parts.push(`keys=${el.attributes["aria-keyshortcuts"]}`);
  if (el.attributes["accesskey"]) parts.push(`accesskey=${el.attributes["accesskey"]}`);

  // State from AX properties (Chrome computed, not HTML attributes)
  const states: string[] = [];
  for (const prop of axProps) {
    if (prop.name === "checked" && prop.value) states.push("checked");
    if (prop.name === "expanded" && prop.value === true) states.push("expanded");
    if (prop.name === "pressed" && prop.value === true) states.push("pressed");
    if (prop.name === "disabled" && prop.value === true) states.push("disabled");
    if (prop.name === "required" && prop.value === true) states.push("required");
    if (prop.name === "readonly" && prop.value === true) states.push("readonly");
  }
  if (states.length > 0) parts.push(`[${states.join(", ")}]`);

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Page structure summary — gives the LLM a high-level overview
// ---------------------------------------------------------------------------

/**
 * Generate a brief page structure summary that helps the LLM understand
 * the layout without looking at every element.
 *
 * Shows: landmark regions, total counts by role, and viewport info.
 */
export function summarizePage(
  elements: Array<{ role: string; name: string; tag: string; bounds: import("./types.js").DOMRect | null }>,
  viewport: { width: number; height: number }
): string {
  const lines: string[] = [];

  // Count by role
  const roleCounts = new Map<string, number>();
  for (const el of elements) {
    const key = el.role || el.tag;
    roleCounts.set(key, (roleCounts.get(key) ?? 0) + 1);
  }

  // Show summary
  const significant = [...roleCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (significant.length > 0) {
    lines.push(`Page has ${elements.length} interactive elements: ` +
      significant.map(([role, count]) => `${count} ${role}s`).join(", "));
  }

  lines.push(`Viewport: ${viewport.width}x${viewport.height}`);

  return lines.join("\n");
}
