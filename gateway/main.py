"""pi-sip-gateway web backend: REST API (docs/API.md), SIP WebSocket proxy, static UI."""
import asyncio
import base64
import contextlib
import ipaddress
import json
import logging
import os
import re
import secrets
import socket
import time
import urllib.parse
from collections import defaultdict

import uvicorn
import websockets
from websockets.exceptions import WebSocketException
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketState

from . import astconf, remote
from .ami import AMI, AMIError
from .astconf import ConfigWriter
from .auth import COOKIE, Sessions, hash_password, load_or_create_secret, verify_password
from .cdr import read_cdr
from .db import DB
from .settings import (AMI_HOST, AMI_PORT, AMI_SECRET, AMI_USER, AST_CONF_DIR, AST_WS_URL, CDR_CSV,
                       DATA_DIR, HTTP_BIND, HTTP_PORT, HTTPS_BIND, HTTPS_PORT, MOCK, SCRIPTS_DIR,
                       SECRET_KEY, SSL_CERT, SSL_KEY)
from .trunks import TrunkService

log = logging.getLogger("gateway")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
SESSION_TTL = 7 * 86400
TURN_REFRESH_EVERY = 6 * 3600
REGISTERED_STATES = ("Reachable", "Unknown", "NonQualified")

NUMBER_RE = re.compile(r"^[0-9+*#]{2,20}$")
SMS_NUMBER_RE = re.compile(r"^\+?[0-9]{2,20}$")
SECRET_RE = re.compile(r"^[^\s;\[\]\"]{4,64}$")
PATTERN_RE = re.compile(r"^[0-9A-Za-z_+*#.!\[\]\-]{1,40}$")
PREPEND_RE = re.compile(r"^[0-9+*#]{0,20}$")
MAC_RE = re.compile(r"^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$")
HOST_RE = re.compile(r"^[A-Za-z0-9.\-]{0,253}$")
HOSTPORT_RE = re.compile(r"^[A-Za-z0-9.\-]+(:\d{1,5})?$")
DEV_RE = re.compile(r"^/dev/[A-Za-z0-9_./\-:]+$")

db = DB()
ami = AMI(AMI_HOST, AMI_PORT, AMI_USER, AMI_SECRET)
trunk_svc = TrunkService(ami, SCRIPTS_DIR)
writer = ConfigWriter(AST_CONF_DIR if not MOCK else os.path.join(DATA_DIR, "asterisk-out"))
sessions = Sessions(SECRET_KEY or load_or_create_secret(os.path.join(DATA_DIR, "secret.key")), SESSION_TTL)

_apply_lock = asyncio.Lock()


# ================================================================ helpers
@contextlib.contextmanager
def ami_errors():
    """Turn AMI failures into 503 responses."""
    try:
        yield
    except AMIError as e:
        raise HTTPException(503, str(e))


async def body(request: Request) -> dict:
    try:
        data = await request.json()
    except ValueError:
        raise HTTPException(400, "body must be JSON")
    if not isinstance(data, dict):
        raise HTTPException(400, "body must be a JSON object")
    return data


def text(data: dict, key: str, maxlen: int = 64) -> str:
    v = data.get(key)
    v = "" if v is None else str(v).strip()
    if len(v) > maxlen:
        raise HTTPException(400, f"{key} is too long (max {maxlen})")
    return v


def integer(data: dict, key: str, default: int, lo: int, hi: int) -> int:
    raw = data.get(key)
    try:
        v = default if raw in (None, "") else int(raw)
    except (TypeError, ValueError):
        raise HTTPException(400, f"{key} must be a number")
    if not lo <= v <= hi:
        raise HTTPException(400, f"{key} must be between {lo} and {hi}")
    return v


def config_files() -> dict[str, str]:
    """The generated files exactly as ConfigWriter.write_all writes them."""
    exts, trunks, s = db.extensions(), db.trunks(), db.all_settings()
    return {
        "pjsip_gen.conf": astconf.gen_pjsip(exts, s),
        "extensions_gen.conf": astconf.gen_dialplan(exts, trunks, db.outbound_routes(), db.inbound_routes()),
        "rtp_gen.conf": astconf.gen_rtp(s),
        "dongle_gen.conf": astconf.gen_dongle(trunks),
        "quectel_gen.conf": astconf.gen_quectel(trunks),
        "mobile_gen.conf": astconf.gen_mobile(trunks, s),
    }


async def apply() -> dict:
    """Regenerate the *_gen.conf files and reload what changed."""
    async with _apply_lock:
        changed = await asyncio.to_thread(writer.write_all, db)
        reload = []
        if not MOCK:
            for name in changed:
                for cmd in astconf.RELOAD_COMMANDS.get(name, []):
                    try:
                        out = await ami.cli(cmd)
                    except AMIError as e:
                        out = f"ERROR: {e}"
                    reload.append({"cmd": cmd, "output": out})
        return {"changed": changed, "reload": reload}


def is_https(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"


def set_session(request: Request, response: Response, username: str):
    response.set_cookie(COOKIE, sessions.make(username), max_age=SESSION_TTL, httponly=True,
                        samesite="lax", secure=is_https(request))


def current_user(request: Request) -> str:
    user = sessions.check(request.cookies.get(COOKIE))
    if not user:
        raise HTTPException(401, "not logged in")
    return user


# ======================================================= background tasks
async def on_ami_event(ev: dict):
    if ev.get("Event") != "UserEvent" or ev.get("UserEvent") != "SMSIn":
        return
    body64 = ev.get("Body64") or ""
    try:
        text_body = base64.b64decode(body64).decode("utf-8", errors="replace") if body64 else ""
    except ValueError:
        text_body = ""
    if not text_body:
        text_body = ev.get("Body") or ""
    trunk, sender = ev.get("Trunk", ""), ev.get("From", "")
    await asyncio.to_thread(db.add_sms, trunk, "in", sender, text_body)
    log.info("SMS in on %s from %s", trunk, sender)


async def refresh_cf_turn() -> dict:
    """Fetch fresh Cloudflare TURN credentials into settings and apply them."""
    creds = await remote.cloudflare_turn_credentials(db.get("cf_turn_key_id", ""), db.get("cf_turn_token", ""))
    if creds["error"]:
        db.set("turn_last_error", creds["error"])
        log.warning("Cloudflare TURN refresh failed: %s", creds["error"])
    else:
        for key, val in (("turn_host", creds["host"]), ("turn_port", creds["port"]),
                         ("turn_user", creds["user"]), ("turn_pass", creds["pass"]),
                         ("turn_last_refresh", str(time.time())), ("turn_last_error", "")):
            db.set(key, val)
    return await apply()


async def turn_refresher():
    """Keep Cloudflare TURN credentials (24 h TTL) refreshed every 6 h, also across reboots."""
    while True:
        if db.get("turn_mode") == "cloudflare":
            last = float(db.get("turn_last_refresh") or 0)
            if time.time() - last >= TURN_REFRESH_EVERY:
                try:
                    await refresh_cf_turn()
                except Exception:  # noqa: BLE001
                    log.exception("TURN refresh failed")
        await asyncio.sleep(900)


async def initial_apply():
    await asyncio.sleep(3)
    try:
        log.info("initial apply: %s", await apply())
    except Exception:  # noqa: BLE001
        log.exception("initial apply failed")


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    if not MOCK:
        ami.handlers.append(on_ami_event)
        ami.start()
    tasks = [asyncio.create_task(initial_apply()), asyncio.create_task(turn_refresher())]
    yield
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await ami.stop()


app = FastAPI(title="pi-sip-gateway", lifespan=lifespan)
api = APIRouter(prefix="/api", dependencies=[Depends(current_user)])


# ================================================================== auth
@app.get("/api/me")
async def me(request: Request):
    has_user = db.one("SELECT id FROM users LIMIT 1") is not None
    return {"setup_needed": not has_user, "user": sessions.check(request.cookies.get(COOKIE)), "mock": MOCK}


def credentials(data: dict) -> tuple[str, str]:
    username, password = text(data, "username"), str(data.get("password") or "")
    if not re.match(r"^[A-Za-z0-9_.\-@]{1,64}$", username):
        raise HTTPException(400, "invalid username")
    return username, password


@app.post("/api/setup")
async def setup(request: Request, response: Response):
    username, password = credentials(await body(request))
    if len(password) < 6:
        raise HTTPException(400, "password must be at least 6 characters")
    if db.one("SELECT id FROM users LIMIT 1"):
        raise HTTPException(409, "already set up")
    pw_hash, salt = hash_password(password)
    db.x("INSERT INTO users(username,pw_hash,salt,created_at) VALUES(?,?,?,?)",
         (username, pw_hash, salt, time.time()))
    set_session(request, response, username)
    return {"ok": True}


@app.post("/api/login")
async def login(request: Request, response: Response):
    username, password = credentials(await body(request))
    u = db.one("SELECT * FROM users WHERE username=?", (username,))
    if not u or not verify_password(password, u["pw_hash"], u["salt"]):
        raise HTTPException(401, "wrong username or password")
    set_session(request, response, username)
    return {"ok": True}


@app.post("/api/logout")
async def logout(response: Response):
    response.delete_cookie(COOKIE)
    return {"ok": True}


@api.post("/password")
async def change_password(request: Request, user: str = Depends(current_user)):
    password = str((await body(request)).get("password") or "")
    if len(password) < 6:
        raise HTTPException(400, "password must be at least 6 characters")
    pw_hash, salt = hash_password(password)
    db.x("UPDATE users SET pw_hash=?, salt=? WHERE username=?", (pw_hash, salt, user))
    return {"ok": True}


# ============================================================= dashboard
async def registrations() -> dict[str, list[str]]:
    """AOR -> URIs of reachable contacts."""
    by_aor: dict[str, list[str]] = defaultdict(list)
    for ev in await ami.events_list("PJSIPShowContacts"):
        if ev.get("Status") in REGISTERED_STATES and ev.get("AOR"):
            by_aor[ev["AOR"]].append(ev.get("Uri", ""))
    return by_aor


async def channels() -> list[dict]:
    if not ami.connected:
        return []
    return [{"channel": ev.get("Channel", ""), "callerid": ev.get("CallerIDNum", ""),
             "exten": ev.get("Exten", ""), "state": ev.get("ChannelStateDesc", ""),
             "duration": ev.get("Duration", ""), "application": ev.get("Application", "")}
            for ev in await ami.events_list("CoreShowChannels")]


async def trunks_with_live() -> list[dict]:
    live = await trunk_svc.live_status() if ami.connected else {}
    rows = db.trunks()
    for t in rows:
        t["live"] = live.get(t["name"])
    return rows


@api.get("/status")
async def status():
    regs: dict[str, list[str]] = {}
    chans: list[dict] = []
    if ami.connected:
        try:
            regs = await registrations()
            chans = await channels()
        except AMIError as e:
            log.warning("status: %s", e)
    exts = [{"ext": e["ext"], "name": e["name"], "webrtc": e["webrtc"],
             "registered": bool(regs.get(e["ext"])), "contacts": regs.get(e["ext"], []),
             "web_registered": bool(regs.get(f"{e['ext']}-web"))} for e in db.extensions()]
    cf, ts, pub, trunks = await asyncio.gather(
        remote.cloudflared_status(with_log=False), remote.tailscale_status(), remote.public_ip(),
        trunks_with_live())
    return {
        "asterisk": {"connected": ami.connected, "version": ami.version if ami.connected else ""},
        "extensions": exts,
        "trunks": trunks,
        "channels": chans,
        "network": {"lan_ip": remote.lan_ip(), "public_ip": pub, "hostname": socket.gethostname()},
        "cloudflared": cf,
        "tailscale": ts,
    }


# ============================================================ extensions
def get_extension(ext: str) -> dict:
    row = db.one("SELECT * FROM extensions WHERE ext=?", (ext,))
    if not row:
        raise HTTPException(404, f"extension {ext} not found")
    return row


def clean_secret(data: dict) -> str:
    secret = text(data, "secret")
    if secret and not SECRET_RE.match(secret):
        raise HTTPException(400, "secret must be 4-64 characters without spaces, quotes, ';' or brackets")
    return secret


@api.get("/extensions")
async def list_extensions():
    return db.extensions()


@api.post("/extensions")
async def create_extension(request: Request):
    data = await body(request)
    ext = text(data, "ext")
    if not astconf.valid_ext(ext):
        raise HTTPException(400, "ext must be 2-8 digits")
    if db.one("SELECT id FROM extensions WHERE ext=?", (ext,)):
        raise HTTPException(409, f"extension {ext} already exists")
    name = text(data, "name") or ext
    secret = clean_secret(data) or secrets.token_urlsafe(12)
    webrtc = 1 if data.get("webrtc", True) else 0
    db.x("INSERT INTO extensions(ext,name,secret,webrtc,created_at) VALUES(?,?,?,?,?)",
         (ext, name, secret, webrtc, time.time()))
    return {**get_extension(ext), "applied": await apply()}


@api.put("/extensions/{ext}")
async def update_extension(ext: str, request: Request):
    data = await body(request)
    row = get_extension(ext)
    name = text(data, "name") if "name" in data else row["name"]
    secret = clean_secret(data) or row["secret"]
    webrtc = (1 if data["webrtc"] else 0) if "webrtc" in data else row["webrtc"]
    db.x("UPDATE extensions SET name=?, secret=?, webrtc=? WHERE ext=?", (name or ext, secret, webrtc, ext))
    return {**get_extension(ext), "applied": await apply()}


@api.delete("/extensions/{ext}")
async def delete_extension(ext: str):
    get_extension(ext)
    db.x("DELETE FROM extensions WHERE ext=?", (ext,))
    for r in db.inbound_routes():
        if ext in r["destinations"]:
            dests = [d for d in r["destinations"] if d != ext]
            db.x("UPDATE inbound_routes SET destinations=? WHERE id=?", (json.dumps(dests), r["id"]))
    return {"ok": True, "applied": await apply()}


# ================================================================ trunks
def get_trunk(name: str) -> dict:
    row = next((t for t in db.trunks() if t["name"] == name), None)
    if not row:
        raise HTTPException(404, f"trunk {name} not found")
    return row


def clean_trunk_config(tech: str, cfg) -> dict:
    if not isinstance(cfg, dict):
        raise HTTPException(400, "config must be an object")
    if tech == "mobile":
        address = text(cfg, "address", 17).upper()
        if not MAC_RE.match(address):
            raise HTTPException(400, "config.address must be a Bluetooth address AA:BB:CC:DD:EE:FF")
        return {"address": address, "port": integer(cfg, "port", 1, 1, 30)}
    out = {"imei": text(cfg, "imei", 20), "imsi": text(cfg, "imsi", 20),
           "audio": text(cfg, "audio", 200), "data": text(cfg, "data", 200),
           "rxgain": integer(cfg, "rxgain", 0, -20, 20), "txgain": integer(cfg, "txgain", 0, -20, 20),
           "uac": bool(cfg.get("uac", False))}
    for key in ("imei", "imsi"):
        if out[key] and not out[key].isdigit():
            raise HTTPException(400, f"config.{key} must be digits")
    for key in ("audio", "data"):
        if out[key] and not DEV_RE.match(out[key]):
            raise HTTPException(400, f"config.{key} must be a /dev path")
    if not out["imei"] and not (out["audio"] and out["data"]):
        raise HTTPException(400, "config needs imei, or both audio and data ports")
    return out


@api.get("/trunks")
async def list_trunks():
    return await trunks_with_live()


@api.post("/trunks")
async def create_trunk(request: Request):
    data = await body(request)
    name, tech = text(data, "name"), text(data, "tech")
    if not astconf.valid_name(name):
        raise HTTPException(400, "name must be 1-24 letters, digits or _")
    if tech not in astconf.TECH_PREFIX:
        raise HTTPException(400, f"tech must be one of {', '.join(astconf.TECH_PREFIX)}")
    if db.one("SELECT id FROM trunks WHERE name=?", (name,)):
        raise HTTPException(409, f"trunk {name} already exists")
    cfg = clean_trunk_config(tech, data.get("config") or {})
    enabled = 1 if data.get("enabled", True) else 0
    db.x("INSERT INTO trunks(name,tech,label,config,enabled,created_at) VALUES(?,?,?,?,?,?)",
         (name, tech, text(data, "label", 100), json.dumps(cfg), enabled, time.time()))
    return {**get_trunk(name), "applied": await apply()}


@api.put("/trunks/{name}")
async def update_trunk(name: str, request: Request):
    data = await body(request)
    row = get_trunk(name)
    label = text(data, "label", 100) if "label" in data else row["label"]
    cfg = clean_trunk_config(row["tech"], data["config"]) if "config" in data else row["config"]
    enabled = (1 if data["enabled"] else 0) if "enabled" in data else row["enabled"]
    db.x("UPDATE trunks SET label=?, config=?, enabled=? WHERE name=?", (label, json.dumps(cfg), enabled, name))
    return {**get_trunk(name), "applied": await apply()}


@api.delete("/trunks/{name}")
async def delete_trunk(name: str):
    get_trunk(name)
    db.x("DELETE FROM trunks WHERE name=?", (name,))
    db.x("DELETE FROM inbound_routes WHERE trunk=?", (name,))
    for r in db.outbound_routes():
        if name in r["trunks"]:
            rest = [t for t in r["trunks"] if t != name]
            db.x("UPDATE outbound_routes SET trunks=? WHERE id=?", (json.dumps(rest), r["id"]))
    return {"ok": True, "applied": await apply()}


@api.get("/trunks/discover/usb")
async def discover_usb():
    if not ami.connected:
        raise HTTPException(503, "Asterisk manager not connected")
    return await trunk_svc.discover_usb()


@api.get("/trunks/discover/bluetooth")
async def discover_bluetooth():
    return await trunk_svc.discover_bluetooth()


# ============================================================= bluetooth
@api.get("/bluetooth/adapters")
async def bluetooth_adapters():
    return await trunk_svc.bt_adapters()


@api.post("/bluetooth/pair")
async def bluetooth_pair(request: Request):
    return await trunk_svc.bt_pair(text(await body(request), "address", 17))


@api.post("/bluetooth/adapter")
async def bluetooth_adapter(request: Request):
    address = text(await body(request), "address", 17).upper()
    if not MAC_RE.match(address):
        raise HTTPException(400, "address must be AA:BB:CC:DD:EE:FF")
    db.set("bt_adapter", address)
    return {"ok": True, "applied": await apply()}


# =============================================================== routing
def clean_outbound(data: dict, row_id: int | None = None) -> tuple:
    pattern = text(data, "pattern", 40)
    if not PATTERN_RE.match(pattern):
        raise HTTPException(400, "pattern must be a dialplan pattern such as _X. or _0X.")
    dup = db.one("SELECT id FROM outbound_routes WHERE pattern=?", (pattern,))
    if dup and dup["id"] != row_id:
        raise HTTPException(409, f"a route for {pattern} already exists")
    prepend = text(data, "prepend", 20)
    if not PREPEND_RE.match(prepend):
        raise HTTPException(400, "prepend may only contain digits, +, * and #")
    trunks = data.get("trunks") or []
    known = {t["name"] for t in db.trunks()}
    if not isinstance(trunks, list) or any(t not in known for t in trunks):
        raise HTTPException(400, "trunks must be a list of existing trunk names")
    return (text(data, "label", 64) or pattern, pattern, integer(data, "strip", 0, 0, 20), prepend,
            json.dumps(trunks), 1 if data.get("enabled", True) else 0)


def clean_inbound(data: dict, row_id: int | None = None) -> tuple:
    trunk = text(data, "trunk")
    get_trunk(trunk)
    dup = db.one("SELECT id FROM inbound_routes WHERE trunk=?", (trunk,))
    if dup and dup["id"] != row_id:
        raise HTTPException(409, f"trunk {trunk} already has an inbound route")
    dests = data.get("destinations") or []
    known = {e["ext"] for e in db.extensions()}
    if not isinstance(dests, list) or any(d not in known for d in dests):
        raise HTTPException(400, "destinations must be a list of existing extensions")
    return (trunk, json.dumps(dests), integer(data, "ring_time", 30, 5, 300),
            1 if data.get("enabled", True) else 0)


def get_route(kind: str, rid: int) -> dict:
    rows = db.outbound_routes() if kind == "outbound" else db.inbound_routes()
    row = next((r for r in rows if r["id"] == rid), None)
    if not row:
        raise HTTPException(404, f"{kind} route {rid} not found")
    return row


@api.get("/routes/outbound")
async def list_outbound():
    return db.outbound_routes()


@api.post("/routes/outbound")
async def create_outbound(request: Request):
    vals = clean_outbound(await body(request))
    rid = db.x("INSERT INTO outbound_routes(label,pattern,strip,prepend,trunks,enabled,created_at) "
               "VALUES(?,?,?,?,?,?,?)", (*vals, time.time()))
    return {**get_route("outbound", rid), "applied": await apply()}


@api.put("/routes/outbound/{rid}")
async def update_outbound(rid: int, request: Request):
    row = get_route("outbound", rid)
    vals = clean_outbound({**row, **await body(request)}, rid)
    db.x("UPDATE outbound_routes SET label=?, pattern=?, strip=?, prepend=?, trunks=?, enabled=? WHERE id=?",
         (*vals, rid))
    return {**get_route("outbound", rid), "applied": await apply()}


@api.delete("/routes/outbound/{rid}")
async def delete_outbound(rid: int):
    get_route("outbound", rid)
    db.x("DELETE FROM outbound_routes WHERE id=?", (rid,))
    return {"ok": True, "applied": await apply()}


@api.get("/routes/inbound")
async def list_inbound():
    return db.inbound_routes()


@api.post("/routes/inbound")
async def create_inbound(request: Request):
    vals = clean_inbound(await body(request))
    rid = db.x("INSERT INTO inbound_routes(trunk,destinations,ring_time,enabled,created_at) VALUES(?,?,?,?,?)",
               (*vals, time.time()))
    return {**get_route("inbound", rid), "applied": await apply()}


@api.put("/routes/inbound/{rid}")
async def update_inbound(rid: int, request: Request):
    row = get_route("inbound", rid)
    vals = clean_inbound({**row, **await body(request)}, rid)
    db.x("UPDATE inbound_routes SET trunk=?, destinations=?, ring_time=?, enabled=? WHERE id=?", (*vals, rid))
    return {**get_route("inbound", rid), "applied": await apply()}


@api.delete("/routes/inbound/{rid}")
async def delete_inbound(rid: int):
    get_route("inbound", rid)
    db.x("DELETE FROM inbound_routes WHERE id=?", (rid,))
    return {"ok": True, "applied": await apply()}


# ================================================================= calls
@api.get("/cdr")
async def cdr(limit: int = 200):
    return await asyncio.to_thread(read_cdr, CDR_CSV, max(1, min(limit, 5000)))


@api.get("/channels")
async def list_channels():
    with ami_errors():
        return await channels()


@api.post("/calls/originate")
async def originate(request: Request):
    data = await body(request)
    ext, number = text(data, "ext"), text(data, "number")
    get_extension(ext)
    if not NUMBER_RE.match(number):
        raise HTTPException(400, "number must be 2-20 characters of 0-9 + * #")
    with ami_errors():
        r = await ami.action("Originate", {
            "Channel": f"Local/{ext}@internal-ext", "Context": "from-internal", "Exten": number,
            "Priority": "1", "CallerID": f'"{number}" <{ext}>', "Async": "true", "Timeout": "30000"})
    if r["response"].get("Response") != "Success":
        raise HTTPException(400, str(r["response"].get("Message", "originate failed")))
    return {"ok": True}


@api.post("/calls/hangup")
async def hangup(request: Request):
    channel = text(await body(request), "channel", 200)
    if not channel:
        raise HTTPException(400, "channel is required")
    with ami_errors():
        r = await ami.action("Hangup", {"Channel": channel})
    if r["response"].get("Response") != "Success":
        raise HTTPException(400, str(r["response"].get("Message", "hangup failed")))
    return {"ok": True}


# =================================================================== sms
@api.get("/sms")
async def list_sms(limit: int = 200):
    return db.q("SELECT * FROM sms ORDER BY id DESC LIMIT ?", (max(1, min(limit, 5000)),))


@api.post("/sms/send")
async def send_sms(request: Request):
    data = await body(request)
    trunk = get_trunk(text(data, "trunk"))
    number, msg = text(data, "number", 21), text(data, "body", 1000)
    if not SMS_NUMBER_RE.match(number):
        raise HTTPException(400, "number must be digits with an optional leading +")
    if not msg:
        raise HTTPException(400, "body is required")
    result = await trunk_svc.send_sms(trunk, number, msg)
    db.add_sms(trunk["name"], "out", number, msg, "sent" if result["ok"] else "failed")
    return result


# ======================================================== remote access
def turn_info() -> dict:
    s = db.all_settings()
    last = s.get("turn_last_refresh")
    return {"mode": s.get("turn_mode", "none"), "host": s.get("turn_host", ""),
            "port": s.get("turn_port", "3478"), "user": s.get("turn_user", ""),
            "cf_key_id": s.get("cf_turn_key_id", ""), "has_pass": bool(s.get("turn_pass")),
            "has_cf_token": bool(s.get("cf_turn_token")),
            "last_refresh": float(last) if last else None, "last_error": s.get("turn_last_error") or None}


@api.get("/remote")
async def remote_info():
    s = db.all_settings()
    cf, ts, pub = await asyncio.gather(remote.cloudflared_status(), remote.tailscale_status(), remote.public_ip())
    return {
        "cloudflared": cf,
        "tailscale": ts,
        "network": {"lan_ip": remote.lan_ip(), "public_ip": pub,
                    "external_address": s.get("external_address", ""), "local_net": s.get("local_net", ""),
                    "stun": s.get("stun", remote.DEFAULT_STUN)},
        "turn": turn_info(),
        "public_hostname": s.get("public_hostname", ""),
    }


@api.post("/remote/cloudflare")
async def cloudflare_install(request: Request):
    return await remote.cloudflared_install(text(await body(request), "token", 4096))


@api.delete("/remote/cloudflare")
async def cloudflare_uninstall():
    return await remote.cloudflared_uninstall()


@api.post("/remote/tailscale/up")
async def tailscale_up():
    return await remote.tailscale_up()


@api.post("/remote/tailscale/down")
async def tailscale_down():
    return await remote.tailscale_down()


@api.post("/remote/network")
async def remote_network(request: Request):
    data = await body(request)
    ext_addr, stun = text(data, "external_address", 253), text(data, "stun", 260)
    hostname, local_net = text(data, "public_hostname", 253), text(data, "local_net", 500)
    if not HOST_RE.match(ext_addr) or not HOST_RE.match(hostname):
        raise HTTPException(400, "external_address and public_hostname must be an IP address or hostname")
    if stun and not HOSTPORT_RE.match(stun):
        raise HTTPException(400, "stun must be host or host:port")
    nets = [n.strip() for n in local_net.split(",") if n.strip()]
    try:
        nets = [str(ipaddress.ip_network(n, strict=False)) for n in nets]
    except ValueError as e:
        raise HTTPException(400, f"local_net: {e}")
    for key, val in (("external_address", ext_addr), ("local_net", ",".join(nets)),
                     ("stun", stun), ("public_hostname", hostname)):
        db.set(key, val)
    return {"ok": True, "applied": await apply()}


@api.post("/remote/turn")
async def remote_turn(request: Request):
    data = await body(request)
    mode = text(data, "mode") or "none"
    if mode not in ("none", "custom", "cloudflare"):
        raise HTTPException(400, "mode must be none, custom or cloudflare")
    if mode == "custom":
        host = text(data, "host", 253)
        if not host or not HOST_RE.match(host):
            raise HTTPException(400, "host is required")
        db.set("turn_mode", mode)
        db.set("turn_host", host)
        db.set("turn_port", str(integer(data, "port", 3478, 1, 65535)))
        db.set("turn_user", text(data, "user", 256))
        if text(data, "pass", 256):
            db.set("turn_pass", text(data, "pass", 256))
    elif mode == "cloudflare":
        key_id = text(data, "cf_key_id", 128)
        if not re.match(r"^[A-Za-z0-9_\-]+$", key_id):
            raise HTTPException(400, "cf_key_id is required")
        db.set("turn_mode", mode)
        db.set("cf_turn_key_id", key_id)
        if text(data, "cf_token", 4096):
            db.set("cf_turn_token", text(data, "cf_token", 4096))
        applied = await refresh_cf_turn()
        return {**turn_info(), "applied": applied}
    else:
        db.set("turn_mode", mode)
    return {**turn_info(), "applied": await apply()}


@api.post("/remote/turn/refresh")
async def remote_turn_refresh():
    if not db.get("cf_turn_key_id") or not db.get("cf_turn_token"):
        raise HTTPException(400, "Cloudflare TURN key id and token are not configured")
    applied = await refresh_cf_turn()
    return {**turn_info(), "applied": applied}


@api.get("/ice")
async def ice():
    return {"iceServers": remote.ice_servers(db.all_settings())}


# ============================================================= softphone
@api.get("/softphone")
async def softphone(request: Request):
    host = request.headers.get("x-forwarded-host") or request.headers.get("host", "")
    scheme = "wss" if is_https(request) else "ws"
    domain = urllib.parse.urlsplit("//" + host).hostname or ""
    return {"ws_url": f"{scheme}://{host}/ws", "domain": domain,
            "extensions": [{"ext": e["ext"], "name": e["name"], "secret": e["secret"]}
                           for e in db.extensions() if e["webrtc"]]}


@app.websocket("/ws")
async def ws_proxy(ws: WebSocket):
    """Transparent proxy between the browser and Asterisk's SIP-over-WebSocket."""
    await ws.accept(subprotocol="sip")
    try:
        async with websockets.connect(AST_WS_URL, subprotocols=["sip"], ping_interval=None) as upstream:
            async def client_to_asterisk():
                while True:
                    msg = await ws.receive()
                    if msg["type"] == "websocket.disconnect":
                        return
                    if msg.get("text") is not None:
                        await upstream.send(msg["text"])
                    elif msg.get("bytes") is not None:
                        await upstream.send(msg["bytes"])

            async def asterisk_to_client():
                async for msg in upstream:
                    if isinstance(msg, str):
                        await ws.send_text(msg)
                    else:
                        await ws.send_bytes(msg)

            tasks = [asyncio.create_task(client_to_asterisk()), asyncio.create_task(asterisk_to_client())]
            _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    except (WebSocketDisconnect, WebSocketException, OSError) as e:
        log.debug("ws proxy closed: %s", e)
    finally:
        if ws.client_state == WebSocketState.CONNECTED:
            with contextlib.suppress(Exception):
                await ws.close()


# ================================================================ system
@api.post("/apply")
async def apply_now():
    return await apply()


@api.get("/events")
async def events(since: int = 0):
    return list(ami.events)[-200:]


@api.get("/logs")
async def logs(unit: str = "asterisk", lines: int = 100):
    res = await remote.journal(unit, lines)
    if res["error"] and not res["text"]:
        raise HTTPException(400 if unit not in remote.LOG_UNITS else 503, res["error"])
    return {"text": res["text"]}


@api.post("/system/restart-asterisk")
async def restart_asterisk():
    return await remote.restart_asterisk()


@api.get("/config/preview")
async def config_preview():
    return config_files()


# ========================================================== static + run
app.include_router(api)
app.mount("/static", StaticFiles(directory=STATIC_DIR, check_dir=False), name="static")


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


async def serve():
    common = {"proxy_headers": True, "forwarded_allow_ips": "*", "log_level": "info"}
    servers = [uvicorn.Server(uvicorn.Config(app, host=HTTP_BIND, port=HTTP_PORT, **common))]
    if os.path.exists(SSL_CERT) and os.path.exists(SSL_KEY):
        # lifespan (AMI, background tasks) runs once, in the HTTP server
        servers.append(uvicorn.Server(uvicorn.Config(app, host=HTTPS_BIND, port=HTTPS_PORT, lifespan="off",
                                                     ssl_certfile=SSL_CERT, ssl_keyfile=SSL_KEY, **common)))
    await asyncio.gather(*(s.serve() for s in servers))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    asyncio.run(serve())
