# Contributing to web-interact

Thank you for your interest in contributing to web-interact.

## Getting started

```bash
git clone https://github.com/johnkozaris/web-interact.git
cd web-interact
./setup.sh
```

This builds the CLI binary, daemon bundles, and installs the runtime locally.

## Development workflow

```bash
pnpm run verify    # typecheck + bundle + test + build:cli
```

Or individually:

```bash
pnpm --dir daemon exec tsc --noEmit     # Typecheck
pnpm run bundle                          # Bundle daemon + sandbox client
pnpm run test                            # Run tests (89 tests)
cargo build --release --manifest-path cli/Cargo.toml  # Build CLI
```

After changing daemon TypeScript code, always re-bundle before building the CLI:

```bash
pnpm run bundle
touch daemon/dist/daemon.bundle.mjs    # Force cargo to re-embed
cargo build --release --manifest-path cli/Cargo.toml
```

## Submitting changes

1. Fork the repository
2. Create a branch from `main`
3. Make your changes
4. Run `pnpm run verify` to ensure everything passes
5. Submit a pull request

## Code style

- Rust: `rustfmt` (default settings)
- TypeScript: `prettier` (config in `.prettierrc`)
- Commit messages: imperative mood, concise

## Architecture

```
cli/       Rust CLI — parses commands, generates JS scripts, manages daemon
daemon/    Node.js daemon — Patchright browser control + QuickJS WASM sandbox
  src/sandbox/dom/   CDP element discovery (AX tree + DOMSnapshot + JS listeners)
skills/    Claude Code skill docs
npm/       npm distribution packages
```

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
