"""Network and remote-access helpers: LAN/public IP, cloudflared, Tailscale,
journald logs and Cloudflare TURN credentials.

Nothing here raises to callers: failures come back as dicts with an "error"
(or "ok": False) key so the web UI can show them. Every subprocess call
tolerates a missing binary, which is the normal case on a dev laptop.
"""
import asyncio
import json
import re
import shutil
import socket
import time
import urllib.error
import urllib.request

DEFAULT_STUN = "stun.l.google.com:19302"
LOG_UNITS = ("asterisk", "cloudflared", "pi-sip-gateway", "bluetooth", "tailscaled")
CF_TOKEN_RE = re.compile(r"^[A-Za-z0-9_\-=.]{20,}$")
TS_URL_RE = re.compile(r"https://login\.tailscale\.com/\S+")
PUBLIC_IP_TTL = 600
PUBLIC_IP_FAIL_TTL = 60

_public_ip_cache: tuple[float, str | None] = (0.0, None)
_ts_auth_url: str | None = None
_ts_proc_task: asyncio.Task | None = None


async def _run(*args: str, timeout: float = 30) -> tuple[int, str]:
    """Run a command, return (returncode, combined output). 127 if it cannot start."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    except (OSError, NotImplementedError) as e:
        return 127, f"{args[0]}: {e}"
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, f"{args[0]}: timed out after {timeout:.0f} s"
    return proc.returncode or 0, out.decode(errors="replace")


# ------------------------------------------------------------- network
def lan_ip() -> str:
    """Primary LAN address. Connecting a UDP socket sends no packets."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def _fetch_public_ip() -> str | None:
    try:
        with urllib.request.urlopen("https://api.ipify.org", timeout=4) as r:
            return r.read().decode().strip() or None
    except Exception:  # noqa: BLE001
        return None


async def public_ip() -> str | None:
    """Public IPv4 as seen by ipify; cached 10 min (1 min after a failure)."""
    global _public_ip_cache
    ts, ip = _public_ip_cache
    if time.time() - ts < (PUBLIC_IP_TTL if ip else PUBLIC_IP_FAIL_TTL):
        return ip
    ip = await asyncio.to_thread(_fetch_public_ip)
    _public_ip_cache = (time.time(), ip)
    return ip


# ---------------------------------------------------------- cloudflared
async def cloudflared_status(with_log: bool = True) -> dict:
    installed = shutil.which("cloudflared") is not None
    _, state = await _run("systemctl", "is-active", "cloudflared", timeout=10)
    res = {"installed": installed, "active": state.strip() == "active"}
    if with_log:
        _, res["log"] = await _run("journalctl", "-u", "cloudflared", "-n", "30", "--no-pager", timeout=10)
    return res


async def cloudflared_install(token: str) -> dict:
    token = (token or "").strip()
    if not CF_TOKEN_RE.match(token):
        return {"ok": False, "output": "invalid tunnel token"}
    if shutil.which("cloudflared") is None:
        return {"ok": False, "output": "cloudflared is not installed"}
    _, out1 = await _run("cloudflared", "service", "uninstall", timeout=60)
    rc, out2 = await _run("cloudflared", "service", "install", token, timeout=120)
    if rc != 0:
        return {"ok": False, "output": out1 + out2}
    rc, out3 = await _run("systemctl", "restart", "cloudflared", timeout=60)
    return {"ok": rc == 0, "output": out1 + out2 + out3}


async def cloudflared_uninstall() -> dict:
    rc, out = await _run("cloudflared", "service", "uninstall", timeout=60)
    return {"ok": rc == 0, "output": out}


# ------------------------------------------------------------ tailscale
async def tailscale_status() -> dict:
    global _ts_auth_url
    res = {"installed": shutil.which("tailscale") is not None, "running": False,
           "ip": None, "hostname": None, "auth_url": _ts_auth_url}
    if not res["installed"]:
        return res
    rc, out = await _run("tailscale", "status", "--json", timeout=10)
    try:
        st = json.loads(out)
    except ValueError:
        res["error"] = out.strip() or f"tailscale status exited {rc}"
        return res
    me = st.get("Self") or {}
    res["running"] = st.get("BackendState") == "Running"
    res["ip"] = (me.get("TailscaleIPs") or [None])[0]
    res["hostname"] = me.get("HostName")
    if res["running"]:
        _ts_auth_url = None
        res["auth_url"] = None
    return res


async def _drain_tailscale(proc: asyncio.subprocess.Process):
    """Read `tailscale up` output until it exits, picking up the login URL."""
    global _ts_auth_url
    try:
        async for raw in proc.stdout:
            m = TS_URL_RE.search(raw.decode(errors="replace"))
            if m:
                _ts_auth_url = m.group(0)
        await proc.wait()
    except asyncio.CancelledError:
        if proc.returncode is None:
            proc.kill()
        raise


async def tailscale_up() -> dict:
    """Start `tailscale up` in the background; wait up to 8 s for a login URL."""
    global _ts_proc_task, _ts_auth_url
    if shutil.which("tailscale") is None:
        return {"auth_url": None, "running": False, "error": "tailscale is not installed"}
    if _ts_proc_task and not _ts_proc_task.done():
        _ts_proc_task.cancel()
    _ts_auth_url = None
    try:
        proc = await asyncio.create_subprocess_exec(
            "tailscale", "up", "--timeout", "120s",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    except (OSError, NotImplementedError) as e:
        return {"auth_url": None, "running": False, "error": str(e)}
    _ts_proc_task = asyncio.create_task(_drain_tailscale(proc))
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and _ts_auth_url is None and not _ts_proc_task.done():
        await asyncio.sleep(0.25)
    st = await tailscale_status()
    return {"auth_url": _ts_auth_url, "running": st["running"]}


async def tailscale_down() -> dict:
    rc, out = await _run("tailscale", "down", timeout=20)
    return {"ok": rc == 0, "output": out}


# --------------------------------------------------------------- system
async def journal(unit: str, lines: int = 100) -> dict:
    if unit not in LOG_UNITS:
        return {"text": "", "error": f"unit must be one of: {', '.join(LOG_UNITS)}"}
    lines = max(1, min(int(lines), 2000))
    rc, out = await _run("journalctl", "-u", unit, "-n", str(lines), "--no-pager", timeout=15)
    return {"text": out, "error": None if rc == 0 else f"journalctl exited {rc}"}


async def restart_asterisk() -> dict:
    rc, out = await _run("systemctl", "restart", "asterisk", timeout=60)
    return {"ok": rc == 0, "output": out}


# ----------------------------------------------------------------- TURN
def _post_json(url: str, token: str, body: dict, timeout: float) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                 "User-Agent": "pi-sip-gateway"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


async def cloudflare_turn_credentials(key_id: str, api_token: str, ttl: int = 86400) -> dict:
    res = {"host": "turn.cloudflare.com", "port": "3478", "user": "", "pass": "",
           "ice_servers": [], "error": None}
    if not key_id or not api_token:
        res["error"] = "TURN key id and API token are required"
        return res
    if not re.match(r"^[A-Za-z0-9_\-]+$", key_id):
        res["error"] = "invalid TURN key id"
        return res
    url = f"https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
    try:
        data = await asyncio.to_thread(_post_json, url, api_token, {"ttl": ttl}, 10)
    except urllib.error.HTTPError as e:
        res["error"] = f"Cloudflare returned HTTP {e.code}: {e.read().decode(errors='replace')[:300]}"
        return res
    except Exception as e:  # noqa: BLE001
        res["error"] = f"Cloudflare request failed: {e}"
        return res
    servers = data.get("iceServers") if isinstance(data, dict) else None
    if isinstance(servers, dict):
        servers = [servers]
    if not isinstance(servers, list):
        res["error"] = "unexpected response from Cloudflare"
        return res
    res["ice_servers"] = servers
    creds = next((s for s in servers if isinstance(s, dict) and s.get("username")), None)
    if not creds:
        res["error"] = "Cloudflare response contained no TURN credentials"
        return res
    res["user"], res["pass"] = creds["username"], creds.get("credential", "")
    urls = creds.get("urls") or []
    urls = [urls] if isinstance(urls, str) else urls
    m = next((m for m in (re.match(r"turn:([^:?]+)(?::(\d+))?", u) for u in urls
                          if u.startswith("turn:")) if m), None)
    if m:
        res["host"], res["port"] = m.group(1), m.group(2) or "3478"
    return res


def ice_servers(settings: dict) -> list:
    """ICE server list for the browser softphone, mirroring rtp_gen.conf."""
    out = []
    stun = (settings.get("stun", DEFAULT_STUN) or "").strip()
    if stun:
        out.append({"urls": [f"stun:{stun}"]})
    host = (settings.get("turn_host") or "").strip()
    if settings.get("turn_mode", "none") != "none" and host:
        port = settings.get("turn_port") or "3478"
        out.append({"urls": [f"turn:{host}:{port}?transport=udp", f"turn:{host}:{port}?transport=tcp"],
                    "username": settings.get("turn_user", ""),
                    "credential": settings.get("turn_pass", "")})
    return out
