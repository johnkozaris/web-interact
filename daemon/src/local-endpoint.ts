import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const WEB_INTERACT_HOME_ENV = "WEB_INTERACT_HOME";

function sanitizePipeSegment(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  if (sanitized.length === 0) {
    return "web-interact";
  }

  return sanitized.length > 80 ? sanitized.slice(-80) : sanitized;
}

function getConfiguredDevBrowserBaseDir(): string | null {
  const configured = process.env[WEB_INTERACT_HOME_ENV];
  if (configured === undefined) {
    return null;
  }

  if (configured.trim().length === 0) {
    throw new Error(
      `${WEB_INTERACT_HOME_ENV} is set but empty. Set it to an absolute path or unset it.`
    );
  }

  if (!path.isAbsolute(configured)) {
    throw new Error(`${WEB_INTERACT_HOME_ENV} must be an absolute path. Got: ${configured}`);
  }

  return configured;
}

export function getWebInteractBaseDir(homedir = os.homedir()): string {
  return getConfiguredDevBrowserBaseDir() ?? path.join(homedir, ".web-interact");
}

export function getDaemonEndpoint(
  options: {
    homedir?: string;
    platform?: NodeJS.Platform;
  } = {}
): string {
  const homedir = options.homedir ?? os.homedir();
  const platform = options.platform ?? process.platform;

  if (platform === "win32") {
    const baseDir =
      getConfiguredDevBrowserBaseDir() ?? path.win32.join(homedir, ".web-interact");
    return `\\\\.\\pipe\\web-interact-daemon-${sanitizePipeSegment(baseDir)}`;
  }

  return path.join(getWebInteractBaseDir(homedir), "daemon.sock");
}

export function getPidPath(homedir = os.homedir()): string {
  return path.join(getWebInteractBaseDir(homedir), "daemon.pid");
}

export function getBrowsersDir(homedir = os.homedir()): string {
  return path.join(getWebInteractBaseDir(homedir), "browsers");
}

export function requiresDaemonEndpointCleanup(platform = process.platform): boolean {
  return platform !== "win32";
}

export function readMode(homedir = os.homedir()): "default" | "assistant" {
  try {
    const content = readFileSync(path.join(getWebInteractBaseDir(homedir), "mode"), "utf8").trim();
    return content === "assistant" ? "assistant" : "default";
  } catch {
    return "default";
  }
}
