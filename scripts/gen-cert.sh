#!/usr/bin/env bash
# Create a self-signed certificate if none exists.
set -euo pipefail
DIR=/etc/pi-sip-gateway
CERT="$DIR/cert.pem"
KEY="$DIR/key.pem"
mkdir -p "$DIR"
if [ -s "$CERT" ] && [ -s "$KEY" ]; then
  echo "Certificate already exists: $CERT"
  exit 0
fi
HOST="$(hostname)"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
SAN="DNS:${HOST},DNS:${HOST}.local,DNS:localhost,IP:127.0.0.1"
[ -n "$IP" ] && SAN="${SAN},IP:${IP}"
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$KEY" -out "$CERT" -subj "/CN=${HOST}" \
  -addext "subjectAltName=${SAN}"
chmod 600 "$KEY"
chmod 644 "$CERT"
echo "Generated self-signed certificate ($SAN)"
