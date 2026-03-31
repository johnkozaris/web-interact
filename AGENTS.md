# web-interact

Browser automation CLI for AI agents. Rust CLI + Node.js daemon + QuickJS sandbox.

**Author:** John Kozaris  
**Repo:** github.com/johnkozaris/web-interact

## Architecture

```
cli/       Rust CLI (commands.rs generates JS, main.rs dispatches)
daemon/    Node.js daemon (Patchright + QuickJS WASM sandbox)
  src/sandbox/dom/   CDP element discovery (AX tree + DOMSnapshot + JS listeners)
npm/       npm distribution packages (prebuilt binaries per platform)
```

## Build

```bash
pnpm run verify    # typecheck + bundle + test + build:cli
```

Build order (important — cargo embeds the daemon bundle at compile time):
1. `pnpm run bundle`
2. `touch daemon/dist/daemon.bundle.mjs`
3. `cargo build --release --manifest-path cli/Cargo.toml`
4. `cp cli/target/release/web-interact bin/web-interact-darwin-arm64`

## Output contract

- **Actions**: silent on success (exit 0), error text on stderr (exit 1)
- **Getters**: raw value to stdout
- **Data**: JSON to stdout
- **Large output**: truncated at 128KB, use `--save` for full output

## Modes

- Default: DOM mode (discover → click by index)
- `--vision`: plain screenshot after each command
- `--vision --annotate`: numbered element overlays on screenshot

## Important rules

- Never use `--headless` for login pages from Google, Microsoft, GitHub, etc.
- Always re-discover after navigation or DOM changes.
- `fill` clears then types (for form fields). `type` appends (for autocomplete).
