#!/usr/bin/env bash
# pi-sip-gateway one-shot installer (idempotent; re-run to upgrade).
set -euo pipefail

DO_DONGLE=1; DO_QUECTEL=1; DO_BT=1; DO_CF=1; DO_TS=1
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP=/opt/pi-sip-gateway
CONF=/etc/pi-sip-gateway
AST=/etc/asterisk

while [ $# -gt 0 ]; do
  case "$1" in
    --no-dongle) DO_DONGLE=0 ;;
    --no-quectel) DO_QUECTEL=0 ;;
    --no-bluetooth) DO_BT=0 ;;
    --no-cloudflared) DO_CF=0 ;;
    --no-tailscale) DO_TS=0 ;;
    --from-dir) shift; SRC_DIR="$(cd "${1:?--from-dir needs a directory}" && pwd)" ;;
    -h|--help) echo "Usage: $0 [--no-dongle] [--no-quectel] [--no-bluetooth] [--no-cloudflared] [--no-tailscale] [--from-dir DIR]"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

step() { echo; echo "==> $*"; }

check_system() {
  step "Checking system"
  [ "$(id -u)" -eq 0 ] || { echo "ERROR: run as root (sudo ./install.sh)" >&2; exit 1; }
  local ver=""
  if [ -r /etc/os-release ]; then
    ver="$(. /etc/os-release; echo "${VERSION_ID:-}")"
  fi
  [ "$ver" = "12" ] || echo "WARN: expected Debian 12 (Bookworm), found VERSION_ID='${ver}'. Continuing."
  echo "Architecture: $(dpkg --print-architecture 2>/dev/null || uname -m)"
}

install_packages() {
  step "Installing packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y asterisk asterisk-dev asterisk-modules asterisk-core-sounds-en-gsm \
    python3 python3-venv python3-pip git build-essential cmake pkg-config \
    libsqlite3-dev libasound2-dev bluez bluez-tools usb-modeswitch usb-modeswitch-data \
    curl jq openssl rfkill libbluetooth-dev rsync
}

copy_app() {
  step "Copying application to $APP"
  mkdir -p "$APP"
  local item
  for item in gateway scripts asterisk systemd requirements.txt install.sh env.example README.md; do
    [ -e "$SRC_DIR/$item" ] || continue
    if [ "$SRC_DIR" = "$APP" ]; then continue; fi
    if [ -d "$SRC_DIR/$item" ]; then
      mkdir -p "$APP/$item"
      rsync -a --delete --exclude '__pycache__' "$SRC_DIR/$item/" "$APP/$item/"
    else
      cp -f "$SRC_DIR/$item" "$APP/$item"
    fi
  done
  chmod +x "$APP"/scripts/*.sh "$APP/install.sh" 2>/dev/null || true
}

build_modems() {
  if [ "$DO_DONGLE" -eq 1 ]; then
    step "Building chan_dongle"
    "$APP/scripts/build-chan-dongle.sh" || echo "WARN: chan_dongle build failed; USB modem support of that type unavailable"
  fi
  if [ "$DO_QUECTEL" -eq 1 ]; then
    step "Building chan_quectel"
    "$APP/scripts/build-chan-quectel.sh" || echo "WARN: chan_quectel build failed; USB modem support of that type unavailable"
  fi
}

setup_bluetooth() {
  [ "$DO_BT" -eq 1 ] || return 0
  step "Setting up Bluetooth"
  "$APP/scripts/setup-bluetooth.sh" || echo "WARN: Bluetooth setup failed"
  if ! find /usr/lib /usr/lib64 -path '*asterisk/modules/chan_mobile.so' 2>/dev/null | grep -q .; then
    echo "################################################################"
    echo "WARN: chan_mobile.so was not found. The Debian Asterisk build lacks"
    echo "WARN: chan_mobile, so Bluetooth phones will NOT work. See the README"
    echo "WARN: section 'Building Asterisk from source'."
    echo "################################################################"
  fi
}

AMI_SECRET=""
configure_asterisk() {
  step "Configuring Asterisk"
  local bk="$AST/backup-$(date +%Y%m%d%H%M%S)" f base
  mkdir -p "$bk"
  for f in "$APP"/asterisk/*.conf; do
    base="$(basename "$f")"
    [ -f "$AST/$base" ] && cp -a "$AST/$base" "$bk/$base"
  done

  if [ -f "$CONF/env" ] && grep -q '^PSG_AMI_SECRET=' "$CONF/env"; then
    AMI_SECRET="$(grep '^PSG_AMI_SECRET=' "$CONF/env" | head -1 | cut -d= -f2-)"
  fi
  if [ -z "$AMI_SECRET" ] || [ "$AMI_SECRET" = "__AMI_SECRET__" ]; then
    AMI_SECRET="$(openssl rand -hex 24)"
  fi

  cp -f "$APP"/asterisk/*.conf "$AST/"
  sed -i "s/__AMI_SECRET__/$AMI_SECRET/g" "$AST/manager.conf"

  for f in pjsip_gen extensions_gen rtp_gen dongle_gen quectel_gen mobile_gen; do
    [ -f "$AST/$f.conf" ] || : > "$AST/$f.conf"
  done
  if ! grep -q 'rtpstart' "$AST/rtp_gen.conf"; then
    printf 'rtpstart=10000\nrtpend=20000\n' > "$AST/rtp_gen.conf"
  fi
  chown -R asterisk:asterisk "$AST"
  mkdir -p /var/log/asterisk/cdr-csv
  chown -R asterisk:asterisk /var/log/asterisk
}

setup_asterisk_service() {
  step "Installing Asterisk systemd override and (re)starting Asterisk"
  mkdir -p /etc/systemd/system/asterisk.service.d
  cp -f "$APP/systemd/asterisk-override.conf" /etc/systemd/system/asterisk.service.d/override.conf
  usermod -aG dialout,bluetooth asterisk 2>/dev/null || true
  systemctl daemon-reload
  systemctl enable asterisk
  systemctl restart asterisk
  local i
  for i in $(seq 1 20); do
    if asterisk -rx "core show version" >/dev/null 2>&1; then
      echo "Asterisk is up."
      return 0
    fi
    sleep 1
  done
  echo "WARN: Asterisk did not respond within 20 s; check 'journalctl -u asterisk'"
}

setup_python() {
  step "Creating Python virtualenv"
  [ -d "$APP/.venv" ] || python3 -m venv "$APP/.venv"
  "$APP/.venv/bin/pip" install --upgrade pip
  "$APP/.venv/bin/pip" install -r "$APP/requirements.txt"
}

setup_app_service() {
  step "Configuring and starting pi-sip-gateway"
  mkdir -p "$CONF" /var/lib/pi-sip-gateway
  if [ -f "$CONF/env" ] && grep -q '^PSG_' "$CONF/env"; then
    echo "Keeping existing $CONF/env"
  else
    sed "s/__AMI_SECRET__/$AMI_SECRET/g" "$APP/env.example" > "$CONF/env"
  fi
  chmod 600 "$CONF/env"
  "$APP/scripts/gen-cert.sh"
  cp -f "$APP/systemd/pi-sip-gateway.service" /etc/systemd/system/pi-sip-gateway.service
  systemctl daemon-reload
  systemctl enable pi-sip-gateway.service
  systemctl restart pi-sip-gateway.service
}

optional_tunnels() {
  if [ "$DO_CF" -eq 1 ]; then
    step "Installing cloudflared"
    "$APP/scripts/install-cloudflared.sh" || echo "WARN: cloudflared install failed"
  fi
  if [ "$DO_TS" -eq 1 ]; then
    step "Installing tailscale"
    "$APP/scripts/install-tailscale.sh" || echo "WARN: tailscale install failed"
  fi
}

final_banner() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  step "Installation complete"
  echo "  Web UI (LAN):   https://${ip:-<ip>}:8443   (self-signed certificate warning is expected)"
  echo "  Web UI (local): http://127.0.0.1:8080       (for the tunnel)"
  echo
  echo "Open the UI and create the admin account."
  echo "SIP port 5060/UDP+TCP and RTP 10000-20000/UDP are open on the LAN."
  echo "Logs: journalctl -u pi-sip-gateway -f"
}

check_system
install_packages
copy_app
build_modems
setup_bluetooth
configure_asterisk
setup_asterisk_service
setup_python
setup_app_service
optional_tunnels
final_banner
