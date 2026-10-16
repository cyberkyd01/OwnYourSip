#!/usr/bin/env bash
# Install cloudflared from Cloudflare's apt repo. The web UI installs the service.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get install -y curl gnupg ca-certificates
mkdir -p /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main" \
  > /etc/apt/sources.list.d/cloudflared.list
apt-get update
apt-get install -y cloudflared
echo "cloudflared installed."
