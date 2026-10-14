# Forked Playwright Client

## What this is

This directory is a forked subset of Playwright's client-side code, adapted to run inside the QuickJS WASM sandbox used by web-interact.

The goal is simple:

- sandboxed user scripts should get normal Playwright client objects like `Page`, `Frame`, `Locator`, and `ElementHandle`
- the sandbox should not get direct access to the host filesystem, processes, sockets, or browser ownership

The fork sits on the client side only. The real browser, dispatcher graph, and browser lifecycle stay on the host side.

```text
User script
  -> QuickJS sandbox
  -> forked Playwright client
  -> transport bridge
  -> host Playwright dispatcher
  -> real Playwright
  -> browser
```

Relevant local paths:

```text
bundle-entry.ts
node-shims/*
src/client/*
src/protocol/*
src/utils/*
types/*
../quickjs-sandbox.ts
../host-bridge.ts
../protocol-bridge.ts
../sandbox-transport.ts
```

## Why we forked it

Upstream Playwright client code is not a drop-in fit for QuickJS:

- it imports Node.js modules such as `fs`, `path`, `stream`, and `node:async_hooks` zones directly
- it expects upstream transports like WebSocket or Playwright's local pipe helpers
- it includes surfaces that do not make sense in the sandbox, such as Android, Electron, downloads/artifacts-to-disk, and local utility helpers

The fork lets web-interact keep the Playwright object model and protocol semantics while replacing the runtime assumptions around it.

## Source version and provenance

The fork is synced to Playwright **v1.64.0** (upstream commit `606ecd8b3`), with the local edits below layered on top. Use that commit as the merge base for the next update.

The host runs it against two servers, chosen by browser mode:

- `patchright-core` 1.64.0 in assistant mode
- `playwright-core` 1.64.1 in default mode

Both speak the same protocol (805 messages). Patchright only adds optional fields such as `isolatedContext` and `patchrightInitScript`, which this client never sends. Upstream's client, protocol, and isomorphic sources are identical between v1.64.0 and v1.64.1.

Upstream path mapping:

```text
src/client/*                       <- packages/playwright-core/src/client/*
src/protocol/channels.d.ts         <- packages/playwright-core/src/client/channels.d.ts (type names only, see Tier 2)
src/protocol/*                     <- packages/protocol/src/*
src/utils/isomorphic/stackTrace.ts <- packages/utils/stackTrace.ts
src/utils/isomorphic/*             <- packages/isomorphic/*
types/*                            <- packages/playwright-core/types/*
```

Upstream aliases (`@isomorphic/*`, `@protocol/*`, `@utils/*`) are rewritten to local relative imports.

## Change tiers

Every upstream file gets the same mechanical treatment: `// @ts-nocheck` at the top, aliases rewritten to local relative imports, and formatting with the repo's Prettier config. Nothing is byte-for-byte upstream any more, so diff against a normalized upstream copy, not the raw one.

### Tier 1: upstream with mechanical edits only

Most of `src/client/`, `src/protocol/`, `src/utils/isomorphic/`, and `types/`, including the generated `src/protocol/validator.ts`.

### Tier 2: modified

These files have intentional behavior changes or are fork-owned:

- `bundle-entry.ts`
  - esbuild entry point for the sandbox bundle; exports `Connection` and the public client-side types the sandbox loader needs

- `node-shims/*` and `../../../scripts/bundle-sandbox-client.ts`
  - since 1.64 the client imports Node built-ins directly; the bundle resolves `fs`, `path`, `stream`, `util`, `events`, `inspector`, and the `colors/safe` package to these stand-ins
  - `fs` calls and `path.resolve()`/`path.relative()` throw, so the client can never read, write, or resolve host paths on its own; pure string helpers in `path` work

- `src/utils/debug.ts`, `debugLogger.ts`, `zones.ts`, `crypto.ts`, `env.ts`
  - QuickJS replacements for Playwright's `packages/utils/*`, which the 1.64 client imports directly
  - debug and test modes are off, logging is silent, GUIDs come from `Math.random`, and zones keep data but are never entered (QuickJS has no `AsyncLocalStorage`)

- `src/client/fileUtils.ts`
  - fork-owned; file reads and writes go through host callbacks (`writeFile`, `readFile`, `resolveFilePath`, `deleteFile`) injected by `../quickjs-sandbox.ts`, which confine them to the controlled temp directory

- Files that read or write user-supplied paths, rewired to `readTempFile()`/`writeTempFile()`:
  - `src/client/page.ts` and `src/client/elementHandle.ts`: `screenshot({ path })` strips `path` from the protocol request and saves the returned buffer; `page.pdf({ path })` likewise
  - `src/client/browser.ts`: `stopTracing()` output
  - `src/client/browserContext.ts` and `src/client/fetch.ts`: `storageState` reads and writes
  - `src/client/clientHelper.ts`, `src/client/frame.ts`, `src/client/network.ts`: `addInitScript`, `addScriptTag`/`addStyleTag`, and `route.fulfill` with `path`

- `src/client/page.ts`
  - page `console` listeners turn on the context-level `console` subscription instead of the page-level one

- `src/client/browserContext.ts`
  - no `Debugger` wiring

- `src/client/browserType.ts`
  - hard-disables `browserType.connect()` and `browserType.launchPersistentContext()` so browser ownership stays on the host

- `src/client/tracing.ts`
  - upstream code, except that traces are always fetched as archive artifacts and saved into the temp directory, and HARs are written only to paths resolved into the temp directory (a zipped HAR comes back as an artifact). The server can write an uncompressed HAR straight to `harPath`, so the sandbox never passes it an unresolved path.

- `src/client/artifact.ts`
  - `saveAs()` resolves into the temp directory; `readIntoBuffer()` goes through a temp file; streams are not available

- `src/client/video.ts`
  - upstream code, except `path()` throws because it would expose a host path; `saveAs()` works through `Artifact`

- `src/client/localUtils.ts`
  - device descriptors come from the host as in upstream; trace stack bookkeeping is a no-op (traces saved from the sandbox carry no source stacks); zip and HAR helpers throw

- `src/protocol/channels.d.ts`
  - every type name from upstream's generated `channels.d.ts` and protocol structs, declared as `any`; the client is `@ts-nocheck`, so only the names matter

### Tier 3: stubbed

These keep the object graph intact but replace the implementation with empty or throwing behavior:

```text
src/client/android.ts
src/client/electron.ts
src/client/harRouter.ts
src/client/stream.ts
src/client/writableStream.ts
```

Android and Electron are not part of the sandbox model, HAR routing needs `LocalUtils` file access, and streams assume filesystem access the sandbox does not have. `src/client/download.ts` is upstream, but it delegates to `Artifact`, so download file access only works through the temp directory.

### Tier 4: skipped

Upstream files the client never imports are not copied, for example the trace viewer and trace model under `packages/isomorphic/trace/` (only `trace.ts`, `traceUtils.ts`, and the `versions/traceV10.ts` and `versions/har.ts` types are needed), `DEPS.list` files, and protocol generator inputs.

## `bundle-entry.ts`

`bundle-entry.ts` is the esbuild entry point for the fork.

It does not try to recreate the published `playwright` package. It exports only the client-side pieces the sandbox loader needs:

```text
Connection
Browser
BrowserContext
Frame
Locator
Page
Playwright
```

`../quickjs-sandbox.ts` loads the built bundle, evaluates it inside QuickJS, captures the resulting `__PlaywrightClient` global, and creates `new Connection()`.

## How the bundle works

Build inputs and outputs:

```text
entry point: bundle-entry.ts
build script: ../../../scripts/bundle-sandbox-client.ts
output: ../../../dist/sandbox-client.js
format: IIFE
global: __PlaywrightClient
platform: neutral
target: es2022
```

Rebuild command:

```bash
cd daemon && pnpm run bundle:sandbox-client
```

The build uses `platform: "neutral"` on purpose. This code is not a normal Node bundle and not a normal browser bundle. It is a self-contained client bundle that QuickJS can evaluate safely. A small esbuild plugin in the build script maps Node built-ins to `node-shims/`; any other bare import that cannot be resolved fails the build.

## Architecture context

The fork is only one piece of the stack:

```text
User script
  -> QuickJS sandbox
  -> forked Playwright client
  -> transport bridge
  -> host Playwright dispatcher
  -> real Playwright
  -> browser
```

Concrete local pieces:

- `../quickjs-sandbox.ts` loads `../../../dist/sandbox-client.js`, installs host callbacks like `writeFile`, and creates the sandbox-side `Connection`
- `../host-bridge.ts` owns the host-side `DispatcherConnection`, `RootDispatcher`, and `PlaywrightDispatcher`
- `../protocol-bridge.ts` wires both sides together
- `../sandbox-transport.ts` shows the same shape in the pure Node test bridge

One subtle but important detail:

- the QuickJS transport path does not go through `src/client/browserType.connect()`
- instead, the sandbox creates `Connection` directly and exchanges raw Playwright protocol messages with the host bridge

That is why `browserType.connect()` is stubbed even though the sandbox still has a transport bridge.

## How to update the fork

1. Pick the upstream tag to adopt and check that the patchright release with the same minor version speaks the same protocol (compare the `scheme.*` names in both packages' `lib/coreBundle.js`).

2. Normalize two upstream trees into this directory's layout: the current merge base (see "Source version and provenance") and the new tag. Normalizing means applying the path mapping above (it can change between releases; upstream moved `protocol`, `isomorphic`, and `utils` out of `playwright-core` before 1.64), rewriting aliases to relative imports, adding `// @ts-nocheck`, and running Prettier.

3. Three-way merge each fork file with `git merge-file <fork file> <normalized base> <normalized new>`. Clean merges keep the sandbox edits automatically.

4. Resolve conflicts by keeping upstream behavior and reapplying the Tier 2 edits. Watch for new code that reads or writes user-supplied paths, and route it through `fileUtils.ts`.

5. Copy in upstream modules that merged files now import, and extend `node-shims/` or `src/utils/` when the client starts using new Node built-ins or upstream utils (the bundle build fails on anything unresolved).

6. Rebuild and test:

   ```bash
   cd daemon && pnpm run bundle && pnpm exec vitest run
   ```

7. Update the version and provenance section in this README.

## Practical rules

- Prefer copying upstream code first, then reapplying the sandbox edits.
- Keep new unsupported features stubbed explicitly instead of silently half-working.
- If an upstream change touches path handling, Node built-ins, or protocol type generation, expect manual merge work.
- If you add a new stubbed surface, keep the runtime error message explicit so sandbox users fail fast.
