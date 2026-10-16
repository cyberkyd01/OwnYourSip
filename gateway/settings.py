"""Runtime settings, all overridable through environment variables.

On the Pi these come from /etc/pi-sip-gateway/env (loaded by systemd).
"""
import os

DATA_DIR = os.environ.get("PSG_DATA_DIR", "/var/lib/pi-sip-gateway")
AST_CONF_DIR = os.environ.get("PSG_AST_CONF", "/etc/asterisk")
CDR_CSV = os.environ.get("PSG_CDR_CSV", "/var/log/asterisk/cdr-csv/Master.csv")
SCRIPTS_DIR = os.environ.get("PSG_SCRIPTS", "/opt/pi-sip-gateway/scripts")

AMI_HOST = os.environ.get("PSG_AMI_HOST", "127.0.0.1")
AMI_PORT = int(os.environ.get("PSG_AMI_PORT", "5038"))
AMI_USER = os.environ.get("PSG_AMI_USER", "gateway")
AMI_SECRET = os.environ.get("PSG_AMI_SECRET", "changeme")

AST_WS_URL = os.environ.get("PSG_AST_WS", "ws://127.0.0.1:8088/ws")

HTTP_BIND = os.environ.get("PSG_HTTP_BIND", "127.0.0.1")
HTTP_PORT = int(os.environ.get("PSG_HTTP_PORT", "8080"))
HTTPS_BIND = os.environ.get("PSG_HTTPS_BIND", "0.0.0.0")
HTTPS_PORT = int(os.environ.get("PSG_HTTPS_PORT", "8443"))
SSL_CERT = os.environ.get("PSG_SSL_CERT", "/etc/pi-sip-gateway/cert.pem")
SSL_KEY = os.environ.get("PSG_SSL_KEY", "/etc/pi-sip-gateway/key.pem")

SECRET_KEY = os.environ.get("PSG_SECRET_KEY", "")  # session signing; generated if empty

# MOCK=1 runs the web app without Asterisk (for development on a laptop).
MOCK = os.environ.get("PSG_MOCK", "0") == "1"

os.makedirs(DATA_DIR, exist_ok=True)
