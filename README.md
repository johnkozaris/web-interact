# web-interact

<!-- TODO: Add banner image -->

Browser automation CLI for AI agents. Each command maps to one browser action — navigate, discover elements, click, fill forms, take screenshots, extract data.

Designed for automating your own web applications. Please use responsibly.

[![npm](https://img.shields.io/npm/v/web-interact)](https://www.npmjs.com/package/web-interact)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Install

```bash
# npm (recommended)
npm install -g web-interact

# Shell installer (macOS/Linux)
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/johnkozaris/web-interact/releases/latest/download/web-interact-installer.sh | sh

# PowerShell (Windows)
powershell -ExecutionPolicy ByPass -c "irm https://github.com/johnkozaris/web-interact/releases/latest/download/web-interact-installer.ps1 | iex"

# Cargo
cargo install web-interact
```

Runtime dependencies (Playwright + Chrome) are auto-installed on first run.

## Quick start

```bash
# Navigate and discover interactive elements
web-interact open "https://example.com/login"
web-interact discover
# [1] input "Email"  [2] input[password] "Password"  [3] button "Sign in"

# Fill the form and submit
web-interact fill 1 "user@example.com"
web-interact fill 2 "password123"
web-interact click 3

# Check where we landed
web-interact get url
# https://example.com/dashboard
```

## How it works

**Discover → Act → Verify.** Each command is one shell call. Element indices auto-refresh on navigation.

```bash
web-interact discover              # list interactive elements [1], [2], ...
web-interact click 3               # click by index
web-interact fill 1 "text"         # clear + type into field
web-interact type 2 "text"         # append to field (for autocomplete)
web-interact get url               # read page state
web-interact screenshot --annotate # screenshot with numbered overlays
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
| Config | `mode default/assistant`, `browser-mode auto/real/sandbox` |
| Manage | `status`, `browsers`, `close`, `stop`, `install` |

## Output contract

- **Actions** (click, fill, press, etc.): silent on success (exit 0), error on stderr (exit 1)
- **Getters** (get url, eval, etc.): raw value to stdout
- **Data** (tab list, cookies, storage): JSON to stdout
- **Large output**: truncated at 128KB — use `--save <file>` for full

## Modes

### Interaction modes
```bash
web-interact discover                          # DOM mode (default)
web-interact --vision click 3                  # Vision — screenshot after each command
web-interact --vision --annotate click 3       # Annotated — numbered element overlays
```

### Engine modes
```bash
web-interact mode                              # Show current: default or assistant
web-interact mode assistant                    # Patchright + auto-humanize (for sensitive sites)
web-interact mode default                      # Playwright (standard)
```

### Browser modes
```bash
web-interact browser-mode                      # Show current: auto, real, or sandbox
web-interact browser-mode real                 # Connect to your running Chrome/Edge
web-interact browser-mode sandbox              # Managed browser with persistent profile
web-interact browser-mode auto                 # CLI decides (default)
```

## Flags

| Flag | Description |
|------|-------------|
| `--headless` | Run without visible window |
| `--browser NAME` | Named browser instance (default: "default") |
| `--connect [URL]` | Connect to running Chrome/Edge |
| `--own-browser` | Use your running browser (shorthand for `--connect auto`) |
| `--humanize` | Natural delays between actions (auto in assistant mode) |
| `--vision` | Screenshot after each command |
| `--vision --annotate` | Annotated screenshot with element overlays |
| `--save FILE` | Write output to file instead of stdout |
| `--timeout SECONDS` | Script timeout (default: 20s) |
| `--page NAME` | Named page within browser |

## Claude Code plugin

Add the plugin for skill-based integration:

```
/plugin marketplace add johnkozaris/web-interact-plugin
```

This gives Claude the `/web-interact`, `/mode`, and `/browser-mode` skills.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, build instructions, and architecture.

## Author

John Kozaris (ioanniskozaris@gmail.com)

## License

MIT
