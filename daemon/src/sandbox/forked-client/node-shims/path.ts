// Stand-in for node:path in the QuickJS sandbox bundle. Pure string helpers
// work; resolve() and relative() depend on the host's working directory, so
// they fail the same way the sandbox's old platform.path() did.

export const sep = "/";

export function isAbsolute(p: string): boolean {
  return p.startsWith("/");
}

export function basename(p: string, ext?: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return ext && base.endsWith(ext) && base !== ext ? base.slice(0, -ext.length) : base;
}

export function dirname(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index === -1) return ".";
  return index === 0 ? "/" : trimmed.slice(0, index);
}

export function extname(p: string): string {
  const base = basename(p);
  const index = base.lastIndexOf(".");
  return index <= 0 ? "" : base.slice(index);
}

export function join(...parts: string[]): string {
  const joined = parts.filter((part) => part.length > 0).join("/");
  return joined.replace(/\/{2,}/g, "/") || ".";
}

export function resolve(): never {
  throw new Error("path.resolve() is not available in the QuickJS sandbox");
}

export function relative(): never {
  throw new Error("path.relative() is not available in the QuickJS sandbox");
}

export default { sep, isAbsolute, basename, dirname, extname, join, resolve, relative };
