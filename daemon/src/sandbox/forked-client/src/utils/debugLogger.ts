// QuickJS replacement for Playwright's packages/utils/debugLogger.ts, which
// writes through the `debug` package and the filesystem. Logging is off in the sandbox.

export const debugLogger = {
  log(_name: string, _message: string | Error | object): void {},
  isEnabled(_name: string): boolean {
    return false;
  },
};
