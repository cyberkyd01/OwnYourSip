#!/usr/bin/env bash
# Install Tailscale. The web UI runs `tailscale up`.
set -euo pipefail
curl -fsSL https://tailscale.com/install.sh | sh
systemctl enable --now tailscaled
echo "tailscale installed."
