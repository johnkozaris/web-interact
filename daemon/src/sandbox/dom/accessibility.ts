/**
 * Accessibility tree fetching via CDP.
 *
 * From upstream's a11yForFrame() — calls Accessibility.getFullAXTree
 * and builds a lookup table of backendDOMNodeId → AX node data.
 * This gives us Chrome's computed roles, names, and properties.
 */

import type { CDPSession } from "./types.js";

export interface AXNodeData {
  nodeId: string;
  role: string;
  name: string;
  description: string;
  properties: Array<{ name: string; value: unknown }>;
}

/**
 * Fetch the full accessibility tree and build a backendNodeId lookup.
 *
 * The AX tree is Chrome's own computation of:
 *   - Roles (implicit from HTML or explicit from ARIA)
 *   - Accessible names (computed per the name computation algorithm)
 *   - Properties (checked, expanded, pressed, selected, focusable, etc.)
 *
 * This is the source of truth for "what is this element?" — not HTML attributes.
 */
export async function getAccessibilityNodes(
  session: CDPSession
): Promise<Map<number, AXNodeData>> {
  try {
    await session.send("Accessibility.enable");
  } catch {
    // May already be enabled
  }

  const result = (await session.send("Accessibility.getFullAXTree")) as {
    nodes: Array<{
      nodeId: string;
      backendDOMNodeId?: number;
      ignored?: boolean;
      role?: { type: string; value: string };
      name?: { type: string; value: string };
      description?: { type: string; value: string };
      properties?: Array<{
        name: string;
        value: { type: string; value: unknown };
      }>;
    }>;
  };

  const lookup = new Map<number, AXNodeData>();

  for (const raw of result.nodes) {
    if (raw.backendDOMNodeId === undefined) continue;
    if (raw.ignored) continue;

    const properties: Array<{ name: string; value: unknown }> = [];
    if (raw.properties) {
      for (const p of raw.properties) {
        properties.push({ name: p.name, value: p.value?.value });
      }
    }

    lookup.set(raw.backendDOMNodeId, {
      nodeId: raw.nodeId,
      role: raw.role?.value ?? "",
      name: raw.name?.value ?? "",
      description: raw.description?.value ?? "",
      properties,
    });
  }

  return lookup;
}
