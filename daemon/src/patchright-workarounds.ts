import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const currentDir = path.dirname(fileURLToPath(import.meta.url));

const RUNTIME_PATCH_APPLIED = Symbol.for("web-interact.patchright.runtime-enable.applied");
const RUNTIME_SESSION_ENABLED = Symbol.for("web-interact.patchright.runtime-enable.session");

type CRSessionLike = {
  send: (method: string, params?: unknown) => Promise<unknown>;
  [RUNTIME_PATCH_APPLIED]?: boolean;
  [RUNTIME_SESSION_ENABLED]?: boolean;
};

function applyPatchrightRuntimeEnableWorkaround(): void {
  const chromiumInternals = require(resolvePatchrightInternal(path.join("lib", "server", "chromium", "crConnection.js"))) as {
    CRSession?: {
      prototype: CRSessionLike;
    };
  };

  const sessionPrototype = chromiumInternals.CRSession?.prototype;
  if (!sessionPrototype || sessionPrototype[RUNTIME_PATCH_APPLIED]) {
    return;
  }

  const originalSend = sessionPrototype.send;
  sessionPrototype.send = async function patchedSend(method: string, params?: unknown): Promise<unknown> {
    const result = await originalSend.call(this, method, params);

    // Patchright's Chromium page sessions listen for Runtime.consoleAPICalled but do not
    // enable the Runtime domain. Enabling it after Page.enable restores console events
    // and page.consoleMessages() without forking the dependency.
    if (method === "Page.enable" && !this[RUNTIME_SESSION_ENABLED]) {
      this[RUNTIME_SESSION_ENABLED] = true;
      try {
        await originalSend.call(this, "Runtime.enable");
      } catch {
        // Ignore detached or already-closed sessions; Page.enable already succeeded.
      }
    }

    return result;
  };

  sessionPrototype[RUNTIME_PATCH_APPLIED] = true;
}

function resolvePatchrightInternal(modulePath: string): string {
  const candidates = [
    path.resolve(currentDir, "../node_modules/patchright-core", modulePath),
    path.resolve(process.cwd(), "node_modules/patchright-core", modulePath),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not locate Patchright internals at ${modulePath}`);
}

applyPatchrightRuntimeEnableWorkaround();
