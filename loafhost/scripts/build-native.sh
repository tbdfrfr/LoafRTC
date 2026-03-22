#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NATIVE_DIR="$ROOT_DIR/native"
OUT_FILE="$ROOT_DIR/native/index.node"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required to build loafhost native addon" >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to run @napi-rs/cli" >&2
  exit 1
fi

pushd "$NATIVE_DIR" >/dev/null
npx --yes @napi-rs/cli build --platform --release --js false
popd >/dev/null

if [[ -f "$NATIVE_DIR/loafhost_native.win32-x64-msvc.node" ]]; then
  cp "$NATIVE_DIR/loafhost_native.win32-x64-msvc.node" "$OUT_FILE"
elif [[ -f "$NATIVE_DIR/index.node" ]]; then
  cp "$NATIVE_DIR/index.node" "$OUT_FILE"
else
  echo "unable to find generated .node artifact" >&2
  exit 1
fi

echo "native addon copied to $OUT_FILE"
