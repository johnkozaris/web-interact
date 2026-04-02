import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BrowserManager } from "./browser-manager.js";
import { createKeyedLock, createMutex } from "./lock.js";
import {
  getBrowsersDir,
  getDaemonEndpoint,
  getWebInteractBaseDir,
  getPidPath,
  readMode,
  requiresDaemonEndpointCleanup,
} from "./local-endpoint.js";
import { parseRequest, serialize, type ExecuteRequest, type Response } from "./protocol.js";
import { runScript } from "./sandbox/script-runner-quickjs.js";
import { ensureWebInteractTempDir } from "./temp-files.js";

const BASE_DIR = getWebInteractBaseDir();
const SOCKET_PATH = getDaemonEndpoint();
const PID_PATH = getPidPath();
const BROWSERS_DIR = getBrowsersDir();
const DEFAULT_SCRIPT_TIMEOUT_MS = 20_000;
const SOCKET_CLOSE_TIMEOUT_MS = 500;
const EMBEDDED_PACKAGE_JSON = JSON.stringify(
  {
    name: "web-interact-runtime",
    private: true,
    type: "module",
    packageManager: "pnpm@10.33.0",
    dependencies: {
      patchright: "1.59.1",
      "patchright-core": "1.59.1",
      "quickjs-emscripten": "0.32.0",
    },
  },
  null,
  2
);

type PackageManagerCommand = {
  program: string;
  prefixArgs: string[];
  displayName: string;
};

const manager = new BrowserManager(BROWSERS_DIR);
const startedAt = Date.now();
const withBrowserLock = createKeyedLock<string>();
const withInstallLock = createMutex();
const clients = new Set<net.Socket>();

let server: net.Server | null = null;
let shuttingDown: Promise<void> | null = null;

function formatError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "ScriptTimeoutError" || error.name === "ActionError") {
      return error.message;
    }
    return error.stack ?? error.message;
  }

  // Handle plain objects with message property (e.g. ActionError from QuickJS sandbox)
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }

  return String(error);
}

async function writeMessage(socket: net.Socket, message: Response): Promise<void> {
  if (socket.destroyed) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const payload = serialize(message);
    socket.write(payload, (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function closeServerInstance(serverToClose: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    serverToClose.close(() => {
      resolve();
    });
  });
}

async function closeClientSocket(socket: net.Socket): Promise<void> {
  if (socket.destroyed) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }, SOCKET_CLOSE_TIMEOUT_MS);
    timeout.unref();

    const finish = () => {
      clearTimeout(timeout);
      resolve();
    };

    socket.once("close", finish);
    socket.once("error", finish);
    socket.end();
  });
}

function createMessageQueue(socket: net.Socket) {
  let queue = Promise.resolve();

  return {
    push(message: Response): Promise<void> {
      queue = queue.then(() => writeMessage(socket, message)).catch(() => undefined);
      return queue;
    },
    async drain(): Promise<void> {
      await queue;
    },
  };
}

async function handleExecute(socket: net.Socket, request: ExecuteRequest): Promise<void> {
  await withBrowserLock(request.browser, async () => {
    const output = createMessageQueue(socket);
    const timeoutMs = request.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;

    try {
      if (request.connect === "auto") {
        await manager.autoConnect(request.browser);
      } else if (request.connect) {
        await manager.connectBrowser(request.browser, request.connect);
      } else {
        await manager.ensureBrowser(request.browser, {
          headless: request.headless,
          ignoreHTTPSErrors: request.ignoreHTTPSErrors,
        });
      }

      await runScript(
        request.script,
        manager,
        request.browser,
        {
          onStdout: (data) => {
            void output.push({
              id: request.id,
              type: "stdout",
              data,
            });
          },
          onStderr: (data) => {
            void output.push({
              id: request.id,
              type: "stderr",
              data,
            });
          },
        },
        {
          timeout: timeoutMs,
          humanize: request.humanize,
        }
      );

      await output.drain();
      await writeMessage(socket, {
        id: request.id,
        type: "complete",
        success: true,
      });
    } catch (error) {
      await output.drain().catch(() => undefined);
      await writeMessage(socket, {
        id: request.id,
        type: "error",
        message: formatError(error),
      });
    }
  });
}

async function handleInstall(socket: net.Socket, request: { id: string }): Promise<void> {
  await withInstallLock(async () => {
    const output = createMessageQueue(socket);
    try {
      await mkdir(BASE_DIR, { recursive: true });
      await writeFile(path.join(BASE_DIR, "package.json"), EMBEDDED_PACKAGE_JSON);
      await runPackageManagerCommand(output, request.id, ["install", "--ignore-scripts"], BASE_DIR);

      if (!systemBrowserExists()) {
        const mode = readMode();
        const browserCli = mode === "assistant" ? "patchright" : "playwright";
        await runPackageManagerCommand(
          output,
          request.id,
          ["exec", browserCli, "install", "chromium"],
          BASE_DIR
        );
      }
      await writeMessage(socket, {
        id: request.id,
        type: "complete",
        success: true,
      });
    } catch (error) {
      await output.drain().catch(() => undefined);
      await writeMessage(socket, {
        id: request.id,
        type: "error",
        message: formatError(error),
      });
    }
  });
}

function getPackageManagerCandidates(): PackageManagerCommand[] {
  if (process.platform === "win32") {
    return [
      { program: "pnpm.cmd", prefixArgs: [], displayName: "pnpm" },
      { program: "corepack.cmd", prefixArgs: ["pnpm"], displayName: "corepack pnpm" },
    ];
  }

  return [
    { program: "pnpm", prefixArgs: [], displayName: "pnpm" },
    { program: "corepack", prefixArgs: ["pnpm"], displayName: "corepack pnpm" },
  ];
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function runPackageManagerCommand(
  output: ReturnType<typeof createMessageQueue>,
  requestId: string,
  args: string[],
  cwd: string
): Promise<void> {
  for (const command of getPackageManagerCandidates()) {
    const fullArgs = [...command.prefixArgs, ...args];
    try {
      await runInstallCommand(
        output,
        requestId,
        command.program,
        fullArgs,
        cwd,
        `${command.displayName} ${args.join(" ")}`
      );
      return;
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    `Could not find \`pnpm\` or \`corepack\` in PATH while setting up the embedded daemon runtime in ${cwd}. Install pnpm 10 or enable Corepack and try again.`
  );
}

async function runInstallCommand(
  output: ReturnType<typeof createMessageQueue>,
  requestId: string,
  program: string,
  args: string[],
  cwd: string,
  label: string
): Promise<void> {
  const child = spawn(program, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (data: string) => {
    void output.push({
      id: requestId,
      type: "stdout",
      data,
    });
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (data: string) => {
    void output.push({
      id: requestId,
      type: "stderr",
      data,
    });
  });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    }
  );

  await output.drain();

  if (result.code === 0) {
    return;
  }

  const reason =
    result.signal !== null
      ? `${label} terminated by signal ${result.signal}`
      : `${label} failed with exit code ${result.code ?? "unknown"}`;

  throw new Error(reason);
}

function systemBrowserPaths(): string[] {
  const platform = os.platform();
  const home = os.homedir();

  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ];
  }

  if (platform === "linux") {
    return [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/snap/bin/chromium",
    ];
  }

  if (platform === "win32") {
    return [
      path.win32.join(home, "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
  }

  return [];
}

function systemBrowserExists(): boolean {
  return systemBrowserPaths().some((p) => existsSync(p));
}

async function handleRequest(socket: net.Socket, line: string): Promise<void> {
  const parsed = parseRequest(line);
  if (!parsed.success) {
    await writeMessage(socket, {
      id: parsed.id ?? "unknown",
      type: "error",
      message: parsed.error,
    });
    return;
  }

  const { request } = parsed;

  if (shuttingDown && request.type !== "stop") {
    await writeMessage(socket, {
      id: request.id,
      type: "error",
      message: "Daemon is shutting down",
    });
    return;
  }

  switch (request.type) {
    case "execute":
      await handleExecute(socket, request);
      return;

    case "browsers":
      await writeMessage(socket, {
        id: request.id,
        type: "result",
        data: manager.listBrowsers(),
      });
      await writeMessage(socket, {
        id: request.id,
        type: "complete",
        success: true,
      });
      return;

    case "browser-stop":
      await manager.stopBrowser(request.browser);
      await writeMessage(socket, {
        id: request.id,
        type: "result",
        data: { browser: request.browser, stopped: true },
      });
      await writeMessage(socket, {
        id: request.id,
        type: "complete",
        success: true,
      });
      return;

    case "status":
      await writeMessage(socket, {
        id: request.id,
        type: "result",
        data: {
          pid: process.pid,
          uptimeMs: Date.now() - startedAt,
          browserCount: manager.browserCount(),
          browsers: manager.listBrowsers(),
          socketPath: SOCKET_PATH,
        },
      });
      await writeMessage(socket, {
        id: request.id,
        type: "complete",
        success: true,
      });
      return;

    case "install":
      await handleInstall(socket, request);
      return;

    case "stop":
      await writeMessage(socket, {
        id: request.id,
        type: "result",
        data: { stopping: true },
      });
      await writeMessage(socket, {
        id: request.id,
        type: "complete",
        success: true,
      });
      void shutdown(0);
      return;
  }
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return shuttingDown;
  }

  shuttingDown = (async () => {
    const serverToClose = server;
    server = null;
    const serverClosed = serverToClose ? closeServerInstance(serverToClose) : Promise.resolve();

    await manager.stopAll();
    await Promise.allSettled(Array.from(clients, (socket) => closeClientSocket(socket)));
    await serverClosed;
    const cleanup = [unlinkIfExists(PID_PATH)];
    if (requiresDaemonEndpointCleanup()) {
      cleanup.push(unlinkIfExists(SOCKET_PATH));
    }
    await Promise.allSettled(cleanup);

    clients.clear();

    process.exit(exitCode);
  })();

  return shuttingDown;
}

async function start(): Promise<void> {
  await mkdir(BASE_DIR, { recursive: true });
  await ensureWebInteractTempDir();
  if (requiresDaemonEndpointCleanup()) {
    await unlinkIfExists(SOCKET_PATH);
  }
  await writeFile(PID_PATH, `${process.pid}\n`);

  server = net.createServer((socket) => {
    if (shuttingDown) {
      socket.end();
      return;
    }

    clients.add(socket);
    socket.setEncoding("utf8");

    let buffer = "";
    let queue = Promise.resolve();

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        queue = queue
          .then(() => handleRequest(socket, line))
          .catch(async (error) => {
            console.error("Request handling error:", error);
            if (!socket.destroyed) {
              await writeMessage(socket, {
                id: "unknown",
                type: "error",
                message: formatError(error),
              });
            }
          });
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
    });

    socket.on("error", () => {
      clients.delete(socket);
    });
  });

  server.on("error", (error) => {
    console.error("Daemon server error:", error);
    void shutdown(1);
  });

  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(SOCKET_PATH, () => {
      server?.off("error", reject);
      resolve();
    });
  });

  process.stderr.write("daemon ready\n");
}

function registerShutdownHandlers(): void {
  const handleSignal = () => {
    void shutdown(0);
  };

  const handleFatalError = (error: unknown) => {
    console.error("Fatal daemon error:", error);
    void shutdown(1);
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  process.on("SIGHUP", handleSignal);
  process.on("uncaughtException", handleFatalError);
  process.on("unhandledRejection", handleFatalError);
}

registerShutdownHandlers();

start().catch((error) => {
  console.error("Failed to start daemon:", error);
  void shutdown(1);
});
