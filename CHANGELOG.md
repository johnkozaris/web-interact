# Changelog

## 0.1.0 (2026-04-01)

Initial open-source release.

### Features
- 40+ CLI commands for browser automation
- DOM mode: discover interactive elements, act by index
- Vision mode: --vision (plain screenshot), --vision --annotate (numbered overlays)
- Real Chrome via Patchright (Playwright fork)
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
- Patchright 1.59.1 (Playwright fork)
