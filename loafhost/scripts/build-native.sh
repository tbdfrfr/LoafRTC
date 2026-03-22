#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NATIVE_DIR="$ROOT_DIR/native"
OUT_FILE="$ROOT_DIR/native/index.node"
MANIFEST_PATH="$NATIVE_DIR/Cargo.toml"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required to build loafhost native addon" >&2
  exit 1
fi

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "missing Cargo manifest at $MANIFEST_PATH" >&2
  exit 1
fi

pushd "$NATIVE_DIR" >/dev/null
cargo build --manifest-path "$MANIFEST_PATH" --release
popd >/dev/null

# Prefer direct .node output if present.
if [[ -f "$NATIVE_DIR/loafhost_native.win32-x64-msvc.node" ]]; then
  cp "$NATIVE_DIR/loafhost_native.win32-x64-msvc.node" "$OUT_FILE"
elif [[ -f "$NATIVE_DIR/index.node" ]]; then
  cp "$NATIVE_DIR/index.node" "$OUT_FILE"
elif [[ -f "$NATIVE_DIR/target/release/loafhost_native.dll" ]]; then
  cp "$NATIVE_DIR/target/release/loafhost_native.dll" "$OUT_FILE"
elif [[ -f "$NATIVE_DIR/target/release/libloafhost_native.so" ]]; then
  cp "$NATIVE_DIR/target/release/libloafhost_native.so" "$OUT_FILE"
elif [[ -f "$NATIVE_DIR/target/release/libloafhost_native.dylib" ]]; then
  cp "$NATIVE_DIR/target/release/libloafhost_native.dylib" "$OUT_FILE"
else
  echo "unable to find generated native artifact in $NATIVE_DIR/target/release" >&2
  exit 1
fi

echo "native addon copied to $OUT_FILE"
