#!/usr/bin/env bash
# Uninstall pi-sip-gateway. Keeps /etc/asterisk and data unless --purge.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root" >&2; exit 1; }
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

systemctl disable --now pi-sip-gateway.service 2>/dev/null || true
rm -f /etc/systemd/system/pi-sip-gateway.service
rm -f /etc/systemd/system/asterisk.service.d/override.conf
systemctl daemon-reload
rm -rf /opt/pi-sip-gateway
if [ "$PURGE" -eq 1 ]; then
  rm -rf /etc/pi-sip-gateway /var/lib/pi-sip-gateway
  rm -f /etc/asterisk/*_gen.conf
  echo "Purged config and data (original Asterisk backups in /etc/asterisk/backup-* are kept)."
else
  echo "Kept /etc/pi-sip-gateway, /var/lib/pi-sip-gateway and /etc/asterisk (use --purge to remove)."
fi
systemctl restart asterisk 2>/dev/null || true
echo "Uninstalled."
