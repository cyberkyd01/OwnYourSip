"""Password hashing and signed session cookies, stdlib only."""
import base64
import hashlib
import hmac
import os
import secrets
import time

ITER = 200_000
COOKIE = "psg_session"


def hash_password(password: str, salt: str | None = None):
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), ITER)
    return dk.hex(), salt


def verify_password(password: str, pw_hash: str, salt: str) -> bool:
    calc, _ = hash_password(password, salt)
    return hmac.compare_digest(calc, pw_hash)


class Sessions:
    def __init__(self, secret_key: str, ttl: int = 7 * 86400):
        self.key = secret_key.encode()
        self.ttl = ttl

    def make(self, username: str) -> str:
        exp = int(time.time()) + self.ttl
        payload = f"{username}|{exp}".encode()
        sig = hmac.new(self.key, payload, "sha256").digest()
        return base64.urlsafe_b64encode(payload + b"|" + sig).decode()

    def check(self, token: str | None):
        if not token:
            return None
        try:
            raw = base64.urlsafe_b64decode(token.encode())
            payload, sig = raw.rsplit(b"|", 1)
            if not hmac.compare_digest(hmac.new(self.key, payload, "sha256").digest(), sig):
                return None
            user, exp = payload.decode().split("|")
            if int(exp) < time.time():
                return None
            return user
        except Exception:  # noqa: BLE001
            return None


def load_or_create_secret(path: str) -> str:
    try:
        with open(path) as f:
            s = f.read().strip()
            if s:
                return s
    except FileNotFoundError:
        pass
    s = secrets.token_hex(32)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(s)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return s
