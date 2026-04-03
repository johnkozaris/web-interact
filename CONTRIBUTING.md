# Contributing

## Getting started

```bash
git clone https://github.com/johnkozaris/web-interact.git
cd web-interact
./setup.sh
```

## Architecture

```
cli/         Rust CLI (edition 2024) — parses commands, generates JS, manages daemon
daemon/      Node.js daemon — Playwright/Patchright + QuickJS WASM sandbox
  src/sandbox/dom/   CDP element discovery (AX tree + DOMSnapshot + JS listeners)
scripts/     Build and dev helper scripts
```

The Rust CLI embeds the daemon bundle at compile time (`include_str!`) and extracts it to `~/.web-interact/` on first run. Runtime dependencies (Playwright + Chrome) auto-install on first use.

## Prerequisites

- Rust 1.85+
- Node.js 22+
- pnpm 10+ (`corepack enable`)

## Development

```bash
pnpm run verify    # typecheck + bundle + test + build:cli
```

Or individually:

```bash
pnpm run typecheck                   # TypeScript check
pnpm run bundle                      # Bundle daemon + sandbox client
pnpm run test                        # Run tests (89 tests)
cargo build --release                # Compile CLI
```

## Build order

Important — Cargo embeds the daemon bundle at compile time:

1. `pnpm run bundle`
2. `touch daemon/dist/daemon.bundle.mjs` (force Cargo to detect change)
3. `cargo build --release`
4. `cp target/release/web-interact bin/web-interact-darwin-arm64`

## Key files

| File | Purpose |
|------|---------|
| `cli/src/main.rs` | CLI entry, flag parsing, command dispatch |
| `cli/src/commands.rs` | 40+ subcommand definitions + JS generation |
| `cli/src/daemon.rs` | Daemon lifecycle, runtime install, mode-aware package.json |
| `cli/src/paths.rs` | `~/.web-interact/` paths, mode/browser-mode config |
| `daemon/src/daemon.ts` | Socket server, request dispatch |
| `daemon/src/browser-manager.ts` | Browser launch, discover state, channel detection |
| `daemon/src/sandbox/quickjs-sandbox.ts` | QuickJS WASM sandbox with browser.* API |
| `daemon/src/sandbox/dom/` | CDP element discovery |

## Release process

Push a version tag to trigger [cargo-dist](https://opensource.axo.dev/cargo-dist/):

```bash
# Bump version in package.json + cli/Cargo.toml, commit, then:
git tag v0.2.0
git push origin v0.2.0
```

Builds 5 platforms, publishes to npm via Trusted Publishing, creates GitHub Release.

## Submitting changes

1. Fork the repository
2. Create a branch from `main`
3. Make your changes
4. Run `pnpm run verify`
5. Submit a pull request

## Code style

- Rust: `rustfmt` (default settings)
- TypeScript: `prettier` (config in `.prettierrc`)
- Commit messages: imperative mood, concise

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
