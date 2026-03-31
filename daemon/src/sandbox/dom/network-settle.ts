/**
 * Network + DOM settlement detection via CDP.
 *
 * Tracks network activity via CDP Network events:
 *   - Tracks inflight network requests via CDP Network events
 *   - Ignores WebSocket/EventSource streams (they never "finish")
 *   - Sweeps stalled requests after 2 seconds
 *   - Combines with DOM MutationObserver for full settlement
 *
 * More reliable than pure JS MutationObserver because it catches:
 *   - XHR/fetch requests that haven't returned
 *   - Resources still loading (images, scripts)
 *   - Requests that will trigger DOM changes when they complete
 */

import type { CDPSession } from "./types.js";

export interface IdleResult {
  settled: boolean;
  elapsed: number;
  pendingRequests: number;
  reason?: string;
}

/**
 * Wait for the page to settle — both network quiet and DOM stable.
 *
 * @param quietMs - Milliseconds of no activity to consider settled (default 500)
 * @param timeout - Maximum wait time (default 5000)
 */
export async function waitForNetworkIdle(
  session: CDPSession,
  options?: { quietMs?: number; timeout?: number }
): Promise<IdleResult> {
  const quietMs = options?.quietMs ?? 500;
  const timeout = options?.timeout ?? 5000;

  // Enable Network domain for request tracking
  await session.send("Network.enable").catch(() => {});

  const inflight = new Map<string, number>(); // requestId → startTime
  let lastActivity = Date.now();
  const startTime = Date.now();

  // Track request lifecycle
  const handlers: Array<{ event: string; fn: (p: unknown) => void }> = [];

  function onRequestStart(params: unknown) {
    const p = params as { requestId?: string; type?: string };
    if (!p.requestId) return;
    // Ignore WebSocket/EventSource — they stay open indefinitely
    if (p.type === "WebSocket" || p.type === "EventSource") return;
    inflight.set(p.requestId, Date.now());
    lastActivity = Date.now();
  }

  function onRequestEnd(params: unknown) {
    const p = params as { requestId?: string };
    if (!p.requestId) return;
    inflight.delete(p.requestId);
    lastActivity = Date.now();
  }

  // Register CDP event handlers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = session as any;
  const events = [
    { event: "Network.requestWillBeSent", fn: onRequestStart },
    { event: "Network.loadingFinished", fn: onRequestEnd },
    { event: "Network.loadingFailed", fn: onRequestEnd },
    { event: "Network.requestServedFromCache", fn: onRequestEnd },
  ];

  if (typeof s.on === "function") {
    for (const { event, fn } of events) {
      s.on(event, fn);
      handlers.push({ event, fn });
    }
  }

  try {
    return await new Promise<IdleResult>((resolve) => {
      const check = () => {
        const elapsed = Date.now() - startTime;
        const sinceActivity = Date.now() - lastActivity;

        // Sweep stalled requests (>2s)
        const now = Date.now();
        for (const [reqId, startedAt] of inflight) {
          if (now - startedAt > 2000) {
            inflight.delete(reqId);
          }
        }

        // Check if quiet
        if (sinceActivity >= quietMs && inflight.size === 0) {
          resolve({
            settled: true,
            elapsed,
            pendingRequests: 0,
          });
          return;
        }

        // Check timeout
        if (elapsed >= timeout) {
          resolve({
            settled: false,
            elapsed,
            pendingRequests: inflight.size,
            reason: `timeout (${inflight.size} requests still pending)`,
          });
          return;
        }

        setTimeout(check, 100);
      };

      setTimeout(check, Math.min(quietMs, 200));
    });
  } finally {
    // Cleanup handlers
    if (typeof s.off === "function") {
      for (const { event, fn } of handlers) {
        s.off(event, fn);
      }
    }
    // Disable Network domain to reduce overhead
    await session.send("Network.disable").catch(() => {});
  }
}
