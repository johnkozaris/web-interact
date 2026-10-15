// Stand-in for node:inspector in the QuickJS sandbox bundle. No JS debugger
// can attach to the sandbox.

export function url(): string | undefined {
  return undefined;
}

export default { url };
