"""Tiny SQLite layer. One connection, serialised with a lock."""
import json
import os
import sqlite3
import threading
import time

from .settings import DATA_DIR

DB_PATH = os.path.join(DATA_DIR, "gateway.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE, pw_hash TEXT, salt TEXT, created_at REAL);
CREATE TABLE IF NOT EXISTS extensions (
    id INTEGER PRIMARY KEY, ext TEXT UNIQUE, name TEXT, secret TEXT,
    webrtc INTEGER DEFAULT 1, created_at REAL);
CREATE TABLE IF NOT EXISTS trunks (
    id INTEGER PRIMARY KEY, name TEXT UNIQUE, tech TEXT, label TEXT,
    config TEXT, enabled INTEGER DEFAULT 1, created_at REAL);
CREATE TABLE IF NOT EXISTS outbound_routes (
    id INTEGER PRIMARY KEY, label TEXT, pattern TEXT UNIQUE, strip INTEGER DEFAULT 0,
    prepend TEXT DEFAULT '', trunks TEXT, enabled INTEGER DEFAULT 1, created_at REAL);
CREATE TABLE IF NOT EXISTS inbound_routes (
    id INTEGER PRIMARY KEY, trunk TEXT UNIQUE, destinations TEXT,
    ring_time INTEGER DEFAULT 30, enabled INTEGER DEFAULT 1, created_at REAL);
CREATE TABLE IF NOT EXISTS sms (
    id INTEGER PRIMARY KEY, trunk TEXT, direction TEXT, number TEXT, body TEXT,
    status TEXT, ts REAL);
"""


class DB:
    def __init__(self, path: str = DB_PATH):
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock:
            self.conn.executescript(SCHEMA)
            self.conn.commit()

    def q(self, sql, params=()):
        with self.lock:
            cur = self.conn.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]

    def one(self, sql, params=()):
        rows = self.q(sql, params)
        return rows[0] if rows else None

    def x(self, sql, params=()):
        with self.lock:
            cur = self.conn.execute(sql, params)
            self.conn.commit()
            return cur.lastrowid

    # settings -------------------------------------------------------
    def get(self, key, default=None):
        row = self.one("SELECT value FROM settings WHERE key=?", (key,))
        return row["value"] if row else default

    def set(self, key, value):
        self.x("INSERT INTO settings(key,value) VALUES(?,?) "
               "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    def all_settings(self):
        return {r["key"]: r["value"] for r in self.q("SELECT key,value FROM settings")}

    # typed helpers --------------------------------------------------
    def extensions(self):
        return self.q("SELECT * FROM extensions ORDER BY ext")

    def trunks(self):
        rows = self.q("SELECT * FROM trunks ORDER BY name")
        for r in rows:
            r["config"] = json.loads(r["config"] or "{}")
        return rows

    def outbound_routes(self):
        rows = self.q("SELECT * FROM outbound_routes ORDER BY id")
        for r in rows:
            r["trunks"] = json.loads(r["trunks"] or "[]")
        return rows

    def inbound_routes(self):
        rows = self.q("SELECT * FROM inbound_routes ORDER BY id")
        for r in rows:
            r["destinations"] = json.loads(r["destinations"] or "[]")
        return rows

    def add_sms(self, trunk, direction, number, body, status="ok"):
        return self.x("INSERT INTO sms(trunk,direction,number,body,status,ts) VALUES(?,?,?,?,?,?)",
                      (trunk, direction, number, body, status, time.time()))
