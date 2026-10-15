// QuickJS replacement for Playwright's packages/utils/env.ts.
// The sandbox has no process environment.

export function getFromENV(_name: string): string | undefined {
  return undefined;
}

export function getAsBooleanFromENV(_name: string, defaultValue?: boolean | undefined): boolean {
  return !!defaultValue;
}
