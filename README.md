# web-interact

Browser automation CLI for AI agents and scripts. Each shell command maps to one browser action — navigate, discover elements, click, fill forms, take screenshots, extract data.

Uses real Chrome via Patchright (Playwright fork). Actions are silent on success. Errors are plain text. Output never floods the agent's context window. Designed for automating your own web applications — please use responsibly.

## Usage

```bash
# Navigate and discover interactive elements
web-interact --headless open "https://example.com/login"
web-interact --headless discover
# [1] input "Email"  [2] input[password] "Password"  [3] button "Sign in"

# Fill the form and submit
web-interact --headless fill 1 "user@example.com"
web-interact --headless fill 2 "password123"
web-interact --headless click 3

# Check where we landed
web-interact --headless get url
# https://example.com/dashboard
```

Element indices auto-refresh when the page navigates.

## Modes

```bash
# DOM mode (default) — discover elements, act by index
web-interact --headless discover
web-interact --headless click 3

# Vision mode — plain screenshot after each command
web-interact --headless --vision click 3
# stderr: vision:/path/to/screenshot.png

# Annotated vision — element numbers overlaid on screenshot
web-interact --headless --vision --annotate click 3
# stderr: vision:/path/to/annotated.png
```

## Commands

40+ commands covering the full browser automation surface:

| Category | Commands |
|----------|----------|
| Navigate | `open`, `tab new/switch/close`, `scroll`, `scrollintoview` |
| Discover | `discover`, `snapshot`, `find role/text/label/placeholder` |
| Act | `click`, `fill`, `type`, `select`, `check`, `uncheck`, `hover`, `press`, `dblclick`, `drag`, `upload` |
| Read | `get url/title/text/html/value/attr/visible/enabled/checked/count/styles/box` |
| Screenshot | `screenshot`, `screenshot --annotate`, `pdf` |
| JavaScript | `eval`, `wait` |
| Network | `network requests/block/route/unroute` |
| Storage | `storage local/session`, `cookies get/set/clear`, `clipboard read/write` |
| Settings | `set viewport/geo/offline/media/headers` |
| Low-level | `mouse move/click/down/up/wheel`, `keyboard type/insert/press/down/up` |
| Console | `console` (JS errors, warnings, logs) |
| Browser | `status`, `browsers`, `close`, `stop`, `install` |

## Output contract

- **Actions** (click, fill, press, etc.): silent on success (exit 0). Error text on stderr (exit 1).
- **Getters** (get url, eval, etc.): raw value to stdout.
- **Data** (tab list, cookies, storage): JSON to stdout.
- **Large output**: truncated at 128KB. Use `--save <file>` for full output.

## Architecture

```
cli/         Rust CLI source (edition 2024)
daemon/      Node.js daemon source (Patchright + QuickJS WASM sandbox)
npm/         npm distribution packages (platform stubs, no binaries in git)
scripts/     Build, publish, and dev helper scripts
```

The Rust CLI embeds the daemon bundle at compile time and extracts it to `~/.web-interact/` on first run. Runtime dependencies (Patchright + Chrome) are auto-installed on first use.

## Install

```bash
./setup.sh                  # Build from source + install runtime
```

Or step by step:

```bash
./setup.sh --build          # Build CLI binary + daemon bundles
./setup.sh --install-local  # Install Patchright runtime to local/
web-interact install        # Install Chrome for headless automation
```

## Development

```bash
pnpm run verify             # typecheck + bundle + test + build:cli
```

Or individually:

```bash
pnpm --dir daemon exec tsc --noEmit     # Typecheck
pnpm run bundle                          # Bundle daemon + sandbox client
pnpm --dir daemon exec vitest run        # Run tests (89 tests)
cargo build --release --manifest-path cli/Cargo.toml  # Build CLI
```

## Global flags

| Flag | Description |
|------|-------------|
| `--headless` | Run without visible window |
| `--browser NAME` | Named browser instance (default: "default") |
| `--connect [URL]` | Connect to running Chrome |
| `--vision` | Screenshot after each command |
| `--vision --annotate` | Annotated screenshot with element overlays |
| `--save FILE` | Write output to file instead of stdout |
| `--timeout SECONDS` | Script timeout (default: 20s) |
| `--page NAME` | Named page within browser |

## Author

John Kozaris (ioanniskozaris@gmail.com)

## License

MIT
