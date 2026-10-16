# pi-sip-gateway

Turn a Raspberry Pi into your own SIP gateway for mobile numbers. Put a SIM in a
USB modem, or pair your existing phone over Bluetooth, and every SIP app you own
(Zoiper, X-Lite, MicroSIP, a browser, another Asterisk/FreePBX) can make and
receive calls on that number. No cloud calling provider in the loop.

```
 SIM in USB modem ──┐                              ┌── Zoiper / X-Lite on LAN
 SIM in USB modem ──┼── Raspberry Pi ── Asterisk ──┼── Browser softphone (anywhere, via Cloudflare)
 Phone (Bluetooth) ─┘      web UI :8443            ├── Zoiper on phone/PC anywhere (via Tailscale)
                                                   └── Your other PBX (SIP trunk)
```

## What you get

- **Web UI** for everything: extensions (SIP accounts), trunks, routing, call log, SMS,
  remote access, built-in browser softphone. No config files to edit.
- **USB modem trunks** via chan_dongle (Huawei E1550/E173/E1750/E153 with voice
  firmware) and chan_quectel (Quectel EC25/EC20, SimCom SIM7600). This is the stable path.
- **Bluetooth phone trunks** via chan_mobile. Your Android/iPhone stays the "modem";
  the Pi is its hands-free headset. Works, but see the caveats below.
- **Outbound routing** by dial pattern with trunk failover order. **Inbound routing**
  per trunk to one or more extensions (ring groups).
- **Remote access** without port forwarding: Cloudflare Tunnel for the web UI and
  browser calling, Tailscale for Zoiper-style SIP clients.
- **SMS** send/receive on USB modems.

## Hardware

| Item | Notes |
|---|---|
| Raspberry Pi 4 or 5 (Pi Zero 2 W works for 1-2 trunks) | Raspberry Pi OS **Bookworm 64-bit Lite** |
| USB modem with **voice support** | Huawei E1550, E173, E1750, E153, E156; Quectel EC25 mini-PCIe on a USB carrier; SimCom SIM7600 |
| Powered USB hub | Modems are power hungry; a bare Pi port resets them under load |
| For Bluetooth phones | The Pi's built-in radio works. A USB Bluetooth dongle is better in a busy 2.4 GHz environment |

Many cheap 4G dongles (Huawei E3372 HiLink, most "WiFi stick" modems) have **no voice**.
Check for voice/CSD support before buying.

## Install

On a fresh Raspberry Pi OS Bookworm 64-bit Lite, as a user with sudo:

```bash
sudo apt-get install -y git
git clone <this repo> pi-sip-gateway
cd pi-sip-gateway
sudo ./install.sh
```

Flags: `--no-dongle`, `--no-quectel`, `--no-bluetooth`, `--no-cloudflared`, `--no-tailscale`.
The installer is idempotent; re-run it to upgrade. It takes 10-20 minutes on a Pi 4
(chan_dongle and chan_quectel are compiled from source).

When it finishes it prints the URL. Open `https://<pi-ip>:8443` (accept the self-signed
certificate warning) and create the admin account.

## First setup, step by step

1. **Extensions** → Add. `101`, name "Desk", leave password empty to generate one,
   keep "browser softphone login" on. Repeat for every device/person.
2. **Trunks** → **Scan USB modems**. Plug the modem in first and wait 30 s for
   usb-modeswitch. Click **Add as trunk** on the discovered device, name it `dongle0`.
   Its state should go to `Free` within a minute.
   For a Bluetooth phone: pick the adapter, **Search for phones**, **Pair** (accept on the
   phone), then **Add as trunk**.
3. **Routing** → Outbound: one route, pattern `_X.`, trunks `[dongle0]`. That sends every
   dialed number out through the SIM. Inbound: leave empty to ring all extensions, or
   pick who rings for each trunk.
4. **Extensions** → **Show config** on an extension and type those values into Zoiper,
   X-Lite or any SIP client on your LAN. Dial `*43` for an echo test, then a real number.
5. **Softphone** page: pick an extension, Connect, dial. This works in any browser
   that reaches the UI over HTTPS.

## Remote access

Cloudflare Tunnel carries HTTP and WebSocket traffic only. It **cannot** carry SIP over
UDP or RTP audio. So remote access is split in two:

### Browser calling from anywhere (Cloudflare Tunnel)

1. Cloudflare Zero Trust dashboard → Networks → Tunnels → Create tunnel (Cloudflared).
   Copy the token.
2. UI → **Remote Access** → paste the token → Install. The tunnel comes up in a few seconds.
3. In the tunnel's Public Hostname tab add `pbx.yourdomain.com` → `HTTP` → `localhost:8080`.
4. Strongly recommended: add a Cloudflare Access policy (Zero Trust → Access →
   Applications) in front of that hostname so only you can reach the admin UI.
5. Open `https://pbx.yourdomain.com`, Softphone page, connect.

Signaling goes through the tunnel. Audio uses WebRTC/ICE and needs a path between the
browser and the Pi:
- On the same LAN or over Tailscale: direct, nothing to do.
- From the open internet: usually works through STUN on home NATs. If you get
  one-way or no audio, set a **TURN** server on the Remote Access page. Cloudflare's
  TURN service (Realtime → TURN keys; free tier) is supported natively: paste the key ID
  and API token and the Pi refreshes short-lived credentials itself.

### Zoiper / X-Lite / FreePBX from anywhere (Tailscale)

1. UI → Remote Access → Tailscale → **Connect**, open the login link, approve.
2. Install Tailscale on the laptop or phone that runs the SIP client.
3. Point the SIP client at the Pi's Tailscale IP (shown on the Dashboard), port 5060,
   UDP or TCP. Everything else is identical to the LAN setup.

Tailscale is free for personal use and needs no port forwarding on either side.

### Direct port forwarding (not recommended)

If you must expose SIP directly, forward UDP/TCP 5060 and UDP 10000-20000 to the Pi,
set **External address** and **Local networks** on the Remote Access page, and put
fail2ban in front. Expect constant scanning on 5060.

## How calls flow

- **Outbound**: a SIP client registered as `101` dials `0912345`. The dialplan context
  `from-internal` matches the outbound route pattern, applies strip/prepend, then dials
  trunks in the route's order until one succeeds.
- **Inbound**: the modem/phone receives a call. The driver drops it into context
  `from-trunk-<name>`, which rings the extensions in that trunk's inbound route
  (or all extensions). Both the SIP device and the browser login of an extension ring.
- **Browser login**: an extension `101` with browser login enabled also gets a
  WebRTC endpoint `101-web` with the same password. The Softphone page uses it.
  `/ws` on the web app proxies SIP-over-WebSocket to Asterisk, so one hostname and one
  tunnel route cover both the UI and the calls.

Generated Asterisk config lives in `/etc/asterisk/*_gen.conf`. The Advanced page
shows it; never edit it by hand.

## Bluetooth phone caveats

- Audio is mono 8 kHz (the hands-free profile), fine for voice, not for music.
- One call at a time per phone.
- chan_mobile is deprecated upstream. The Debian `asterisk-modules` package ships it,
  but if the installer warns that `chan_mobile.so` is missing you need to build Asterisk
  from source with `chan_mobile` enabled in `menuselect` (Add-ons section). That is a
  one-hour build on a Pi 4 and is outside this installer's scope.
- The installer runs `bluetoothd` in compat mode with audio profiles disabled and
  registers a Hands-Free SDP record, and runs Asterisk as root so it can open raw
  Bluetooth sockets. Keep the Pi dedicated to this job.
- The phone must stay within a few metres and must not be paired to another
  hands-free device at the same time (car kit, laptop).
- Some phones (recent Samsung, iOS) are picky about accepting an unknown hands-free unit.
  If pairing succeeds but the trunk never shows `Connected`, try a USB Bluetooth dongle.

## Security notes

- The admin UI has its own login; put Cloudflare Access in front of it when tunneled.
- SIP registration uses digest auth with generated 16-character passwords. Asterisk's
  HTTP/WebSocket and manager ports listen on localhost only.
- Asterisk runs as root (see `systemd/asterisk-override.conf` for why). The app runs as root.
- Nothing listens on the public internet unless you forward ports yourself.

## Development on a laptop (no Asterisk)

```bash
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
PSG_MOCK=1 PSG_DATA_DIR=./.devdata python -m gateway.main
```
Open http://127.0.0.1:8080. Generated config is written to `.devdata/asterisk-out/`.
Status, discovery and reloads are no-ops in mock mode.

## Layout

```
install.sh            one-shot installer for Raspberry Pi OS Bookworm
asterisk/             base Asterisk configs (copied to /etc/asterisk)
gateway/              FastAPI backend (main.py, ami.py, astconf.py, trunks.py, remote.py ...)
gateway/static/       web UI and browser softphone
scripts/              driver builds, Bluetooth setup, pairing, cert, cloudflared, tailscale
systemd/              service units
docs/API.md           HTTP API contract
```

## Troubleshooting

| Symptom | Check |
|---|---|
| Modem not discovered | `lsusb` shows it? `ls /dev/ttyUSB*` shows 2-3 ports? Wait for usb-modeswitch. Not all modems have voice. |
| Trunk stuck in `Not connected` | `journalctl -u asterisk -f`, SIM PIN enabled? Remove PIN on a phone first. |
| Calls connect, no audio | Codec: modems only do voice via the driver's audio port; check `rxgain/txgain`. For browser calls, set TURN. |
| Browser softphone says "no media devices" | The page must be HTTPS. Use the 8443 URL or the Cloudflare hostname. |
| Inbound calls hang up immediately | No extensions registered. Dashboard shows registration state. |
| Bluetooth phone never `Connected` | `bluetoothctl info <addr>` shows Paired and Trusted? Phone's Bluetooth on? Unpair from other headsets. |
