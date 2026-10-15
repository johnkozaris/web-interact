import type { Browser, BrowserContext } from "patchright";

const RUNTIME_PATCH_APPLIED = Symbol.for("web-interact.patchright.runtime-enable.applied");
const RUNTIME_SESSION_ENABLED = Symbol.for("web-interact.patchright.runtime-enable.session");

type CRSessionLike = {
  send: (method: string, params?: unknown) => Promise<unknown>;
  [RUNTIME_PATCH_APPLIED]?: boolean;
  [RUNTIME_SESSION_ENABLED]?: boolean;
};

type ServerBrowserLike = {
  _connection?: { rootSession?: CRSessionLike };
};

type ServerPageLike = {
  delegate?: { _mainFrameSession?: { _client?: CRSessionLike } };
};

function toServerImpl<T>(clientObject: unknown): T | undefined {
  const toImpl = (clientObject as { _connection?: { toImpl?: (value: unknown) => unknown } })
    ._connection?.toImpl;
  return typeof toImpl === "function" ? (toImpl(clientObject) as T) : undefined;
}

async function enableRuntimeOnce(session: CRSessionLike): Promise<void> {
  if (session[RUNTIME_SESSION_ENABLED]) {
    return;
  }

  session[RUNTIME_SESSION_ENABLED] = true;
  try {
    await session.send("Runtime.enable");
  } catch {
    // Ignore detached or already-closed sessions.
  }
}

/**
 * Patchright's Chromium page sessions listen for Runtime.consoleAPICalled but do not
 * enable the Runtime domain. Enabling it after Page.enable restores console events
 * and page.consoleMessages() without forking the dependency.
 *
 * Playwright bundles its internals since 1.64, so the CDP session class is reached
 * through a launched browser instead of a module path. Call this right after a
 * browser is launched or connected: it patches the class once, and enables Runtime on
 * the page sessions that were opened before the patch existed.
 */
export async function applyPatchrightRuntimeEnableWorkaround(
  browser: Browser,
  contexts: BrowserContext[] = browser.contexts()
): Promise<void> {
  const rootSession = toServerImpl<ServerBrowserLike>(browser)?._connection?.rootSession;
  if (!rootSession) {
    // Not an in-process Chromium browser.
    return;
  }

  const sessionPrototype = Object.getPrototypeOf(rootSession) as CRSessionLike;
  if (!sessionPrototype[RUNTIME_PATCH_APPLIED]) {
    const originalSend = sessionPrototype.send;
    sessionPrototype.send = async function patchedSend(
      this: CRSessionLike,
      method: string,
      params?: unknown
    ): Promise<unknown> {
      const result = await originalSend.call(this, method, params);
      if (method === "Page.enable") {
        await enableRuntimeOnce(this);
      }
      return result;
    };
    sessionPrototype[RUNTIME_PATCH_APPLIED] = true;
  }

  for (const context of contexts) {
    for (const page of context.pages()) {
      const session = toServerImpl<ServerPageLike>(page)?.delegate?._mainFrameSession?._client;
      if (session) {
        await enableRuntimeOnce(session);
      }
    }
  }
}
