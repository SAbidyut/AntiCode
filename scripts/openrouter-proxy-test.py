#!/usr/bin/env python3
"""Tests of the OpenRouter proxy (android/app/src/main/assets/guest/openrouter-proxy.py) against a
stand-in for OpenRouter — no key, no network:

  python3 scripts/openrouter-proxy-test.py            # the proxy, called directly
  python3 scripts/openrouter-proxy-test.py --claude   # also: a real Claude Code (`claude`) through it
"""
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROXY = os.path.join(HERE, "..", "android", "app", "src", "main", "assets", "guest", "openrouter-proxy.py")
TOKEN = "tok-" + os.urandom(6).hex()
seen = []  # what the stand-in received: (method, path, headers, body)
fails = 0


def check(name, ok, extra=""):
    global fails
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else "   " + str(extra)))
    if not ok:
        fails += 1


# ------------------------------------------------------------------ the stand-in for OpenRouter
MODELS = [
    {"id": "openai/gpt-5", "name": "OpenAI: GPT-5", "created": 1700000500, "supported_parameters": ["tools", "temperature"]},
    {"id": "anthropic/claude-sonnet-4.5", "name": "Anthropic: Claude Sonnet 4.5", "created": 1700000400, "supported_parameters": ["tools"]},
    {"id": "anthropic/claude-opus-4.1", "name": "Anthropic: Claude Opus 4.1", "created": 1700000300, "supported_parameters": ["tools"]},
    {"id": "anthropic/claude-haiku-4.5", "name": "Anthropic: Claude Haiku 4.5", "created": 1700000200, "supported_parameters": ["tools"]},
    {"id": "meta/chat-only", "name": "Meta: Chat Only", "created": 1700000900, "supported_parameters": ["temperature"]},
    {"id": "acme/picture-maker", "name": "Acme: Pictures", "created": 1700000800, "supported_parameters": ["tools"],
     "architecture": {"output_modalities": ["image"]}},
    {"id": "google/gemini-x:free", "name": "Google: Gemini X (free)", "created": 1700000100, "supported_parameters": ["tools"]},
]


def sse(events):
    return "".join("event: %s\ndata: %s\n\n" % (e["type"], json.dumps(e)) for e in events).encode()


def text_events(text, model):
    return [
        {"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant", "model": model, "content": [],
                                              "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 9, "output_tokens": 0}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 4}},
        {"type": "message_stop"},
    ]


def tool_events(model):
    return [
        {"type": "message_start", "message": {"id": "msg_2", "type": "message", "role": "assistant", "model": model, "content": [],
                                              "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 20, "output_tokens": 0}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_abc", "name": "Bash", "input": {}}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{\"command\": \"echo hi\"}"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 7}},
        {"type": "message_stop"},
    ]


class Fake(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def reply(self, status, body, ctype="application/json", extra=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        seen.append(("GET", self.path, dict(self.headers), None))
        self.reply(200, {"data": MODELS})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        seen.append(("POST", self.path, dict(self.headers), body))
        if self.headers.get("authorization") not in ("Bearer or-test-key", "Bearer or-other-key"):
            return self.reply(401, {"error": {"code": 401, "message": "No auth credentials found"}})
        text = json.dumps(body.get("messages", []))  # (the whole conversation: Claude Code adds reminders as messages of their own)
        if "RATELIMIT" in text:
            return self.reply(429, {"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}}, extra={"retry-after": "7"})
        if "tool_result" in text:
            events = text_events("TOOL SAID: hi", body["model"])
        elif "RUNTOOL" in text and body.get("tools"):
            events = tool_events(body["model"])
        else:
            events = text_events("Hello from mock OpenRouter", body["model"])
        if not body.get("stream"):
            msg = events[0]["message"]
            msg["content"] = [{"type": "text", "text": events[2]["delta"]["text"]}] if events[1]["content_block"]["type"] == "text" else []
            return self.reply(200, msg)
        out = sse(events)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(out[: len(out) // 2])  # (in two pieces: the proxy must not wait for the end)
        self.wfile.flush()
        time.sleep(0.15)
        self.wfile.write(out[len(out) // 2:])
        self.close_connection = True


class Srv(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


# ------------------------------------------------------------------ calling the proxy
def call(port, path, body=None, token=TOKEN, method=None):
    h = {"content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "claude-code-20250219"}
    if token:
        h["authorization"] = "Bearer " + token
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), method=method or ("POST" if body is not None else "GET"),
                                 data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, dict(r.headers), r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode()


def events(raw):
    out = []
    for block in raw.split("\n\n"):
        ev = [l[7:] for l in block.split("\n") if l.startswith("event: ")]
        dt = [l[6:] for l in block.split("\n") if l.startswith("data: ")]
        if ev and dt:
            out.append((ev[0], json.loads(dt[0])))
    return out


def main():
    want_claude = "--claude" in sys.argv
    fake = Srv(("127.0.0.1", 0), Fake)
    threading.Thread(target=fake.serve_forever, daemon=True).start()
    tmp = tempfile.mkdtemp()
    keyfile, favfile, portfile = (os.path.join(tmp, n) for n in ("key", "favs", "port"))
    env = dict(os.environ, OPENROUTER_PROXY_TOKEN=TOKEN, OPENROUTER_KEY_FILE=keyfile, OPENROUTER_MODELS_FILE=favfile,
               OPENROUTER_API_BASE="http://127.0.0.1:%d/api" % fake.server_address[1], NO_PROXY="127.0.0.1", no_proxy="127.0.0.1")
    proc = subprocess.Popen([sys.executable, PROXY, "--port-file", portfile], env=env)
    try:
        for _ in range(100):
            if os.path.exists(portfile):
                break
            time.sleep(0.05)
        port = int(open(portfile).read())
        user = [{"role": "user", "content": "hello"}]

        # --- who may talk to it, and without a key
        check("health needs no token", call(port, "/health", token="")[0] == 200)
        check("a wrong token is refused", call(port, "/v1/messages", {"model": "x", "messages": user}, token="nope")[0] == 401)
        s, _, b = call(port, "/v1/messages", {"model": "x", "messages": user})
        check("no key: says how to set one", s == 401 and "openrouter-key" in b, b)

        open(keyfile, "w").write("# comment\nor-test-key\n")
        # --- the model list
        open(favfile, "w").write("# my favourites\nopenai/gpt-5\ngoogle/gemini-x:free\n")
        s, _, b = call(port, "/v1/models")
        data = json.loads(b)["data"]
        ids = [m["id"] for m in data]
        check("models carry the anthropic/ prefix", s == 200 and all(i.startswith("anthropic/") for i in ids), ids)
        check("models that can't call tools or make no text are left out", not any("chat-only" in i or "picture" in i for i in ids), ids)
        check("favourites come first, then the newest", ids[:2] == ["anthropic/openai/gpt-5", "anthropic/google/gemini-x:free"]
              and ids[2] == "anthropic/anthropic/claude-sonnet-4.5", ids)
        check("display names are OpenRouter's", data[0]["display_name"] == "OpenAI: GPT-5", data[0])

        # --- a plain answer, whole and streamed, and what OpenRouter sees
        s, _, b = call(port, "/v1/messages", {"model": "anthropic/openai/gpt-5", "max_tokens": 50, "messages": user})
        check("whole answer passes through", s == 200 and json.loads(b)["content"][0]["text"] == "Hello from mock OpenRouter", b)
        h = {k.lower(): v for k, v in seen[-1][2].items()}
        check("OpenRouter gets the saved key, not the proxy token", h.get("authorization") == "Bearer or-test-key", h.get("authorization"))
        check("Anthropic's beta flags are not passed on", "anthropic-beta" not in h, list(h))
        check("an attribution title is sent", h.get("x-title") == "AntiCode")
        check("path on OpenRouter", seen[-1][1] == "/api/v1/messages", seen[-1][1])
        check("model: our prefix is taken off", seen[-1][3]["model"] == "openai/gpt-5", seen[-1][3]["model"])
        t0 = time.time()
        s, hdr, b = call(port, "/v1/messages", {"model": "anthropic/openai/gpt-5", "stream": True, "max_tokens": 50, "messages": user})
        ev = events(b)
        check("stream passes through whole and in order", [e[0] for e in ev] == ["message_start", "content_block_start", "content_block_delta",
              "content_block_stop", "message_delta", "message_stop"], [e[0] for e in ev])
        check("stream content type", hdr.get("content-type", "").startswith("text/event-stream"), hdr)

        # --- which OpenRouter model a name means
        for sent, expect in (("anthropic/openai/gpt-5", "openai/gpt-5"),
                             ("anthropic/anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-4.5"),
                             ("anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-4.5"),
                             ("openai/gpt-5", "openai/gpt-5"),
                             ("~anthropic/claude-sonnet-latest", "~anthropic/claude-sonnet-latest"),
                             ("claude-sonnet-4-5-20250929", "~anthropic/claude-sonnet-latest"),
                             ("claude-opus-4-8", "~anthropic/claude-opus-latest"),
                             ("claude-3-5-haiku-20241022", "~anthropic/claude-haiku-latest"),
                             ("claude-unknownthing-20250101", "anthropic/claude-unknownthing")):
            call(port, "/v1/messages", {"model": sent, "max_tokens": 5, "messages": user})
            check("model %s -> %s" % (sent, expect), seen[-1][3]["model"] == expect, seen[-1][3]["model"])

        # --- tools pass through untouched
        tools = [{"name": "Bash", "description": "run", "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}}}]
        ask = [{"role": "user", "content": "RUNTOOL"}]
        s, _, b = call(port, "/v1/messages", {"model": "anthropic/openai/gpt-5", "stream": True, "max_tokens": 50, "messages": ask, "tools": tools})
        ev = events(b)
        check("tool_use comes back", any(e[0] == "content_block_start" and e[1]["content_block"]["type"] == "tool_use" for e in ev) and ev[-2][1]["delta"]["stop_reason"] == "tool_use", ev)
        check("tools are sent on as they are", seen[-1][3]["tools"] == tools)

        # --- trouble: OpenRouter's own answer, as it is
        s, hdr, b = call(port, "/v1/messages", {"model": "anthropic/openai/gpt-5", "max_tokens": 5, "messages": [{"role": "user", "content": "RATELIMIT"}]})
        check("429 passes through with its body and Retry-After", s == 429 and json.loads(b)["error"]["type"] == "rate_limit_error" and hdr.get("retry-after") == "7", (s, hdr, b))

        # --- a new key works at once; a bad one is reported by OpenRouter
        open(keyfile, "w").write("or-other-key\n")
        call(port, "/v1/messages", {"model": "openai/gpt-5", "max_tokens": 5, "messages": user})
        check("a new key is used at once", {k.lower(): v for k, v in seen[-1][2].items()}.get("authorization") == "Bearer or-other-key", seen[-1][2])
        open(keyfile, "w").write("wrong\n")
        s, _, b = call(port, "/v1/messages", {"model": "openai/gpt-5", "max_tokens": 5, "messages": user})
        check("a bad key: OpenRouter's reason is passed on", s == 401 and "No auth credentials" in b, (s, b))
        open(keyfile, "w").write("or-test-key\n")

        s, _, b = call(port, "/v1/messages/count_tokens", {"model": "x", "messages": user})
        check("count_tokens estimates", s == 200 and json.loads(b)["input_tokens"] > 0, b)
        check("HEAD /api/hello", call(port, "/api/hello", token="", method="HEAD")[0] == 200)

        # --- the real Claude Code through it
        if want_claude:
            if not shutil.which("claude"):
                check("claude is installed", False, "no `claude` in PATH")
            else:
                cenv = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "ANTHROPIC"))}
                cenv.update(ANTHROPIC_BASE_URL="http://127.0.0.1:%d" % port, ANTHROPIC_AUTH_TOKEN=TOKEN,
                            ANTHROPIC_MODEL="anthropic/openai/gpt-5", CLAUDE_CONFIG_DIR=tempfile.mkdtemp(), DISABLE_AUTOUPDATER="1",
                            CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS="1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
                            CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1", NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
                n0 = len(seen)
                run = lambda args: subprocess.run(["claude", "-p"] + args + ["--output-format", "text"], env=cenv, capture_output=True,
                                                  text=True, timeout=240, cwd=tmp, stdin=subprocess.DEVNULL)
                r = run(["say hello"])
                check("Claude Code answers through the proxy", "Hello from mock OpenRouter" in r.stdout, (r.stdout[-300:], r.stderr[-500:]))
                got = [x for x in seen[n0:] if x[0] == "POST" and x[3].get("model") == "openai/gpt-5"]
                check("…as the OpenRouter model it was told", bool(got), [(x[1], (x[3] or {}).get("model")) for x in seen[n0:]])
                if got:
                    check("…with its tools and without Anthropic's beta flags", len(got[-1][3].get("tools", [])) > 10 and "anthropic-beta" not in {k.lower() for k in got[-1][2]},
                          (len(got[-1][3].get("tools", [])), list(got[-1][2])))
                r = run(["RUNTOOL run echo hi", "--allowedTools", "Bash"])
                check("Claude Code runs the tool the model asked for and sends the result back", "TOOL SAID" in r.stdout, (r.stdout[-300:], r.stderr[-500:]))
    finally:
        proc.terminate()
        fake.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
    print("\n%s" % ("all passed" if not fails else "%d FAILED" % fails))
    sys.exit(1 if fails else 0)


main()
