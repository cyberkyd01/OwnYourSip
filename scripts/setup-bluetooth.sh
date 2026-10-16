#!/usr/bin/env bash
# Make chan_mobile workable on BlueZ 5.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root" >&2; exit 1; }

mkdir -p /etc/systemd/system/bluetooth.service.d
cat > /etc/systemd/system/bluetooth.service.d/override.conf <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/libexec/bluetooth/bluetoothd -C --noplugin=sap,a2dp,avrcp,hfp,hsp
EOF

cat > /etc/systemd/system/bluetooth-hf.service <<'EOF'
[Unit]
Description=Register Hands-Free SDP record for chan_mobile
After=bluetooth.service
Requires=bluetooth.service

[Service]
Type=oneshot
ExecStartPre=/bin/sleep 2
ExecStart=/usr/bin/sdptool add --channel=1 HF
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable bluetooth-hf.service
rfkill unblock bluetooth || true
systemctl restart bluetooth
sleep 2
systemctl restart bluetooth-hf.service || echo "WARN: bluetooth-hf.service failed to start"
bluetoothctl power on || true
bluetoothctl discoverable off || true
echo "Bluetooth configured."
