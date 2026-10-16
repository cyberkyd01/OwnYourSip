#!/usr/bin/env bash
# Build and install chan_dongle (Huawei USB modems). Best-effort.
set -euo pipefail
fail() { echo "ERROR: chan_dongle build failed: $*" >&2; exit 1; }
trap 'fail "command failed at line $LINENO"' ERR

SRC=/usr/src/asterisk-chan-dongle
command -v asterisk >/dev/null || fail "asterisk not installed"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" pull --ff-only || true
else
  rm -rf "$SRC"
  git clone --depth 1 https://github.com/wdoekes/asterisk-chan-dongle "$SRC"
fi
ASTVER="$(asterisk -V | grep -oE '[0-9]+\.[0-9]+' | head -1)"
echo "Building chan_dongle for Asterisk $ASTVER"
pushd "$SRC" >/dev/null
./bootstrap
./configure --with-astversion="$ASTVER"
make -j"$(nproc)"
make install
popd >/dev/null
echo "chan_dongle installed."
