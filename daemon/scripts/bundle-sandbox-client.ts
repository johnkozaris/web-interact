import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { build, type Plugin } from "esbuild";

const daemonDir = resolve(import.meta.dirname, "..");
const forkDir = resolve(daemonDir, "src/sandbox/forked-client");
const entryPoint = resolve(forkDir, "bundle-entry.ts");
const outfile = resolve(daemonDir, "dist/sandbox-client.js");

// Playwright's client imports Node built-ins directly (since 1.64). QuickJS has
// none of them, so the bundle swaps in sandbox stand-ins from node-shims/.
const nodeShims: Record<string, string> = {
  fs: "fs.ts",
  path: "path.ts",
  stream: "stream.ts",
  util: "util.ts",
  events: "events.ts",
  inspector: "inspector.ts",
  "colors/safe": "colors-safe.ts",
};

const quickjsNodeShims: Plugin = {
  name: "quickjs-node-shims",
  setup(build) {
    build.onResolve(
      { filter: /^(node:)?(fs|path|stream|util|events|inspector)$|^colors\/safe$/ },
      (args) => ({
        path: resolve(forkDir, "node-shims", nodeShims[args.path.replace(/^node:/, "")]!),
      })
    );
  },
};

await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: [entryPoint],
  bundle: true,
  format: "iife",
  globalName: "__PlaywrightClient",
  outfile,
  platform: "neutral",
  target: "es2022",
  plugins: [quickjsNodeShims],
});
