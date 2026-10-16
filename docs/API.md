# pi-sip-gateway HTTP API contract

Backend: FastAPI in `gateway/main.py`. Frontend: static SPA in `gateway/static/`.
All API routes live under `/api/`. JSON in, JSON out. Errors are `{"detail": "message"}` with
4xx/5xx status. Every `/api/*` route except `/api/me`, `/api/setup`, `/api/login` requires a
valid session cookie (`psg_session`); unauthenticated calls get **401**.

The backend auto-regenerates Asterisk config and reloads after every write to
extensions / trunks / routes / remote settings. Responses to those writes include
`"applied": {"changed": [...files], "reload": [{"cmd": "...", "output": "..."}]}`.

## Auth
| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/me | – | `{"setup_needed": bool, "user": "admin"|null, "mock": bool}` |
| POST | /api/setup | `{"username","password"}` | 200 `{"ok":true}`; 409 if a user already exists. Logs the user in (sets cookie). |
| POST | /api/login | `{"username","password"}` | 200 `{"ok":true}` + cookie; 401 on failure |
| POST | /api/logout | – | `{"ok":true}` clears cookie |
| POST | /api/password | `{"password"}` | change own password |

## Dashboard
`GET /api/status` →
```json
{
  "asterisk": {"connected": true, "version": "Asterisk Call Manager/7.0.3"},
  "extensions": [{"ext":"101","name":"Desk","webrtc":1,"registered":true,"contacts":["sip:101@192.168.1.5:5060"],"web_registered":false}],
  "trunks": [{"name":"dongle0","tech":"dongle","label":"Vodafone SIM","enabled":1,"live":{"state":"Free","rssi":"22","provider":"Vodafone","number":"", "connected":""}}],
  "channels": [{"channel":"PJSIP/101-00000001","callerid":"101","exten":"0912345","state":"Up","duration":"00:00:12","application":"Dial"}],
  "network": {"lan_ip":"192.168.1.10","public_ip":"203.0.113.5","hostname":"pbx"},
  "cloudflared": {"installed":true,"active":true},
  "tailscale": {"installed":true,"running":true,"ip":"100.64.0.3","hostname":"pbx"}
}
```
`live` is `null` for a trunk the driver does not report.

## Extensions
| Method | Path | Body |
|---|---|---|
| GET | /api/extensions | → `[{"ext","name","secret","webrtc","created_at"}]` |
| POST | /api/extensions | `{"ext":"101","name":"Desk","secret":"optional - generated if empty","webrtc":true}` → the created row |
| PUT | /api/extensions/{ext} | any of `name, secret, webrtc` |
| DELETE | /api/extensions/{ext} | |

`ext` must be 2–8 digits. Rules in `astconf.valid_ext`.

## Trunks
Trunk row: `{"name":"dongle0","tech":"dongle"|"quectel"|"mobile","label":"...", "config":{...}, "enabled":1}`
- dongle/quectel config: `{"imei":"...", "imsi":"...", "audio":"/dev/ttyUSB1", "data":"/dev/ttyUSB2", "rxgain":0,"txgain":0, "uac":false}` (imei OR audio+data required)
- mobile config: `{"address":"AA:BB:CC:DD:EE:FF","port":3}`

| Method | Path | Body / Response |
|---|---|---|
| GET | /api/trunks | `[trunk rows with "live": {...}|null]` |
| POST | /api/trunks | trunk row (without live) |
| PUT | /api/trunks/{name} | any of label, config, enabled |
| DELETE | /api/trunks/{name} | |
| GET | /api/trunks/discover/usb | `{"devices":[{"tech":"dongle","name":"dongle0","imei":"..","imsi":"..","audio":"..","data":".."}], "ports":[{"id":"usb-HUAWEI_...-if01-port0","dev":"/dev/ttyUSB1"}], "drivers":{"chan_dongle.so":true,"chan_quectel.so":false,"chan_mobile.so":true}}` |
| GET | /api/trunks/discover/bluetooth | `{"phones":[{"address","name","usable","type","port"}], "error"?:"..."}` (takes ~10 s) |
| GET | /api/bluetooth/adapters | `{"adapters":[{"address","name","default"}]}` |
| POST | /api/bluetooth/pair | `{"address"}` → `{"ok":bool,"output":"..."}` (up to 90 s; the phone shows a pairing prompt) |
| POST | /api/bluetooth/adapter | `{"address"}` selects the adapter used by chan_mobile (stored in settings `bt_adapter`) |

Trunk `name` must match `^[A-Za-z0-9_]{1,24}$`.

## Routing
Outbound route: `{"id":1,"label":"Everything","pattern":"_X.","strip":0,"prepend":"","trunks":["dongle0","phone1"],"enabled":1}`
`pattern` is an Asterisk dialplan pattern (`_X.` = anything, `_0X.` = starts with 0, `_+91X.`, `_NXXXXXXXXX`).
Asterisk picks the most specific matching pattern, not list order. `trunks` is the failover order.

Inbound route: `{"id":1,"trunk":"dongle0","destinations":["101","102"],"ring_time":30,"enabled":1}`
A trunk without an inbound route rings every extension.

| Method | Path |
|---|---|
| GET/POST | /api/routes/outbound |
| PUT/DELETE | /api/routes/outbound/{id} |
| GET/POST | /api/routes/inbound |
| PUT/DELETE | /api/routes/inbound/{id} |

## Calls
| Method | Path | Body / Response |
|---|---|---|
| GET | /api/cdr?limit=200 | `[{"start","src","dst","direction","trunk","disposition","billsec","duration","clid","channel","dstchannel","userfield"}]` newest first |
| GET | /api/channels | active channels, same shape as status.channels |
| POST | /api/calls/originate | `{"ext":"101","number":"0912345"}` rings ext 101 first, then dials number through outbound routes. → `{"ok":true}` |
| POST | /api/calls/hangup | `{"channel":"PJSIP/101-00000001"}` |

## SMS
| Method | Path | Body / Response |
|---|---|---|
| GET | /api/sms?limit=200 | `[{"id","trunk","direction":"in"|"out","number","body","status","ts"}]` newest first |
| POST | /api/sms/send | `{"trunk":"dongle0","number":"+91...","body":"hi"}` → `{"ok":bool,"output":"..."}` |

## Remote access
`GET /api/remote` →
```json
{
  "cloudflared": {"installed":true,"active":true,"log":"last 30 journal lines"},
  "tailscale": {"installed":true,"running":false,"ip":null,"hostname":null,"auth_url":null},
  "network": {"lan_ip":"...","public_ip":"...","external_address":"","local_net":"","stun":"stun.l.google.com:19302"},
  "turn": {"mode":"none"|"custom"|"cloudflare","host":"","port":"3478","user":"","cf_key_id":"","has_pass":false,"has_cf_token":false,"last_refresh":null,"last_error":null},
  "public_hostname": "pbx.example.com"
}
```
| Method | Path | Body |
|---|---|---|
| POST | /api/remote/cloudflare | `{"token":"eyJ..."}` installs the tunnel service via `cloudflared service install TOKEN` → `{"ok","output"}` |
| DELETE | /api/remote/cloudflare | `cloudflared service uninstall` |
| POST | /api/remote/tailscale/up | starts `tailscale up` in the background → `{"auth_url": "https://login.tailscale.com/a/...", "running": bool}`; call GET /api/remote again to poll |
| POST | /api/remote/tailscale/down | |
| POST | /api/remote/network | `{"external_address":"203.0.113.5 or hostname","local_net":"192.168.1.0/24,100.64.0.0/10","stun":"host:port","public_hostname":"pbx.example.com"}` |
| POST | /api/remote/turn | `{"mode":"none"|"custom"|"cloudflare","host","port","user","pass","cf_key_id","cf_token"}` – empty `pass`/`cf_token` keeps the stored one |
| POST | /api/remote/turn/refresh | force a Cloudflare TURN credential refresh → the `turn` object |
| GET | /api/ice | `{"iceServers":[{"urls":["stun:..."]},{"urls":["turn:host:3478?transport=udp","turn:host:3478?transport=tcp"],"username":"..","credential":".."}]}` for the browser softphone |

## Softphone support
- `GET /api/softphone` → `{"ws_url":"wss://<host>/ws" (derived from the request's Host and scheme), "domain":"<host without port>", "extensions":[{"ext":"101","name":"Desk","secret":"..."}]}` (only extensions with webrtc enabled; the browser logs in as `<ext>-web`)
- `WS /ws` – transparent proxy to Asterisk's SIP-over-WebSocket (`ws://127.0.0.1:8088/ws`, subprotocol `sip`). No session needed; SIP digest auth protects it.

## System
| Method | Path | |
|---|---|---|
| POST | /api/apply | regenerate all config + reload → `{"changed":[...],"reload":[...]}` |
| GET | /api/events?since=0 | last AMI events (for debugging) `[{...}]` |
| GET | /api/logs?unit=asterisk|cloudflared|pi-sip-gateway&lines=100 | `{"text":"..."}` |
| POST | /api/system/restart-asterisk | `systemctl restart asterisk` |
| GET | /api/config/preview | `{"pjsip_gen.conf":"...", "extensions_gen.conf":"...", ...}` generated text, for the Advanced page |
