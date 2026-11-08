#!/usr/bin/env python3
"""AntiCode: lets Claude Code use any OpenRouter model.

OpenRouter already speaks Anthropic's Messages API, so Claude Code could call it directly; this
small local server sits in between to do three things Claude Code can't:
  - take the API key from a file at every request (a new key works at once, nothing to restart),
  - list OpenRouter's models for Claude Code's /model picker (ids carry "anthropic/" in front,
    because Claude Code only lists a gateway's models whose id contains "claude" or "anthropic"),
  - answer for the Claude names Claude Code sends by itself (Opus / Sonnet / Haiku).
It listens on 127.0.0.1 only and asks for a secret token (so no other app on the phone can use
your key). Python's standard library only.

  openrouter-proxy.py [--port N] [--port-file FILE]

Environment: OPENROUTER_PROXY_TOKEN (required), OPENROUTER_KEY_FILE, OPENROUTER_API_BASE,
OPENROUTER_MODELS_FILE (favourite model ids, one a line: listed first),
OPENROUTER_PROXY_DEBUG (one line per request on stderr: never prompts, never the key).
"""
import http.server
import json
import os
import re
import socketserver
import sys
import time
import urllib.error
import urllib.request

API = os.environ.get("OPENROUTER_API_BASE", "https://openrouter.ai/api").rstrip("/")
KEY_FILE = os.environ.get("OPENROUTER_KEY_FILE", os.path.expanduser("~/.config/agy-terminal/openrouter-api-key"))
FAV_FILE = os.environ.get("OPENROUTER_MODELS_FILE", os.path.expanduser("~/.config/agy-terminal/openrouter-models"))
TOKEN = os.environ.get("OPENROUTER_PROXY_TOKEN", "")
PREFIX = "anthropic/"
LIST_MAX = 80
# what an attribution header says about this app (OpenRouter shows it in the user's activity)
TITLE = "AntiCode"


# ------------------------------------------------------------------ the key
def read_key():
    try:
        with open(KEY_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    return line
    except OSError:
        pass
    return os.environ.get("OPENROUTER_API_KEY", "").strip()


def read_favourites():
    try:
        with open(FAV_FILE, encoding="utf-8") as f:
            return [l.strip() for l in f if l.strip() and not l.lstrip().startswith("#")]
    except OSError:
        return []


# ------------------------------------------------------------------ models
_cache = {"at": 0.0, "list": []}


def fetch_models(key):
    """[(id, name)] of OpenRouter's models that can call tools (Claude Code needs that)."""
    now = time.time()
    if _cache["list"] and now - _cache["at"] < 600:
        return _cache["list"]
    out = []
    try:
        req = urllib.request.Request(API + "/v1/models", headers={"authorization": "Bearer " + key})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.load(r).get("data", [])
        for m in sorted(data, key=lambda m: m.get("created") or 0, reverse=True):
            mid = m.get("id")
            if not mid:
                continue
            params = m.get("supported_parameters")
            if params is not None and "tools" not in params:
                continue
            arch = m.get("architecture") or {}
            if arch.get("output_modalities") and "text" not in arch["output_modalities"]:
                continue
            out.append((mid, m.get("name") or mid))
    except Exception:
        out = _cache["list"]
    _cache.update(at=now, list=out)
    return out


def listing(key):
    models = fetch_models(key)
    names = dict(models)
    first = [(m, names.get(m, m)) for m in read_favourites()]
    seen = {m for m, _ in first}
    rest = [(m, n) for m, n in models if m not in seen]
    return (first + rest)[:LIST_MAX + len(first)]


def resolve_model(name, key=None):
    """The OpenRouter model for the name Claude Code sent."""
    m = (name or "").strip()
    if m.startswith(PREFIX) and "/" in m[len(PREFIX):]:
        return m[len(PREFIX):]  # (our listing's "anthropic/openai/gpt-5": the part after ours)
    if "/" in m:
        return m  # already an OpenRouter id (also "anthropic/claude-…" and "~anthropic/claude-sonnet-latest")
    low = m.lower()
    if low.startswith("claude"):  # a name Claude Code made up itself: OpenRouter's "newest of that family" alias
        for fam in ("opus", "sonnet", "haiku"):
            if fam in low:
                return "~anthropic/claude-%s-latest" % fam
        return "anthropic/" + re.sub(r"-(\d{8}|latest)$", "", low)
    return m


# ------------------------------------------------------------------ the server
class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "anticode-openrouter-proxy"

    def log_message(self, fmt, *args):  # (never the prompts, never the key: only what was asked for)
        if os.environ.get("OPENROUTER_PROXY_DEBUG"):
            sys.stderr.write("proxy: %s %s -> %s\n" % (self.command, self.path.split("?")[0], fmt % args))

    def send_json(self, status, obj, extra=None):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        if status == 429 or status >= 500:
            self.send_header("x-should-retry", "true")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def error(self, status, kind, message):
        self.send_json(status, {"type": "error", "error": {"type": kind, "message": message}})

    def authorized(self):
        if not TOKEN:
            return False
        return self.headers.get("authorization", "") == "Bearer " + TOKEN or self.headers.get("x-api-key", "") == TOKEN

    def read_body(self):
        if self.headers.get("transfer-encoding", "").lower() == "chunked":
            out = b""
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    self.rfile.readline()
                    return out
                out += self.rfile.read(size)
                self.rfile.readline()
        return self.rfile.read(int(self.headers.get("content-length") or 0))

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("content-length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/health", "/"):
            return self.send_json(200, {"ok": True})
        if not self.authorized():
            return self.error(401, "authentication_error", "wrong proxy token")
        if path == "/v1/models":
            key = read_key()
            if not key:
                return self.error(401, "authentication_error", "No OpenRouter API key yet — run: openrouter-key")
            data = [{"type": "model", "id": PREFIX + mid, "display_name": name, "created_at": "2025-01-01T00:00:00Z"}
                    for mid, name in listing(key)]
            return self.send_json(200, {"data": data, "has_more": False,
                                        "first_id": data[0]["id"] if data else None, "last_id": data[-1]["id"] if data else None})
        self.error(404, "not_found_error", "not found")

    def do_POST(self):
        path = self.path.split("?")[0]
        raw = self.read_body()  # (always: an early refusal must not leave it on a kept-alive connection)
        if not self.authorized():
            return self.error(401, "authentication_error", "wrong proxy token")
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            return self.error(400, "invalid_request_error", "the request is not JSON")
        if path == "/v1/messages/count_tokens":
            # (an estimate: about 3.5 characters a token — Claude Code only needs it roughly)
            n = len(json.dumps(body.get("messages", []))) + len(json.dumps(body.get("system", ""))) + len(json.dumps(body.get("tools", [])))
            return self.send_json(200, {"input_tokens": int(n / 3.5) + 1})
        if path != "/v1/messages":
            return self.error(404, "not_found_error", "not found")
        key = read_key()
        if not key:
            return self.error(401, "authentication_error", "No OpenRouter API key yet — run: openrouter-key")
        body["model"] = resolve_model(body.get("model"), key)
        headers = {"content-type": "application/json", "authorization": "Bearer " + key, "x-title": TITLE,
                   "anthropic-version": self.headers.get("anthropic-version", "2023-06-01")}
        # (Claude Code's beta flags are Anthropic's own; the launcher turns them off)
        req = urllib.request.Request(API + "/v1/messages", data=json.dumps(body).encode(), method="POST", headers=headers)
        try:
            resp = urllib.request.urlopen(req, timeout=900)
        except urllib.error.HTTPError as e:  # OpenRouter's own answer, as it is (Claude Code reads its wording)
            data = e.read()
            self.send_response(e.code)
            self.send_header("content-type", e.headers.get("content-type", "application/json"))
            self.send_header("content-length", str(len(data)))
            for h in ("retry-after", "x-should-retry"):
                if e.headers.get(h):
                    self.send_header(h, e.headers[h])
            self.end_headers()
            self.wfile.write(data)
            return
        except Exception as e:
            return self.error(529, "overloaded_error", "OpenRouter can't be reached: %s" % e)
        with resp:
            ctype = resp.headers.get("content-type", "application/json")
            self.send_response(resp.status)
            self.send_header("content-type", ctype)
            if ctype.startswith("text/event-stream"):
                self.send_header("cache-control", "no-cache")
                self.send_header("connection", "close")
                self.end_headers()
                self.close_connection = True
                try:
                    while True:
                        chunk = resp.read1(8192) if hasattr(resp, "read1") else resp.read(8192)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Claude Code went away (Esc)
                except Exception:
                    pass
                return
            data = resp.read()
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    port = 0
    port_file = ""
    args = sys.argv[1:]
    while args:
        a = args.pop(0)
        if a == "--port" and args:
            port = int(args.pop(0))
        elif a == "--port-file" and args:
            port_file = args.pop(0)
    if not TOKEN:
        sys.exit("OPENROUTER_PROXY_TOKEN is not set")
    srv = Server(("127.0.0.1", port), Handler)
    if port_file:
        tmp = port_file + ".tmp"
        with open(tmp, "w") as f:
            f.write(str(srv.server_address[1]))
        os.replace(tmp, port_file)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
