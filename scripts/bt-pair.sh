#!/usr/bin/env bash
# Non-interactive Bluetooth pairing: bt-pair.sh AA:BB:CC:DD:EE:FF
set -uo pipefail
ADDR="${1:-}"
if ! [[ "$ADDR" =~ ^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$ ]]; then
  echo "Usage: $0 AA:BB:CC:DD:EE:FF" >&2
  exit 2
fi
ADDR="${ADDR^^}"

{
  echo "power on"
  echo "agent NoInputNoOutput"
  echo "default-agent"
  echo "scan on"
  sleep 8
  echo "pair $ADDR"
  sleep 20
  echo "trust $ADDR"
  sleep 1
  echo "scan off"
  echo "quit"
} | timeout 60 bluetoothctl 2>&1

echo "---- device info ----"
INFO="$(timeout 15 bluetoothctl info "$ADDR" 2>&1 || true)"
echo "$INFO"
if grep -q 'Paired: yes' <<<"$INFO"; then
  echo "RESULT: paired"
  exit 0
fi
echo "RESULT: not paired"
exit 1
