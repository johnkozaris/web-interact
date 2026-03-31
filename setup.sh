#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

build() {
  echo "==> Building web-interact from source"

  echo "    Installing daemon dependencies..."
  pnpm --dir "${REPO_DIR}/daemon" install --frozen-lockfile --ignore-scripts

  echo "    Bundling daemon..."
  pnpm --dir "${REPO_DIR}/daemon" run bundle
  pnpm --dir "${REPO_DIR}/daemon" run bundle:sandbox-client

  echo "    Compiling Rust CLI..."
  touch "${REPO_DIR}/daemon/dist/daemon.bundle.mjs"
  cargo build --release

  local arch
  arch="$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')"
  mkdir -p "${REPO_DIR}/bin"
  cp "${REPO_DIR}/target/release/web-interact" "${REPO_DIR}/bin/web-interact-$(uname -s | tr A-Z a-z)-${arch}"

  echo ""
  echo "    Build complete. Run: ./web-interact --version"
  echo "    Runtime auto-installs to ~/.web-interact/ on first use."
}

build
