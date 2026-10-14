// QuickJS replacement for Playwright's packages/utils/debug.ts.
// The sandbox has no environment variables, so debug and test modes stay off.

export function debugMode(): "" | "console" | "inspector" {
  return "";
}

export function isUnderTest(): boolean {
  return false;
}
