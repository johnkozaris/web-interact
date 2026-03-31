/**
 * Automatic popup/dialog dismissal via CDP.
 *
 * 
 * Listens to Page.javascriptDialogOpening CDP events and auto-dismisses
 * alert/confirm/prompt dialogs that would otherwise hang automation.
 *
 * Critical for unattended automation — a single unhandled dialog blocks
 * all subsequent CDP commands on the page.
 */

import type { CDPSession } from "./types.js";

export interface ClosedDialog {
  type: string;
  message: string;
  timestamp: number;
}

/**
 * Install a popup handler on a CDP session.
 * Returns a function to retrieve dismissed dialog messages.
 *
 * From upstream: stores dismissed messages for agent context —
 * the LLM can see what popups appeared and were dismissed.
 */
export async function setupDialogHandler(
  session: CDPSession
): Promise<{
  getDismissed: () => ClosedDialog[];
  dispose: () => void;
}> {
  const dismissed: ClosedDialog[] = [];
  let disposed = false;

  // Enable Page domain for dialog events
  await session.send("Page.enable").catch(() => {});

  // The actual handler — auto-dismiss with accept
  const handleDialog = (params: unknown) => {
    if (disposed) return;
    const p = params as {
      type?: string;
      message?: string;
      url?: string;
      defaultPrompt?: string;
    };

    dismissed.push({
      type: p.type ?? "unknown",
      message: p.message ?? "",
      timestamp: Date.now(),
    });

    // Accept the dialog (dismiss it)
    // For confirm: accept = true (clicks OK)
    // For prompt: accept with empty string
    session
      .send("Page.handleJavaScriptDialog", {
        accept: true,
        promptText: "",
      })
      .catch(() => {
        // Dialog may have already been dismissed
      });
  };

  // Register listener via CDP event subscription
  // Patchright CDPSession uses .on() for events
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = session as any;
    if (typeof s.on === "function") {
      s.on("Page.javascriptDialogOpening", handleDialog);
    }
  } catch {
    // Session may not support .on() — dialog handling won't work
    // but won't break anything else
  }

  return {
    getDismissed: () => [...dismissed],
    dispose: () => {
      disposed = true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s = session as any;
        if (typeof s.off === "function") {
          s.off("Page.javascriptDialogOpening", handleDialog);
        }
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}
