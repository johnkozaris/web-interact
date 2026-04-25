# Changelog

## Unreleased

### Changed
- Managed Chromium launches now enable Chromium sandboxing by default, with `WEB_INTERACT_CHROMIUM_SANDBOX=false` as an explicit compatibility escape hatch for restricted hosts.

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
