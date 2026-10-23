"""claude-account-switcher relay.

A loopback relay for Claude Code sessions. The companion plugin points a session at
http://127.0.0.1:48620/acct/<name>; this relay replaces the Authorization header with <name>'s
long-lived token from tokens.json (beside this file) and forwards the request to api.anthropic.com,
streaming the response back. It binds 127.0.0.1 only and never logs a token.

Files beside this script:
  tokens.json   {"<name>": {"token": "...", "createdAt": "...", "expiresAt": "..."}, ...}
                (a bare string value is accepted too)
  relay.alive   heartbeat rewritten every 10 s: port, pid, time, account names
  relay.log     one line per request: account, method, path, status, bytes, seconds
Health: GET /health -> {"ok": true, "accounts": [names]}
"""
import http.client
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
TOKENS = os.path.join(HERE, "tokens.json")
LOG = os.path.join(HERE, "relay.log")
ALIVE = os.path.join(HERE, "relay.alive")
PORT = 48620
UPSTREAM = "api.anthropic.com"
MAX_BODY = 64 * 1024 * 1024
HOP = {"host", "authorization", "x-api-key", "connection", "keep-alive", "transfer-encoding", "content-length", "proxy-authorization", "te", "trailer", "upgrade"}


def log(msg: str) -> None:
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except OSError:
        pass


def read_store() -> dict:
    try:
        with open(TOKENS, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def load_tokens() -> dict:
    """Return {name: token}. Accepts object entries ({"token": ...}) or bare strings."""
    out = {}
    for name, entry in read_store().items():
        tok = entry.get("token") if isinstance(entry, dict) else entry
        if isinstance(tok, str) and tok:
            out[name] = tok
    return out


def load_expiry() -> dict:
    """Return {name: expiresAt ISO string} for entries that record one (never the token)."""
    return {n: e["expiresAt"] for n, e in read_store().items() if isinstance(e, dict) and e.get("expiresAt")}


USAGE: dict = {}  # {name: {"at", "h5", "h5_reset", "d7", "d7_reset"}} from the last reply that carried the headers
_RL = "anthropic-ratelimit-unified-"


def note_usage(name: str, resp) -> None:
    """Remember the account's own usage windows as the API reports them on a reply (never a token)."""
    try:
        d7, h5 = resp.getheader(_RL + "7d-utilization"), resp.getheader(_RL + "5h-utilization")
        if d7 is None and h5 is None:
            return
        USAGE[name] = {
            "at": time.time(),
            "h5": float(h5) if h5 is not None else None,
            "h5_reset": int(resp.getheader(_RL + "5h-reset") or 0) or None,
            "d7": float(d7) if d7 is not None else None,
            "d7_reset": int(resp.getheader(_RL + "7d-reset") or 0) or None,
        }
    except (TypeError, ValueError):
        pass


class Relay(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # silence default stderr logging
        pass

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _local_only(self) -> bool:
        """Refuse anything a web page could send: a Host other than this loopback port (DNS rebinding)
        or browser-only headers (Origin, Sec-Fetch-*). Claude Code sends none of these."""
        port = self.server.server_address[1]
        host = (self.headers.get("Host") or "").strip().lower()
        if host not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            return False
        return not any(k.lower() == "origin" or k.lower().startswith("sec-fetch-") for k in self.headers.keys())

    def _handle(self) -> None:
        if not self._local_only():
            log(f"refused {self.command} from a browser or foreign Host")
            self._json(403, {"type": "error", "error": {"type": "permission_error", "message": "account-switcher relay: local clients only"}})
            self.close_connection = True
            return
        if self.path == "/health":
            self._json(200, {"ok": True, "accounts": sorted(load_tokens().keys())})
            return
        parts = self.path.split("/", 3)
        if len(parts) >= 3 and not parts[2].replace("-", "").replace("_", "").isalnum():
            parts = []  # ['', 'acct', '<name>', '<rest>']
        if len(parts) < 4 or parts[1] != "acct":
            self._json(404, {"error": "expected /acct/<name>/..."})
            return
        name, rest = parts[2], "/" + parts[3]
        token = load_tokens().get(name)
        if not token:
            log(f"no token for account '{name}'")
            self._json(401, {"type": "error", "error": {"type": "authentication_error", "message": f"account-switcher relay: no token stored for account '{name}'"}})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY or "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            self._json(400, {"type": "error", "error": {"type": "invalid_request_error", "message": "account-switcher relay: bad Content-Length"}})
            self.close_connection = True
            return
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        headers["Authorization"] = f"Bearer {token}"
        if body is not None:
            headers["Content-Length"] = str(len(body))
        headers["Connection"] = "close"
        t0 = time.time()
        try:
            up = http.client.HTTPSConnection(UPSTREAM, timeout=600)
            up.request(self.command, rest, body=body, headers=headers)
            resp = up.getresponse()
        except Exception as e:  # upstream unreachable
            log(f"{name} {self.command} {rest} upstream error {type(e).__name__}")
            self._json(502, {"type": "error", "error": {"type": "api_error", "message": f"account-switcher relay: upstream error {type(e).__name__}"}})
            return
        note_usage(name, resp)
        self.send_response(resp.status, resp.reason)
        for k, v in resp.getheaders():
            if k.lower() in ("transfer-encoding", "content-length", "connection"):
                continue
            self.send_header(k, v)
        self.send_header("Connection", "close")
        self.end_headers()
        sent = 0
        try:
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
                sent += len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            up.close()
        # The upstream request id is what a transcript records per reply: it ties each reply to the
        # account that served it.
        log(f"{name} {self.command} {rest} -> {resp.status} {sent}B {time.time() - t0:.1f}s {resp.getheader('request-id') or '-'}")
        self.close_connection = True

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _handle


def heartbeat(port: int) -> None:
    """Rewrite relay.alive every 10 s so the plugin can see the relay is up without an HTTP call."""

    def write(text: str) -> None:
        # Write beside it and swap in whole: a reader never sees a truncated file (which the plugin
        # would take for "relay down" and route that moment to the window login). On Windows the
        # swap fails while a reader holds the file open, so retry briefly.
        tmp = ALIVE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        for _ in range(20):
            try:
                os.replace(tmp, ALIVE)
                return
            except PermissionError:
                time.sleep(0.05)

    def loop():
        while True:
            try:
                write(json.dumps({"port": port, "pid": os.getpid(), "at": time.time(), "accounts": sorted(load_tokens().keys()), "expires": load_expiry(), "usage": dict(USAGE)}))
            except OSError:
                pass
            time.sleep(10)

    threading.Thread(target=loop, daemon=True).start()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    log(f"relay starting on 127.0.0.1:{port}")
    heartbeat(port)
    try:
        ThreadingHTTPServer(("127.0.0.1", port), Relay).serve_forever()
    except OSError as e:  # port already held by a running relay: exit quietly
        log(f"relay exit: {e}")
        sys.exit(0)
