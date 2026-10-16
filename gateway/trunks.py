"""Discovery and live status for the three trunk types.

dongle   chan_dongle   Huawei USB modems with voice (E1550, E173, E1750, E153, ...)
quectel  chan_quectel  Quectel EC25/EC20, SimCom SIM7600 modules
mobile   chan_mobile   Android/iPhone handsets paired over Bluetooth hands-free
"""
import asyncio
import glob
import logging
import os
import re

log = logging.getLogger("trunks")


def parse_table(text: str):
    """Parse a fixed-width table printed by an Asterisk CLI command.

    Column boundaries are taken from the header line, so values containing
    spaces (provider names, phone names) survive.
    """
    lines = [l.rstrip().expandtabs() for l in text.splitlines() if l.strip()]
    if not lines:
        return []
    # header = first line that has at least two words and no '='
    hidx = next((i for i, l in enumerate(lines) if len(l.split()) >= 2 and "=" not in l), None)
    if hidx is None:
        return []
    header = lines[hidx]
    data = [l for l in lines[hidx + 1:] if not set(l.strip()) <= set("-=")]
    if not data:
        return []
    width = max(len(l) for l in [header] + data)

    def blank(line, i):
        return i >= len(line) or line[i] == " "

    def run_width(line, i):
        """Width of the whitespace run containing position i (large if past the end)."""
        if i >= len(line):
            return 99
        a = i
        while a > 0 and line[a - 1] == " ":
            a -= 1
        b = i
        while b < len(line) and line[b] == " ":
            b += 1
        return b - a

    # A column boundary is a blank run (blank in the header and in every data
    # row) that ends exactly where a header word starts, and where either the
    # header or every data row has a gap of at least two spaces. A single-space
    # gap in both ("Provider Name" over "Vodafone IN") stays part of the value,
    # and spaces inside a value under a wide header column ("My Pixel Phone"
    # under "Name") never end at a header word.
    boundaries = []
    i = 0
    while i < width:
        if blank(header, i) and all(blank(d, i) for d in data):
            j = i
            while j < width and blank(header, j) and all(blank(d, j) for d in data):
                j += 1
            at_header_word = j < len(header) and header[j] != " "
            wide = run_width(header, i) >= 2 or all(run_width(d, i) >= 2 for d in data)
            if at_header_word and wide:
                boundaries.append((i, j))
            i = j
        else:
            i += 1
    cols = []
    start = 0
    for a, b in boundaries:
        if a > start:
            cols.append((start, a))
        start = b
    if start < width:
        cols.append((start, None))
    names = [header[s:e].strip().lower().replace(" ", "_") or f"col{n}" for n, (s, e) in enumerate(cols)]
    rows = []
    for l in data:
        row = {names[n]: l[s:e].strip() for n, (s, e) in enumerate(cols)}
        if any(row.values()):
            rows.append(row)
    return rows


def serial_ports():
    """List USB serial ports with their stable by-id names."""
    out = []
    for link in sorted(glob.glob("/dev/serial/by-id/*")):
        try:
            target = os.path.realpath(link)
        except OSError:
            target = ""
        out.append({"id": os.path.basename(link), "dev": target})
    if not out:
        out = [{"id": "", "dev": d} for d in sorted(glob.glob("/dev/ttyUSB*"))]
    return out


def parse_discovery(text: str):
    """Parse 'dongle discovery' / 'quectel discovery' into device dicts."""
    devices = []
    cur = {}
    for line in text.splitlines():
        s = line.strip().lstrip(";").strip()
        if not s:
            if cur:
                devices.append(cur)
                cur = {}
            continue
        m = re.match(r"\[(\w+)\]", s)
        if m:
            if cur:
                devices.append(cur)
            cur = {"name": m.group(1)}
            continue
        for key in ("imei", "imsi", "audio", "data", "model", "manufacturer"):
            m = re.search(rf"\b{key}\s*=\s*(\S+)", s, re.I)
            if m:
                cur[key] = m.group(1)
    if cur:
        devices.append(cur)
    return [d for d in devices if d.get("imei") or d.get("audio")]


class TrunkService:
    def __init__(self, ami, scripts_dir):
        self.ami = ami
        self.scripts = scripts_dir

    async def _cli(self, cmd):
        try:
            return await self.ami.cli(cmd)
        except Exception as e:  # noqa: BLE001
            return f"ERROR: {e}"

    # ----------------------------------------------------- live status
    async def live_status(self):
        """Return {trunk_name: {...}} with whatever each driver reports."""
        status = {}
        for cmd, tech in (("dongle show devices", "dongle"), ("quectel show devices", "quectel")):
            text = await self._cli(cmd)
            if text.startswith("ERROR") or "No such command" in text:
                continue
            for row in parse_table(text):
                name = row.get("id")
                if name:
                    status[name] = {"tech": tech, "state": row.get("state", ""),
                                    "rssi": row.get("rssi", ""),
                                    "provider": row.get("provider_name") or row.get("provider", ""),
                                    "model": row.get("model", ""), "number": row.get("number", ""),
                                    "imei": row.get("imei", ""), "imsi": row.get("imsi", "")}
        text = await self._cli("mobile show devices")
        if not text.startswith("ERROR") and "No such command" not in text:
            for row in parse_table(text):
                name = row.get("id")
                if name:
                    status[name] = {"tech": "mobile", "state": row.get("state", ""),
                                    "connected": row.get("connected", ""), "address": row.get("address", ""),
                                    "sms": row.get("sms", "")}
        return status

    # ------------------------------------------------------ discovery
    async def discover_usb(self):
        found = []
        for cmd, tech in (("dongle discovery", "dongle"), ("quectel discovery", "quectel")):
            text = await self._cli(cmd)
            if text.startswith("ERROR") or "No such command" in text:
                continue
            for d in parse_discovery(text):
                d["tech"] = tech
                found.append(d)
        drivers = {}
        for mod in ("chan_dongle.so", "chan_quectel.so", "chan_mobile.so"):
            text = await self._cli(f"module show like {mod}")
            drivers[mod] = ("1 modules loaded" in text) or (mod in text and "0 modules loaded" not in text)
        return {"devices": found, "ports": serial_ports(), "drivers": drivers}

    async def discover_bluetooth(self):
        text = await self._cli("mobile search")
        if text.startswith("ERROR"):
            return {"error": text, "phones": []}
        if "No such command" in text:
            return {"error": "chan_mobile is not loaded on this Asterisk", "phones": []}
        phones = []
        for row in parse_table(text):
            if row.get("address") and ":" in row["address"]:
                phones.append({"address": row["address"], "name": row.get("name", ""),
                               "usable": row.get("usable", ""), "type": row.get("type", ""),
                               "port": row.get("port", "")})
        return {"phones": phones, "raw": text}

    async def bt_adapters(self):
        try:
            proc = await asyncio.create_subprocess_exec(
                "bluetoothctl", "list", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            out, _ = await asyncio.wait_for(proc.communicate(), 10)
        except Exception as e:  # noqa: BLE001
            return {"error": str(e), "adapters": []}
        adapters = []
        for line in out.decode(errors="replace").splitlines():
            m = re.match(r"Controller\s+([0-9A-F:]{17})\s+(.*?)(\s+\[default\])?$", line.strip(), re.I)
            if m:
                adapters.append({"address": m.group(1), "name": m.group(2), "default": bool(m.group(3))})
        return {"adapters": adapters}

    async def bt_pair(self, address):
        if not re.match(r"^[0-9A-Fa-f:]{17}$", address):
            return {"ok": False, "output": "bad address"}
        script = os.path.join(self.scripts, "bt-pair.sh")
        try:
            proc = await asyncio.create_subprocess_exec(
                "bash", script, address, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            out, _ = await asyncio.wait_for(proc.communicate(), 90)
            text = out.decode(errors="replace")
            return {"ok": proc.returncode == 0, "output": text}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "output": str(e)}

    # ------------------------------------------------------------ sms
    async def send_sms(self, trunk, number, body):
        tech = trunk["tech"]
        number = re.sub(r"[^0-9+]", "", number)
        body = body.replace("\n", " ").replace('"', "'")
        if tech == "dongle":
            cmd = f"dongle sms {trunk['name']} {number} {body}"
        elif tech == "quectel":
            cmd = f"quectel sms {trunk['name']} {number} {body}"
        elif tech == "mobile":
            cmd = f"mobile sms {trunk['name']} {number} {body}"
        else:
            return {"ok": False, "output": "unknown trunk type"}
        text = await self._cli(cmd)
        ok = not text.startswith("ERROR") and "No such command" not in text and "not found" not in text.lower()
        return {"ok": ok, "output": text}
