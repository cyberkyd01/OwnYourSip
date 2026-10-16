#!/usr/bin/env bash
# Build and install chan_quectel (Quectel / SimCom modules). Best-effort.
set -euo pipefail
fail() { echo "ERROR: chan_quectel build failed: $*" >&2; exit 1; }
trap 'fail "command failed at line $LINENO"' ERR

SRC=/usr/src/asterisk-chan-quectel
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" pull --ff-only || true
else
  rm -rf "$SRC"
  git clone --depth 1 https://github.com/RoEdAl/asterisk-chan-quectel "$SRC"
fi
pushd "$SRC" >/dev/null
if [ -f make-build-dir.cmake ]; then
  echo "Using make-build-dir.cmake helper"
  cmake -P make-build-dir.cmake
  BUILD_DIR="$(ls -d build* 2>/dev/null | head -1 || true)"
  [ -n "$BUILD_DIR" ] || BUILD_DIR=build
else
  BUILD_DIR=build
  cmake -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr
fi
cmake --build "$BUILD_DIR" -j"$(nproc)"
cmake --install "$BUILD_DIR"
popd >/dev/null
echo "chan_quectel installed."
