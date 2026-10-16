"""Read Asterisk's CSV call detail records."""
import csv
import os

FIELDS = ["accountcode", "src", "dst", "dcontext", "clid", "channel", "dstchannel",
          "lastapp", "lastdata", "start", "answer", "end", "duration", "billsec",
          "disposition", "amaflags", "uniqueid", "userfield"]

TRUNK_TECHS = ("Dongle/", "Quectel/", "Mobile/")


def _tail_lines(path, max_bytes=512_000):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        if size > max_bytes:
            f.seek(size - max_bytes)
            f.readline()  # drop partial line
        return f.read().decode(errors="replace").splitlines()


def read_cdr(path, limit=200):
    if not os.path.exists(path):
        return []
    rows = []
    for rec in csv.reader(_tail_lines(path)):
        if len(rec) < 15:
            continue
        d = dict(zip(FIELDS, rec))
        ch = d.get("channel", "")
        dch = d.get("dstchannel", "")
        if ch.startswith(TRUNK_TECHS):
            d["direction"] = "inbound"
            d["trunk"] = ch.split("/")[1].split("-")[0]
        elif dch.startswith(TRUNK_TECHS):
            d["direction"] = "outbound"
            d["trunk"] = dch.split("/")[1].split("-")[0]
        else:
            d["direction"] = "internal"
            d["trunk"] = ""
        rows.append(d)
    rows.reverse()
    return rows[:limit]
