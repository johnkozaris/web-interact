import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getBrowsersDir,
  getDaemonEndpoint,
  getWebInteractBaseDir,
  getPidPath,
  requiresDaemonEndpointCleanup,
} from "./local-endpoint.js";

describe("local endpoint helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds filesystem-backed daemon paths on unix-like platforms", () => {
    const homedir = "/Users/tester";

    expect(getWebInteractBaseDir(homedir)).toBe(path.join(homedir, ".web-interact"));
    expect(getDaemonEndpoint({ homedir, platform: "darwin" })).toBe(
      path.join(homedir, ".web-interact", "daemon.sock")
    );
    expect(getPidPath(homedir)).toBe(path.join(homedir, ".web-interact", "daemon.pid"));
    expect(getBrowsersDir(homedir)).toBe(path.join(homedir, ".web-interact", "browsers"));
    expect(requiresDaemonEndpointCleanup("linux")).toBe(true);
  });

  it("builds a user-scoped named pipe path on Windows", () => {
    expect(
      getDaemonEndpoint({
        homedir: "C:\\Users\\Tester",
        platform: "win32",
      })
    ).toBe("\\\\.\\pipe\\web-interact-daemon-c-users-tester-.web-interact");
    expect(requiresDaemonEndpointCleanup("win32")).toBe(false);
  });

  it("uses WEB_INTERACT_HOME when configured", () => {
    vi.stubEnv("WEB_INTERACT_HOME", "/tmp/web-interact-home");

    expect(getWebInteractBaseDir("/Users/tester")).toBe("/tmp/web-interact-home");
    expect(getDaemonEndpoint({ homedir: "/Users/tester", platform: "darwin" })).toBe(
      "/tmp/web-interact-home/daemon.sock"
    );
    expect(getPidPath("/Users/tester")).toBe("/tmp/web-interact-home/daemon.pid");
    expect(getBrowsersDir("/Users/tester")).toBe("/tmp/web-interact-home/browsers");
  });
});
