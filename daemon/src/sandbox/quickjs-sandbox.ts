import { existsSync } from "node:fs";
import { readFile as readFileFs } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import util from "node:util";

import type { Page } from "patchright";

import type { BrowserManager } from "../browser-manager.js";
import {
  CHECK_ELEMENT_SCRIPT,
  CLICK_ELEMENT_SCRIPT,
  FILL_ELEMENT_SCRIPT,
  SELECT_OPTION_SCRIPT,
  cdpClick,
  cdpClickAt,
  cdpDrag,
  cdpType,
  getPageElementsCDP,
  waitForNetworkIdle,
  type CDPSession as DOMCDPSession,
} from "./dom/index.js";
import {
  deleteWebInteractTempFile,
  ensureWebInteractTempDir,
  readWebInteractTempFile,
  readWebInteractTempFileBytes,
  readWebInteractTempFileSync,
  resolveWebInteractTempPath,
  writeWebInteractTempFile,
} from "../temp-files.js";
import { HostBridge } from "./host-bridge.js";
import { QuickJSHost, type QuickJSConsoleLevel } from "./quickjs-host.js";

const DEFAULT_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const WAIT_FOR_OBJECT_ATTEMPTS = 1_000;

// Resolve sandbox-client.js: next to the running script (production), or in dist/ (development)
function findBundlePath(): string {
  const candidates = [
    fileURLToPath(new URL("./sandbox-client.js", import.meta.url)),
    fileURLToPath(new URL("../../dist/sandbox-client.js", import.meta.url)),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Failed to find sandbox-client.js. Searched:\n${candidates.map((c) => `  - ${c}`).join("\n")}`
  );
}
const BUNDLE_PATH = findBundlePath();
const TRANSPORT_RECEIVE_GLOBAL = "__transport_receive";

let bundleCodePromise: Promise<string> | undefined;

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) =>
      typeof arg === "string"
        ? arg
        : util.inspect(arg, {
            colors: false,
            depth: 6,
            compact: 3,
            breakLength: Infinity,
          })
    )
    .join(" ");
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function getSandboxClientBundleCode(): Promise<string> {
  bundleCodePromise ??= readFileFs(BUNDLE_PATH, "utf8").catch((error: unknown) => {
    bundleCodePromise = undefined;
    const message =
      error instanceof Error ? error.message : "Sandbox client bundle could not be read";
    throw new Error(`Failed to load sandbox client bundle at ${BUNDLE_PATH}: ${message}`);
  });
  return bundleCodePromise;
}

type SandboxFileReadEncoding = "utf8" | "base64";

function parseSandboxFileReadOptions(value: unknown): {
  encoding: SandboxFileReadEncoding;
} {
  if (value === undefined || value === null) {
    return {
      encoding: "utf8",
    };
  }
  if (typeof value !== "object") {
    throw new TypeError("File read options must be an object when provided");
  }

  const encoding = "encoding" in value ? value.encoding : undefined;
  if (encoding === undefined) {
    return {
      encoding: "utf8",
    };
  }
  if (encoding !== "utf8" && encoding !== "base64") {
    throw new TypeError("File read encoding must be either 'utf8' or 'base64'");
  }

  return {
    encoding,
  };
}

function normalizeSandboxModuleSpecifier(baseModuleName: string, requestedName: string): string {
  const specifier = requireString(requestedName, "Module specifier");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) {
    throw new Error(
      `Only relative imports from the web-interact temp directory are supported: ${specifier}`
    );
  }
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    throw new Error(
      `Bare module specifiers are not supported in the QuickJS sandbox: ${specifier}`
    );
  }

  const baseReference = baseModuleName.length > 0 ? `/${baseModuleName}` : "/user-script.js";
  const normalized = path.posix.normalize(
    specifier.startsWith("/")
      ? specifier
      : path.posix.join(path.posix.dirname(baseReference), specifier)
  );

  if (normalized === "/" || normalized.endsWith("/")) {
    throw new Error(`Module specifier must resolve to a file: ${specifier}`);
  }

  return normalized.replace(/^\/+/, "");
}

function loadSandboxModule(moduleName: string): string {
  if (typeof moduleName !== "string" || moduleName.length === 0) {
    throw new Error("Module specifier is required for QuickJS sandbox imports");
  }
  const specifier = moduleName;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) {
    throw new Error(
      `Only relative imports from the web-interact temp directory are supported: ${specifier}`
    );
  }
  if (!specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.includes("/")) {
    throw new Error(
      `Bare module specifiers are not supported in the QuickJS sandbox: ${specifier}`
    );
  }

  return readWebInteractTempFileSync(specifier.replace(/^\/+/, ""));
}

function formatTimeoutDuration(timeoutMs: number): string {
  if (timeoutMs % 1_000 === 0) {
    return `${timeoutMs / 1_000}s`;
  }

  return `${timeoutMs}ms`;
}

function createScriptTimeoutError(timeoutMs: number): Error {
  const hintTimeout = Math.floor(timeoutMs * 0.5);
  const error = new Error(
    `Script timed out after ${formatTimeoutDuration(timeoutMs)} and was terminated. ` +
    `If a Playwright action hung, add { timeout: ${hintTimeout} } to the action call ` +
    `so it fails fast with a specific error naming the selector.`
  );
  error.name = "ScriptTimeoutError";
  return error;
}

function createGuestScriptTimeoutErrorSource(timeoutMs: number): string {
  const message = JSON.stringify(createScriptTimeoutError(timeoutMs).message);
  return `(() => {
    const error = new Error(${message});
    error.name = "ScriptTimeoutError";
    return error;
  })()`;
}

function wrapScriptWithWallClockTimeout(script: string, timeoutMs?: number): string {
  if (timeoutMs === undefined) {
    return script;
  }

  return `
    (() => {
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(${createGuestScriptTimeoutErrorSource(timeoutMs)});
        }, ${timeoutMs});

        Promise.resolve()
          .then(() => (${script}))
          .then(resolve, reject)
          .finally(() => {
            clearTimeout(timeoutId);
          });
      });
    })()
  `;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  return value;
}

function toServerImpl<T>(clientObject: unknown, label: string): T {
  const connection = (clientObject as { _connection?: { toImpl?: (value: unknown) => unknown } })
    ._connection;
  const toImpl = connection?.toImpl;
  if (typeof toImpl !== "function") {
    throw new Error(`${label} does not expose a server implementation`);
  }

  const impl = toImpl(clientObject);
  if (!impl) {
    throw new Error(`${label} could not be mapped to a server implementation`);
  }

  return impl as T;
}

function extractGuid(page: Page): string {
  const guid = toServerImpl<{ guid?: unknown }>(page, "Playwright page").guid;
  if (typeof guid !== "string" || guid.length === 0) {
    throw new Error("Playwright page did not expose a guid");
  }

  return guid;
}

function decodeSandboxFilePayload(value: unknown, label: string): string | Uint8Array {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be an object`);
  }

  const encoding = "encoding" in value ? value.encoding : undefined;
  const data = "data" in value ? value.data : undefined;
  if ((encoding !== "utf8" && encoding !== "base64") || typeof data !== "string") {
    throw new TypeError(`${label} must include a valid encoding and string data`);
  }

  if (encoding === "utf8") {
    return data;
  }

  return Buffer.from(data, "base64");
}

interface QuickJSSandboxOptions {
  manager: BrowserManager;
  browserName: string;
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  memoryLimitBytes?: number;
  timeoutMs?: number;
  humanize?: boolean;
}

/** When --humanize is active, add a random delay that feels human. */
function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs));
  return new Promise((r) => setTimeout(r, ms));
}

export class QuickJSSandbox {
  readonly #options: QuickJSSandboxOptions;
  readonly #anonymousPages = new Set<Page>();
  readonly #pendingHostOperations = new Set<Promise<void>>();
  readonly #transportInbox: string[] = [];

  #asyncError?: Error;
  #host?: QuickJSHost;
  #hostBridge?: HostBridge;
  #flushPromise?: Promise<void>;
  #disposed = false;
  #initialized = false;
  #transportReady = false;

  constructor(options: QuickJSSandboxOptions) {
    this.#options = options;
  }

  async initialize(): Promise<void> {
    this.#assertAlive();
    if (this.#initialized) {
      return;
    }

    try {
      await ensureWebInteractTempDir();

      this.#host = await QuickJSHost.create({
        memoryLimitBytes: this.#options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES,
        cpuTimeoutMs: this.#options.timeoutMs,
        moduleLoader: {
          loadModule: (moduleName) => loadSandboxModule(moduleName),
          normalizeModule: (baseModuleName, requestedName) =>
            normalizeSandboxModuleSpecifier(baseModuleName, requestedName),
        },
        hostFunctions: {
          getPage: (name) => this.#getPage(name),
          newPage: () => this.#newPage(),
          listPages: () => this.#options.manager.listPages(this.#options.browserName),
          closePage: (name) => this.#closePage(name),
          getPageElements: (name, options) =>
            this.#getPageElements(name, options),
          waitForSettled: (name, options) =>
            this.#waitForSettled(name, options),
          clickElement: (name, selector, action) =>
            this.#clickElement(name, selector, action),
          fillElement: (name, selector, value) =>
            this.#fillElement(name, selector, value),
          selectOption: (name, selector, value) =>
            this.#selectOption(name, selector, value),
          checkElement: (name, selector, checked) =>
            this.#checkElement(name, selector, checked),
          clickAt: (name, x, y, options) =>
            this.#clickAt(name, x, y, options),
          drag: (name, fromX, fromY, toX, toY, options) =>
            this.#drag(name, fromX, fromY, toX, toY, options),
          clickByIndex: (name, index) =>
            this.#actionByIndex(name, index, "click"),
          typeByIndex: (name, index, text, options) =>
            this.#actionByIndex(name, index, "type", text, options),
          selectByIndex: (name, index, value) =>
            this.#actionByIndex(name, index, "select", value),
          checkByIndex: (name, index, checked) =>
            this.#actionByIndex(name, index, "check", checked),
          saveScreenshot: (name, data) => this.#writeTempFile(name, data),
          writeFile: (name, data) => this.#writeTempFile(name, data),
          readFile: (name, options) => this.#readTempFile(name, options),
          resolveFilePath: (name) => this.#resolveTempFilePath(name),
          deleteFile: (name) => this.#deleteTempFile(name),
        },
        onConsole: (level, args) => {
          this.#routeConsole(level, args);
        },
        onDrain: () => this.#drainAsyncOps(),
        onTransportSend: (message) => {
          this.#handleTransportSend(message);
        },
      });

      this.#host.executeScriptSync(
        `
          const __performanceOrigin = Date.now();
          const __base64Alphabet =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

          const __encodeBase64 = (bytes) => {
            let result = "";
            for (let index = 0; index < bytes.length; index += 3) {
              const chunk =
                (bytes[index] << 16) |
                ((bytes[index + 1] ?? 0) << 8) |
                (bytes[index + 2] ?? 0);
              result += __base64Alphabet[(chunk >> 18) & 63];
              result += __base64Alphabet[(chunk >> 12) & 63];
              result += index + 1 < bytes.length ? __base64Alphabet[(chunk >> 6) & 63] : "=";
              result += index + 2 < bytes.length ? __base64Alphabet[chunk & 63] : "=";
            }
            return result;
          };

          const __decodeBase64 = (base64) => {
            const normalized = String(base64).replace(/\\s+/g, "");
            const output = [];
            for (let index = 0; index < normalized.length; index += 4) {
              const a = __base64Alphabet.indexOf(normalized[index] ?? "A");
              const b = __base64Alphabet.indexOf(normalized[index + 1] ?? "A");
              const c =
                normalized[index + 2] === "="
                  ? 64
                  : __base64Alphabet.indexOf(normalized[index + 2] ?? "A");
              const d =
                normalized[index + 3] === "="
                  ? 64
                  : __base64Alphabet.indexOf(normalized[index + 3] ?? "A");
              const chunk = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
              output.push((chunk >> 16) & 255);
              if (c !== 64) {
                output.push((chunk >> 8) & 255);
              }
              if (d !== 64) {
                output.push(chunk & 255);
              }
            }
            return new Uint8Array(output);
          };

          globalThis.URL ??= class URL {
            constructor(value, base) {
              this.href = base === undefined ? String(value) : String(base) + String(value);
            }

            toJSON() {
              return this.href;
            }

            toString() {
              return this.href;
            }
          };

          globalThis.Buffer ??= class Buffer extends Uint8Array {
            constructor(value, byteOffset, length) {
              if (typeof value === "number") {
                super(value);
                return;
              }
              if (value instanceof ArrayBuffer) {
                super(value, byteOffset, length);
                return;
              }
              if (ArrayBuffer.isView(value)) {
                super(value.buffer, value.byteOffset, value.byteLength);
                return;
              }
              super(value);
            }

            static from(value, encodingOrOffset, length) {
              if (typeof value === "string") {
                if (encodingOrOffset !== undefined && encodingOrOffset !== "base64") {
                  throw new Error("QuickJS Buffer only supports base64 string input");
                }
                return new Buffer(__decodeBase64(value));
              }
              if (value instanceof ArrayBuffer) {
                return new Buffer(value, encodingOrOffset, length);
              }
              if (ArrayBuffer.isView(value)) {
                return new Buffer(
                  value.buffer.slice(
                    value.byteOffset,
                    value.byteOffset + value.byteLength,
                  ),
                );
              }
              if (Array.isArray(value)) {
                return new Buffer(value);
              }
              throw new TypeError("Unsupported Buffer.from input");
            }

            toString(encoding) {
              if (encoding === undefined || encoding === "utf8") {
                return Array.from(this)
                  .map((value) => String.fromCharCode(value))
                  .join("");
              }
              if (encoding === "base64") {
                return __encodeBase64(this);
              }
              throw new Error("QuickJS Buffer only supports utf8 and base64 output");
            }
          };

          globalThis.performance ??= {
            now: () => Date.now() - __performanceOrigin,
            timeOrigin: __performanceOrigin,
          };
          globalThis.global = globalThis;
        `,
        {
          filename: "quickjs-runtime.js",
        }
      );

      const bundleCode = await getSandboxClientBundleCode();
      const bundleFactorySource = JSON.stringify(`${bundleCode}\nreturn __PlaywrightClient;`);
      this.#host.executeScriptSync(
        `
          globalThis.__createPlaywrightClient = () => {
            return new Function(${bundleFactorySource})();
          };
        `,
        {
          filename: "sandbox-client.js",
        }
      );

      const browserEntry = this.#options.manager.getBrowser(this.#options.browserName);
      if (!browserEntry) {
        throw new Error(
          `Browser "${this.#options.browserName}" not found. It should have been created before script execution.`
        );
      }
      this.#hostBridge = new HostBridge({
        sendToSandbox: (json) => {
          this.#transportInbox.push(json);
          if (this.#transportReady) {
            void this.#flushTransportQueue().catch((error: unknown) => {
              this.#asyncError ??= normalizeError(error);
            });
          }
        },
        preLaunchedBrowser: toServerImpl(browserEntry.browser, "Playwright browser"),
        sharedBrowser: true,
        denyLaunch: true,
      });

      // Compute per-action timeout proportional to script timeout.
      // This ensures a bad selector fails with a specific Playwright error
      // before the script wall-clock timeout kills the whole script.
      const actionTimeoutMs = this.#options.timeoutMs !== undefined
        ? Math.min(Math.floor(this.#options.timeoutMs * 0.6), 8000)
        : undefined;

      await this.#host.executeScript(
        `
          (() => {
            const hostCall = globalThis.__hostCall;
            const transportSend = globalThis.__transport_send;
            const createPlaywrightClient = globalThis.__createPlaywrightClient;

            if (typeof hostCall !== "function") {
              throw new Error("Sandbox bridge did not expose a host-call function");
            }
            if (typeof transportSend !== "function") {
              throw new Error("Sandbox bridge did not expose a transport sender");
            }
            if (typeof createPlaywrightClient !== "function") {
              throw new Error("Sandbox client bundle did not expose a Playwright client factory");
            }

            if (!delete globalThis.__hostCall) {
              globalThis.__hostCall = undefined;
            }
            if (!delete globalThis.__transport_send) {
              globalThis.__transport_send = undefined;
            }
            if (!delete globalThis.__createPlaywrightClient) {
              globalThis.__createPlaywrightClient = undefined;
            }

            const playwrightClient = createPlaywrightClient();
            const connection = new playwrightClient.Connection(playwrightClient.quickjsPlatform);
            connection.onmessage = (message) => {
              transportSend(JSON.stringify(message));
            };

            Object.defineProperty(globalThis, "${TRANSPORT_RECEIVE_GLOBAL}", {
              value: (json) => {
                connection.dispatch(JSON.parse(json));
              },
              configurable: false,
              enumerable: false,
              writable: false,
            });

            const waitForConnectionObject = async (guid, label) => {
              if (typeof guid !== "string" || guid.length === 0) {
                throw new Error(\`\${label} did not return a valid guid\`);
              }

              for (let attempt = 0; attempt < ${WAIT_FOR_OBJECT_ATTEMPTS}; attempt += 1) {
                const object = connection.getObjectWithKnownName(guid);
                if (object) {
                  return object;
                }
                await new Promise((resolve) => setTimeout(resolve, 0));
              }

              throw new Error(\`Timed out waiting for \${label} (\${guid}) in the sandbox\`);
            };

            const encodeHostFilePayload = (value) => {
              if (typeof value === "string") {
                return { encoding: "utf8", data: value };
              }
              if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                return { encoding: "base64", data: Buffer.from(value).toString("base64") };
              }
              throw new TypeError(
                "File data must be a string, Buffer, Uint8Array, or ArrayBuffer",
              );
            };

            return (async () => {
              await connection.initializePlaywright();

              const browserApi = Object.create(null);
              Object.defineProperties(browserApi, {
                getPage: {
                  value: async (name) => {
                    const guid = await hostCall("getPage", JSON.stringify([name]));
                    const page = await waitForConnectionObject(guid, \`page "\${name}"\`);
                    ${actionTimeoutMs !== undefined ? `if (typeof page.setDefaultTimeout === "function") { page.setDefaultTimeout(${actionTimeoutMs}); }` : ""}
                    return page;
                  },
                  enumerable: true,
                },
                newPage: {
                  value: async () => {
                    const guid = await hostCall("newPage", JSON.stringify([]));
                    const page = await waitForConnectionObject(guid, "anonymous page");
                    ${actionTimeoutMs !== undefined ? `if (typeof page.setDefaultTimeout === "function") { page.setDefaultTimeout(${actionTimeoutMs}); }` : ""}
                    return page;
                  },
                  enumerable: true,
                },
                listPages: {
                  value: async () => {
                    return await hostCall("listPages", JSON.stringify([]));
                  },
                  enumerable: true,
                },
                closePage: {
                  value: async (name) => {
                    await hostCall("closePage", JSON.stringify([name]));
                  },
                  enumerable: true,
                },
                getPageElements: {
                  value: async (pageName, options) => {
                    const raw = await hostCall(
                      "getPageElements",
                      JSON.stringify([pageName, options ?? {}])
                    );
                    return typeof raw === "string" ? JSON.parse(raw) : raw;
                  },
                  enumerable: true,
                },
                waitForSettled: {
                  value: async (pageName, options) => {
                    const raw = await hostCall(
                      "waitForSettled",
                      JSON.stringify([pageName, options ?? {}])
                    );
                    return typeof raw === "string" ? JSON.parse(raw) : raw;
                  },
                  enumerable: true,
                },
                clickElement: {
                  value: async (pageName, selector, action) => {
                    const raw = await hostCall(
                      "clickElement",
                      JSON.stringify([pageName, selector, action ?? "click"])
                    );
                    return typeof raw === "string" ? JSON.parse(raw) : raw;
                  },
                  enumerable: true,
                },
                fillElement: {
                  value: async (pageName, selector, value) => {
                    const raw = await hostCall(
                      "fillElement",
                      JSON.stringify([pageName, selector, value])
                    );
                    return typeof raw === "string" ? JSON.parse(raw) : raw;
                  },
                  enumerable: true,
                },
                selectOption: {
                  value: async (pageName, selector, optionValue) => {
                    const raw = await hostCall(
                      "selectOption",
                      JSON.stringify([pageName, selector, optionValue])
                    );
                    return typeof raw === "string" ? JSON.parse(raw) : raw;
                  },
                  enumerable: true,
                },
                checkElement: {
                  value: async (pageName, selector, checked) => {
                    const raw = await hostCall(
                      "checkElement",
                      JSON.stringify([pageName, selector, checked])
                    );
                    return typeof raw === "string" ? JSON.parse(raw) : raw;
                  },
                  enumerable: true,
                },
                // --- Coordinate-based actions (for canvas/WebGL apps) ---
                clickAt: {
                  value: async (pageName, x, y, options) => {
                    const raw = await hostCall(
                      "clickAt",
                      JSON.stringify([pageName, x, y, options ?? {}])
                    );
                    return typeof raw === "string" ? JSON.parse(raw) : raw;
                  },
                  enumerable: true,
                },
                drag: {
                  value: async (pageName, fromX, fromY, toX, toY, options) => {
                    const raw = await hostCall(
                      "drag",
                      JSON.stringify([pageName, fromX, fromY, toX, toY, options ?? {}])
                    );
                    return typeof raw === "string" ? JSON.parse(raw) : raw;
                  },
                  enumerable: true,
                },
                // --- Unified high-level API ---
                // These combine settle + discover + act into simpler calls.
                // The LLM uses discover() once, then click/type/select by index.

                discover: {
                  value: async (pageName, options) => {
                    // Settle + discover in one call (no navigation — keep concerns separate)
                    await hostCall("waitForSettled", JSON.stringify([pageName, { quietMs: options?.quietMs ?? 300, timeout: options?.settleTimeout ?? 3000 }]));
                    const raw = await hostCall("getPageElements", JSON.stringify([pageName, options ?? {}]));
                    const result = typeof raw === "string" ? JSON.parse(raw) : raw;
                    return result;
                  },
                  enumerable: true,
                },
                click: {
                  value: async (pageName, indexOrSelector) => {
                    // Click by discovery index (number) or CSS selector/xpath (string)
                    if (typeof indexOrSelector === "number") {
                      // Resolve backendNodeId from last discover() result
                      const raw = await hostCall("clickByIndex", JSON.stringify([pageName, indexOrSelector]));
                      return typeof raw === "string" ? JSON.parse(raw) : raw;
                    }
                    // Fall back to selector-based click
                    const raw = await hostCall("clickElement", JSON.stringify([pageName, indexOrSelector, "click"]));
                    return typeof raw === "string" ? JSON.parse(raw) : raw;
                  },
                  enumerable: true,
                },
                type: {
                  value: async (pageName, indexOrSelector, text, options) => {
                    if (typeof indexOrSelector === "number") {
                      const raw = await hostCall("typeByIndex", JSON.stringify([pageName, indexOrSelector, text, options ?? {}]));
                      return typeof raw === "string" ? JSON.parse(raw) : raw;
                    }
                    const raw = await hostCall("fillElement", JSON.stringify([pageName, indexOrSelector, text]));
                    return typeof raw === "string" ? JSON.parse(raw) : raw;
                  },
                  enumerable: true,
                },
                select: {
                  value: async (pageName, indexOrSelector, value) => {
                    if (typeof indexOrSelector === "number") {
                      // Resolve selector from last discover() then select
                      const raw = await hostCall("selectByIndex", JSON.stringify([pageName, indexOrSelector, value]));
                      return typeof raw === "string" ? JSON.parse(raw) : raw;
                    }
                    const raw = await hostCall("selectOption", JSON.stringify([pageName, indexOrSelector, value]));
                    return typeof raw === "string" ? JSON.parse(raw) : raw;
                  },
                  enumerable: true,
                },
                check: {
                  value: async (pageName, indexOrSelector, checked) => {
                    if (typeof indexOrSelector === "number") {
                      const raw = await hostCall("checkByIndex", JSON.stringify([pageName, indexOrSelector, checked]));
                      return typeof raw === "string" ? JSON.parse(raw) : raw;
                    }
                    const raw = await hostCall("checkElement", JSON.stringify([pageName, indexOrSelector, checked]));
                    return typeof raw === "string" ? JSON.parse(raw) : raw;
                  },
                  enumerable: true,
                },
              });
              Object.freeze(browserApi);

              Object.defineProperty(globalThis, "browser", {
                value: browserApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });

              Object.defineProperties(globalThis, {
                saveScreenshot: {
                  value: async (buffer, name) => {
                    return await hostCall(
                      "saveScreenshot",
                      JSON.stringify([name, encodeHostFilePayload(buffer)]),
                    );
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
                writeFile: {
                  value: async (name, data) => {
                    return await hostCall(
                      "writeFile",
                      JSON.stringify([name, encodeHostFilePayload(data)]),
                    );
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
                readFile: {
                  value: async (name, options) => {
                    return await hostCall("readFile", JSON.stringify([name, options ?? null]));
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
                resolveFilePath: {
                  value: async (name) => {
                    return await hostCall("resolveFilePath", JSON.stringify([name]));
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
                deleteFile: {
                  value: async (name) => {
                    await hostCall("deleteFile", JSON.stringify([name]));
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
              });
            })();
          })()
        `,
        {
          filename: "sandbox-init.js",
        }
      );

      this.#transportReady = true;
      await this.#flushTransportQueue();
      this.#throwIfAsyncError();
      this.#initialized = true;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async executeScript(script: string): Promise<void> {
    this.#assertInitialized();
    let executionError: unknown;

    try {
      this.#throwIfAsyncError();

      await this.#host!.executeScript(
        wrapScriptWithWallClockTimeout(script, this.#options.timeoutMs),
        {
          filename: "user-script.js",
        }
      );

      await this.#flushTransportQueue();
      this.#throwIfAsyncError();
    } catch (error) {
      executionError = error;
    }

    try {
      await this.#cleanupAnonymousPages();
    } catch (error) {
      executionError ??= error;
    }

    if (executionError) {
      throw executionError;
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;

    await this.#cleanupAnonymousPages({
      suppressErrors: true,
    });

    this.#transportInbox.length = 0;
    this.#pendingHostOperations.clear();

    try {
      await this.#hostBridge?.dispose();
    } catch {
      // Best effort cleanup during sandbox teardown.
    } finally {
      this.#hostBridge = undefined;
      await this.#host?.dispose();
      this.#host = undefined;
      this.#transportReady = false;
      this.#flushPromise = undefined;
    }
  }

  #routeConsole(level: QuickJSConsoleLevel, args: unknown[]): void {
    const line = `${formatArgs(args)}\n`;
    if (level === "warn" || level === "error") {
      this.#options.onStderr(line);
      return;
    }

    this.#options.onStdout(line);
  }

  #handleTransportSend(message: string): void {
    if (!this.#hostBridge) {
      this.#asyncError ??= new Error("Sandbox transport is not initialized");
      return;
    }

    const operation = this.#hostBridge
      .receiveFromSandbox(message)
      .catch((error: unknown) => {
        this.#asyncError ??= normalizeError(error);
      })
      .finally(() => {
        this.#pendingHostOperations.delete(operation);
      });

    this.#pendingHostOperations.add(operation);
  }

  async #drainAsyncOps(): Promise<void> {
    this.#throwIfAsyncError();
    await this.#flushTransportQueue();
    this.#throwIfAsyncError();

    if (this.#pendingHostOperations.size === 0) {
      return;
    }

    await Promise.race(this.#pendingHostOperations);
    this.#throwIfAsyncError();
    await this.#flushTransportQueue();
    this.#throwIfAsyncError();
  }

  async #flushTransportQueue(): Promise<void> {
    this.#throwIfAsyncError();
    if (!this.#host || this.#transportInbox.length === 0) {
      return;
    }

    if (this.#flushPromise) {
      await this.#flushPromise;
      return;
    }

    const flush = async () => {
      while (this.#transportInbox.length > 0) {
        const message = this.#transportInbox.shift();
        if (message === undefined) {
          continue;
        }

        await this.#host!.callFunction(TRANSPORT_RECEIVE_GLOBAL, message);
        this.#throwIfAsyncError();
      }
    };

    this.#flushPromise = flush().finally(() => {
      this.#flushPromise = undefined;
    });
    await this.#flushPromise;
  }

  async #getPage(name: unknown): Promise<string> {
    const page = await this.#options.manager.getPage(
      this.#options.browserName,
      requireString(name, "Page name or targetId")
    );
    return extractGuid(page);
  }

  async #newPage(): Promise<string> {
    const page = await this.#options.manager.newPage(this.#options.browserName);
    this.#anonymousPages.add(page);
    page.on("close", () => {
      this.#anonymousPages.delete(page);
    });
    return extractGuid(page);
  }

  async #closePage(name: unknown): Promise<void> {
    await this.#options.manager.closePage(
      this.#options.browserName,
      requireString(name, "Page name")
    );
  }

  // Discover state is stored in BrowserManager so it persists across script executions.
  // This enables individual CLI commands: `discover` then `click 3` in separate invocations.

  async #getPageElements(
    name: unknown,
    options: unknown
  ): Promise<string> {
    const pageName = requireString(name, "Page name or targetId");
    const page = await this.#options.manager.getPage(
      this.#options.browserName,
      pageName
    );
    const opts =
      typeof options === "string" ? JSON.parse(options) : options ?? {};

    // Use CDP-based detection (asks Chrome what's interactive instead of guessing)
    const browserName = this.#options.browserName;
    const { result, currentSelectors } = await getPageElementsCDP(
      page as Page,
      {
        maxElements: opts.maxElements,
        maxTextLength: opts.maxTextLength,
        includePaintOrder: opts.includePaintOrder,
      },
      this.#options.manager.getPreviousSelectors(browserName, pageName)
    );

    // Store current selectors for next diff (persists across script executions)
    this.#options.manager.setPreviousSelectors(browserName, pageName, currentSelectors);

    // Store elements for index-based actions (persists across script executions)
    this.#options.manager.setDiscoverResult(
      browserName,
      pageName,
      result.elements.map((e: { index: number; backendNodeId: number; selector: string; role: string; name: string; tag: string }) => ({
        backendNodeId: e.backendNodeId,
        selector: e.selector,
        role: e.role,
        name: e.name,
        tag: e.tag,
      })),
      (page as Page).url()
    );

    return JSON.stringify(result);
  }

  async #clickElement(
    name: unknown,
    selector: unknown,
    action: unknown
  ): Promise<string> {
    const page = await this.#options.manager.getPage(
      this.#options.browserName,
      requireString(name, "Page name or targetId")
    );
    const sel = requireString(selector, "CSS selector or xpath");
    const act = typeof action === "string" ? action : "click";

    // Try CSS selector first via page.evaluate
    let scriptCall = `(${CLICK_ELEMENT_SCRIPT})(${JSON.stringify(sel)}, ${JSON.stringify(act)})`;
    let result = await (page as Page).evaluate(scriptCall) as { success: boolean; error?: string };

    // If CSS selector fails and we got an xpath, try that
    if (!result.success && sel.startsWith("/")) {
      scriptCall = `(${CLICK_ELEMENT_SCRIPT})(null, ${JSON.stringify(act)})`.replace(
        "document.querySelector(selector)",
        `document.evaluate(${JSON.stringify(sel)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`
      );
      // Simpler approach: use evaluate with xpath directly
      const xpathClick = `
        (() => {
          var el = document.evaluate(${JSON.stringify(sel)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          if (!el) return { success: false, error: "XPath not found: ${sel}" };
          try {
            var event = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, detail: 1, view: window });
            el.dispatchEvent(event);
            return { success: true, tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().substring(0, 100) };
          } catch(e) { return { success: false, error: e.message }; }
        })()
      `;
      result = await (page as Page).evaluate(xpathClick) as { success: boolean; error?: string };
    }

    return JSON.stringify(result);
  }

  async #fillElement(
    name: unknown,
    selector: unknown,
    value: unknown
  ): Promise<string> {
    const page = await this.#options.manager.getPage(
      this.#options.browserName,
      requireString(name, "Page name or targetId")
    );
    const sel = requireString(selector, "CSS selector");
    const val = typeof value === "string" ? value : String(value ?? "");
    const scriptCall = `(${FILL_ELEMENT_SCRIPT})(${JSON.stringify(sel)}, ${JSON.stringify(val)})`;
    const result = await (page as Page).evaluate(scriptCall);
    return JSON.stringify(result);
  }

  async #selectOption(
    name: unknown,
    selector: unknown,
    value: unknown
  ): Promise<string> {
    const page = await this.#options.manager.getPage(
      this.#options.browserName,
      requireString(name, "Page name or targetId")
    );
    const sel = requireString(selector, "CSS selector");
    const val = typeof value === "string" ? value : String(value ?? "");
    const scriptCall = `(${SELECT_OPTION_SCRIPT})(${JSON.stringify(sel)}, ${JSON.stringify(val)})`;
    const result = await (page as Page).evaluate(scriptCall);
    return JSON.stringify(result);
  }

  async #checkElement(
    name: unknown,
    selector: unknown,
    checked: unknown
  ): Promise<string> {
    const page = await this.#options.manager.getPage(
      this.#options.browserName,
      requireString(name, "Page name or targetId")
    );
    const sel = requireString(selector, "CSS selector");
    const chk = typeof checked === "boolean" ? checked : undefined;
    const scriptCall = `(${CHECK_ELEMENT_SCRIPT})(${JSON.stringify(sel)}, ${chk === undefined ? "undefined" : JSON.stringify(chk)})`;
    const result = await (page as Page).evaluate(scriptCall);
    return JSON.stringify(result);
  }

  async #waitForSettled(
    name: unknown,
    options: unknown
  ): Promise<string> {
    const page = await this.#options.manager.getPage(
      this.#options.browserName,
      requireString(name, "Page name or targetId")
    );
    const opts =
      typeof options === "string" ? JSON.parse(options) : options ?? {};

    // Use CDP network settlement — tracks actual HTTP
    // requests, not just DOM mutations. More reliable for SPAs.
    const session = (await (page as Page).context().newCDPSession(page as Page)) as unknown as DOMCDPSession;
    try {
      const result = await waitForNetworkIdle(session, {
        quietMs: opts.quietMs,
        timeout: opts.timeout,
      });
      return JSON.stringify(result);
    } finally {
      await session.detach().catch(() => {});
    }
  }

  /**
   * Resolve a discover() index to element data and perform an action.
   * The LLM calls browser.click("main", 3) → resolves index 3 to backendNodeId → CDP click.
   */
  async #actionByIndex(
    name: unknown,
    index: unknown,
    action: "click" | "type" | "select" | "check",
    value?: unknown,
    options?: unknown
  ): Promise<string> {
    const pageName = requireString(name, "Page name or targetId");
    const idx = typeof index === "number" ? index : parseInt(String(index), 10);
    const browserName = this.#options.browserName;

    // Auto re-discover if page URL changed since last discover (live indices)
    let elements = this.#options.manager.getDiscoverResult(browserName, pageName);
    const discoverUrl = this.#options.manager.getDiscoverUrl(browserName, pageName);
    if (elements) {
      try {
        const page = await this.#options.manager.getPage(browserName, pageName);
        const currentUrl = (page as Page).url();
        if (discoverUrl && currentUrl !== discoverUrl) {
          // Page navigated since last discover — re-discover automatically
          await this.#getPageElements(name, "{}");
          elements = this.#options.manager.getDiscoverResult(browserName, pageName);
        }
      } catch {
        // If we can't get the page, proceed with stale elements
      }
    }

    if (!elements) {
      let currentUrl = "";
      try {
        const p = await this.#options.manager.getPage(browserName, pageName);
        currentUrl = (p as Page).url();
      } catch { /* page may not exist yet */ }
      return JSON.stringify({
        success: false,
        error: `No discover result for page "${pageName}". Run discover first.${currentUrl ? ` Current URL: ${currentUrl}` : ""}`,
      });
    }

    const el = elements[idx - 1]; // indices are 1-based
    if (!el) {
      return JSON.stringify({
        success: false,
        error: `Element [${idx}] not found, ${elements.length} elements available (1-${elements.length}).`,
      });
    }

    const page = await this.#options.manager.getPage(
      this.#options.browserName,
      pageName
    );

    // Element context for response (helps LLM know what it acted on)
    const elContext = {
      index: idx,
      tag: el.tag,
      role: el.role,
      name: el.name ? el.name.substring(0, 60) : undefined,
    };

    if (action === "click") {
      if (this.#options.humanize) {
        await humanDelay(80, 400);
      }
      const urlBefore = (page as Page).url();
      const session = (await (page as Page).context().newCDPSession(page as Page)) as unknown as DOMCDPSession;
      try {
        await session.send("DOM.enable");
        const result = await cdpClick(session, el.backendNodeId);
        // If click triggered navigation, wait for the new page to load
        try {
          const urlAfter = (page as Page).url();
          if (urlAfter !== urlBefore) {
            await (page as Page).waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
          }
        } catch {
          // Ignore navigation wait errors
        }
        return JSON.stringify({ ...result, element: elContext });
      } finally {
        await session.detach().catch(() => {});
      }
    }

    if (action === "type") {
      const text = typeof value === "string" ? value : String(value ?? "");
      const opts = typeof options === "string" ? JSON.parse(options) : options ?? {};
      // Validate: warn if typing into a non-text element
      const textRoles = new Set(["textbox", "searchbox", "combobox", ""]);
      const textTags = new Set(["input", "textarea"]);
      if (!textTags.has(el.tag) && !textRoles.has(el.role)) {
        return JSON.stringify({
          success: false,
          error: `Element [${idx}] is ${el.role || el.tag} "${el.name?.substring(0, 40) || ""}", expected text input`,
          element: elContext,
        });
      }
      if (this.#options.humanize) {
        await humanDelay(60, 250);
      }
      const session = (await (page as Page).context().newCDPSession(page as Page)) as unknown as DOMCDPSession;
      try {
        await session.send("DOM.enable");
        const result = await cdpType(session, el.backendNodeId, text, {
          clearFirst: opts.clearFirst,
          delay: this.#options.humanize ? 30 + Math.floor(Math.random() * 90) : opts.delay,
        });
        return JSON.stringify({ ...result, element: elContext });
      } finally {
        await session.detach().catch(() => {});
      }
    }

    if (action === "select") {
      if (this.#options.humanize) {
        await humanDelay(80, 350);
      }
      if (el.tag !== "select" && el.role !== "listbox" && el.role !== "combobox") {
        return JSON.stringify({
          success: false,
          error: `Element [${idx}] is ${el.role || el.tag} "${el.name?.substring(0, 40) || ""}", expected select/dropdown`,
          element: elContext,
        });
      }
      const val = typeof value === "string" ? value : String(value ?? "");
      const scriptCall = `(${SELECT_OPTION_SCRIPT})(${JSON.stringify(el.selector)}, ${JSON.stringify(val)})`;
      const result = await (page as Page).evaluate(scriptCall);
      return JSON.stringify({ ...(result as object), element: elContext });
    }

    if (action === "check") {
      if (this.#options.humanize) {
        await humanDelay(80, 350);
      }
      if (el.tag !== "input" && el.role !== "checkbox" && el.role !== "radio" && el.role !== "switch") {
        return JSON.stringify({
          success: false,
          error: `Element [${idx}] is ${el.role || el.tag} "${el.name?.substring(0, 40) || ""}", expected checkbox/radio`,
          element: elContext,
        });
      }
      const checked = typeof value === "boolean" ? value : undefined;
      const scriptCall = `(${CHECK_ELEMENT_SCRIPT})(${JSON.stringify(el.selector)}, ${checked === undefined ? "undefined" : JSON.stringify(checked)})`;
      const result = await (page as Page).evaluate(scriptCall);
      return JSON.stringify({ ...(result as object), element: elContext });
    }

    return JSON.stringify({ success: false, error: `Unknown action: ${action}` });
  }

  async #clickAt(
    name: unknown,
    x: unknown,
    y: unknown,
    options: unknown
  ): Promise<string> {
    const page = await this.#options.manager.getPage(
      this.#options.browserName,
      requireString(name, "Page name or targetId")
    );
    const px = typeof x === "number" ? x : parseFloat(String(x));
    const py = typeof y === "number" ? y : parseFloat(String(y));
    const opts = typeof options === "string" ? JSON.parse(options) : options ?? {};
    const session = (await (page as Page).context().newCDPSession(page as Page)) as unknown as DOMCDPSession;
    try {
      const result = await cdpClickAt(session, px, py, {
        button: opts.button,
        doubleClick: opts.doubleClick,
      });
      return JSON.stringify(result);
    } finally {
      await session.detach().catch(() => {});
    }
  }

  async #drag(
    name: unknown,
    fromX: unknown,
    fromY: unknown,
    toX: unknown,
    toY: unknown,
    options: unknown
  ): Promise<string> {
    const page = await this.#options.manager.getPage(
      this.#options.browserName,
      requireString(name, "Page name or targetId")
    );
    const fx = typeof fromX === "number" ? fromX : parseFloat(String(fromX));
    const fy = typeof fromY === "number" ? fromY : parseFloat(String(fromY));
    const tx = typeof toX === "number" ? toX : parseFloat(String(toX));
    const ty = typeof toY === "number" ? toY : parseFloat(String(toY));
    const opts = typeof options === "string" ? JSON.parse(options) : options ?? {};
    const session = (await (page as Page).context().newCDPSession(page as Page)) as unknown as DOMCDPSession;
    try {
      const result = await cdpDrag(session, fx, fy, tx, ty, { steps: opts.steps });
      return JSON.stringify(result);
    } finally {
      await session.detach().catch(() => {});
    }
  }

  async #writeTempFile(name: unknown, payload: unknown): Promise<string> {
    return await writeWebInteractTempFile(
      requireString(name, "File name"),
      decodeSandboxFilePayload(payload, "File data")
    );
  }

  async #readTempFile(name: unknown, options: unknown): Promise<string> {
    const { encoding } = parseSandboxFileReadOptions(options);
    const fileName = requireString(name, "File name");
    if (encoding === "base64") {
      return Buffer.from(await readWebInteractTempFileBytes(fileName)).toString("base64");
    }
    return await readWebInteractTempFile(fileName);
  }

  async #resolveTempFilePath(name: unknown): Promise<string> {
    return await resolveWebInteractTempPath(requireString(name, "File name"), {
      createParents: true,
    });
  }

  async #deleteTempFile(name: unknown): Promise<void> {
    await deleteWebInteractTempFile(requireString(name, "File name"));
  }

  async #cleanupAnonymousPages(options: { suppressErrors?: boolean } = {}): Promise<void> {
    const anonymousPages = [...this.#anonymousPages];
    this.#anonymousPages.clear();

    for (const page of anonymousPages) {
      try {
        if (!page.isClosed()) {
          await page.close();
        }
      } catch (error) {
        if (!options.suppressErrors) {
          throw error;
        }
      }
    }

    if (options.suppressErrors) {
      try {
        await this.#flushTransportQueue();
      } catch {
        // Best effort cleanup during sandbox teardown.
      }
      return;
    }

    await this.#flushTransportQueue();
    this.#throwIfAsyncError();
  }

  #throwIfAsyncError(): void {
    if (this.#asyncError) {
      throw this.#asyncError;
    }
  }

  #assertAlive(): void {
    if (this.#disposed) {
      throw new Error("QuickJS sandbox has been disposed");
    }
  }

  #assertInitialized(): void {
    this.#assertAlive();
    if (!this.#initialized || !this.#host || !this.#hostBridge) {
      throw new Error("QuickJS sandbox has not been initialized");
    }
  }
}
