# Changelog

## Unreleased

### Changed
- Managed Chromium launches now enable Chromium sandboxing by default, with `WEB_INTERACT_CHROMIUM_SANDBOX=false` as an explicit compatibility escape hatch for restricted hosts.
- **Playwright 1.64**: the runtime now installs Playwright 1.64.0 (default mode) or Patchright 1.64.0 (assistant mode), up from 1.59.1, which brings Chrome for Testing 156. The sandbox's forked Playwright client is synced to Playwright v1.64.0.
- Sandbox scripts can use 1.64's `page.screencast` and `tracing.startHar()`/`stopHar()`. Traces, HARs, and screencast recordings are saved into the controlled temp directory, like screenshots.
- `playwright.devices` is populated inside the sandbox instead of being empty.
- The first-run runtime install uses pnpm 12.
- `console` shows the messages and uncaught errors logged since the page last navigated, including those from earlier commands, instead of listening for 300 ms. `--level warn` now matches `console.warn()`, and `--clear` empties the buffer after printing.
- `network route` replaces an earlier route for the same pattern, and `--status` works without `--body`.
- In sandbox scripts, `Buffer.from(string)` defaults to UTF-8 like Node, instead of base64. `Buffer` also gains `byteLength`, `concat`, `isBuffer`, and `latin1` support.

### Added
- `browser.route(page, pattern, response)` and `browser.unroute(page, pattern?)` for scripts: mocks that stay on the page across scripts until removed.

### Fixed
- `discover` showed every checkbox and radio button as `[checked]`. It now shows `[checked]` only when checked and `[checked=mixed]` when indeterminate. Toggle buttons show `[pressed]`, which was never shown before.
- `network route`, `network block`, and `network unroute` had no effect, because the route ended with the command that set it. Routes now stay on the page until removed.
- `page.route()` handlers that called `route.fulfill()` hung until the script timed out.
- Acting by index (`click 3`, `fill 2 ...`) failed with `Node with given id does not belong to the document` after the page reloaded, was opened again at the same URL, or posted a form back to it, until `discover` ran again. Indices now refresh when the page loads a new document, as they already did when the URL changed. If the index then names a different element, the action stops and asks you to run `discover` again.
- `type` and `fill` by index reported success when the element could not take focus, and the text went to whichever element had focus instead. That happened when the page had replaced the field since `discover`, or the field was disabled, hidden or passed focus elsewhere. They now type nothing and fail with `Element could not be focused, so nothing was typed`.

### Infrastructure
- pnpm 12, TypeScript 7, and vitest 5 for development; CI tests the daemon on Node 22 and 24 and checks that the committed `daemon/dist` bundles are current.
- Tests no longer load example.com; they serve their pages from 127.0.0.1.

## 0.2.1 (2026-04-03)

### Bug Fixes
- **click-to-fix**: command timed out after 8s instead of 120s, making it unusable — user had no time to inspect and click an element before the command silently died. Fixed by passing timeout as third argument to `waitForFunction` (Playwright API: `predicate, arg, options`).

## 0.2.0 (2026-04-03)

### Features
- **click-to-fix**: click any browser element to trace it to source code (React/Vue/Svelte/Angular)
- **Mode switching**: `web-interact mode default|assistant` — Playwright or Patchright engine
- **Browser mode**: `web-interact browser-mode auto|real|sandbox` — connection strategy
- **--humanize**: natural human-like delays between actions (auto in assistant mode)
- **--own-browser**: connect to your running Chrome/Edge (shorthand for --connect auto)
- **Edge support**: auto-detects Microsoft Edge alongside Chrome
- **fill fix**: properly clears React/Vue controlled inputs via native value setter
- **type fix**: correctly appends (no longer clears by default)

### Infrastructure
- CI pipeline (typecheck + test + build) with badge
- npm Trusted Publishing via OIDC (no tokens)
- CODEOWNERS for PR reviews
- Branch protection on main

## 0.1.0 (2026-04-01)

Initial open-source release.

### Features
- 40+ CLI commands for browser automation
- DOM mode: discover interactive elements, act by index
- Vision mode: --vision (plain screenshot), --vision --annotate (numbered overlays)
- Playwright-based browser automation
- Silent output contract: actions silent on success, getters print raw values
- Auto-install runtime on first run (~/.web-interact/)
- Live element indices: auto-refresh on page navigation
- Console capture: read JS errors/warnings/logs
- Network mocking: route/block/unroute
- 128KB output truncation with --save fallback
- Claude Code plugin support

### Architecture
- Rust CLI (edition 2024) + Node.js daemon + QuickJS WASM sandbox
- CDP-based element discovery (AX tree + DOMSnapshot + JS listeners)
