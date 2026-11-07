#!/usr/bin/env python3
"""Tests of the Gemini proxy (android/app/src/main/assets/guest/gemini-proxy.py) against a
stand-in for Google's API — no key, no network:

  python3 scripts/gemini-proxy-test.py            # the proxy, called directly
  python3 scripts/gemini-proxy-test.py --claude   # also: a real Claude Code (`claude`) through it
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
PROXY = os.path.join(HERE, "..", "android", "app", "src", "main", "assets", "guest", "gemini-proxy.py")
TOKEN = "tok-" + os.urandom(6).hex()
seen = []  # what the stand-in received: (path, key, body)
fails = 0


def check(name, ok, extra=""):
    global fails
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else "   " + str(extra)))
    if not ok:
        fails += 1


# ------------------------------------------------------------------ the stand-in for Google
MODELS = ["gemini-pro-latest", "gemini-3.8-flash", "gemini-flash-latest", "gemini-2.5-pro", "gemini-3.8-flash-tts",
          "gemini-3.1-flash-image", "gemma-4-31b-it", "lyria-3.5", "gemini-flash-lite-latest"]


class Fake(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def reply(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        seen.append((self.path, self.headers.get("x-goog-api-key"), None))
        self.reply(200, {"models": [{"name": "models/" + m, "displayName": m.upper(),
                                      "supportedGenerationMethods": ["generateContent"]} for m in MODELS]})

    def do_POST(self):
        key = self.headers.get("x-goog-api-key")
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        seen.append((self.path, key, body))
        if key not in ("test-key", "other-key"):
            return self.reply(400, {"error": {"code": 400, "message": "API key not valid", "status": "INVALID_ARGUMENT"}})
        contents = body.get("contents", [])
        last = contents[-1]["parts"] if contents else []
        text = " ".join(p.get("text", "") for p in last)
        responses = [p["functionResponse"] for p in last if "functionResponse" in p]
        if "RATELIMIT" in text:
            return self.reply(429, {"error": {"code": 429, "message": "quota exceeded", "status": "RESOURCE_EXHAUSTED"}})
        if responses:
            chunks = [{"candidates": [{"content": {"role": "model", "parts": [{"text": "TOOL SAID: " + responses[0]["response"].get("output", "")}]},
                                       "finishReason": "STOP"}],
                       "usageMetadata": {"promptTokenCount": 30, "candidatesTokenCount": 5}}]
        elif "RUNTOOL" in text and body.get("tools"):
            chunks = [{"candidates": [{"content": {"role": "model", "parts": [
                {"functionCall": {"name": "Bash", "args": {"command": "echo hi"}}, "thoughtSignature": "sig123"}]},
                "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 40, "candidatesTokenCount": 8}}]
        elif "EMPTY" in text:
            chunks = [{"candidates": [{"finishReason": "SAFETY"}], "usageMetadata": {"promptTokenCount": 3}}]
        else:
            chunks = [{"candidates": [{"content": {"role": "model", "parts": [{"text": "Hello "}]}}]},
                      {"candidates": [{"content": {"role": "model", "parts": [{"text": "from mock"}]}, "finishReason": "STOP"}],
                       "usageMetadata": {"promptTokenCount": 11, "candidatesTokenCount": 3, "thoughtsTokenCount": 2}}]
        if ":generateContent" in self.path:
            merged = {"candidates": [{"content": {"role": "model", "parts": [p for c in chunks for p in c["candidates"][0].get("content", {}).get("parts", [])]},
                                      "finishReason": chunks[-1]["candidates"][0].get("finishReason")}],
                      "usageMetadata": chunks[-1].get("usageMetadata")}
            return self.reply(200, merged)
        out = b"".join(("data: " + json.dumps(c) + "\r\n\r\n").encode() for c in chunks)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class Srv(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


# ------------------------------------------------------------------ calling the proxy
def call(port, path, body=None, token=TOKEN, method=None):
    h = {"content-type": "application/json", "anthropic-version": "2023-06-01"}
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


BASH_TOOL = {
    "name": "Bash", "description": "Run a command",
    "input_schema": {
        "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "additionalProperties": False,
        "properties": {
            "command": {"type": "string", "description": "the command"},
            "timeout": {"type": ["number", "null"], "exclusiveMinimum": 0},
            "mode": {"anyOf": [{"type": "string", "enum": ["a", "b"]}, {"type": "null"}]},
            "opts": {"$ref": "#/$defs/Opts"},
            "kind": {"const": "bash"},
        },
        "required": ["command"],
        "$defs": {"Opts": {"type": "object", "properties": {"v": {"type": "boolean"}}, "additionalProperties": False}},
    },
}
NOARG_TOOL = {"name": "Clock", "description": "time", "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}}


def main():
    want_claude = "--claude" in sys.argv
    fake = Srv(("127.0.0.1", 0), Fake)
    threading.Thread(target=fake.serve_forever, daemon=True).start()
    tmp = tempfile.mkdtemp()
    keyfile = os.path.join(tmp, "key")
    portfile = os.path.join(tmp, "port")
    env = dict(os.environ, GEMINI_PROXY_TOKEN=TOKEN, GEMINI_KEY_FILE=keyfile,
               GEMINI_API_BASE="http://127.0.0.1:%d/v1beta" % fake.server_address[1])
    proc = subprocess.Popen([sys.executable, PROXY, "--port-file", portfile], env=env)
    try:
        for _ in range(100):
            if os.path.exists(portfile):
                break
            time.sleep(0.05)
        port = int(open(portfile).read())

        # --- who may talk to it, and without a key
        check("health needs no token", call(port, "/health", token="")[0] == 200)
        check("a wrong token is refused", call(port, "/v1/messages", {"model": "x", "messages": []}, token="nope")[0] == 401)
        s, _, b = call(port, "/v1/messages", {"model": "x", "messages": [{"role": "user", "content": "hi"}]})
        check("no key: says how to set one", s == 401 and "gemini-key" in b, b)

        open(keyfile, "w").write("# comment\ntest-key\n")
        # --- models for the /model picker
        s, _, b = call(port, "/v1/models")
        ids = [m["id"] for m in json.loads(b)["data"]]
        check("models carry the anthropic/ prefix", s == 200 and ids and all(i.startswith("anthropic/gemini") for i in ids), ids)
        check("tts / image / gemma / lyria are left out", not any(x in i for i in ids for x in ("tts", "image", "gemma", "lyria")), ids)
        check("the -latest names come first", ids[0].endswith("-latest") and ids[2].endswith("-latest"), ids)

        # --- a plain answer, whole and streamed
        user = [{"role": "user", "content": "hello"}]
        s, _, b = call(port, "/v1/messages", {"model": "anthropic/gemini-3.8-flash", "max_tokens": 100, "messages": user,
                                              "system": [{"type": "text", "text": "be brief", "cache_control": {"type": "ephemeral"}}]})
        m = json.loads(b)
        check("whole answer", s == 200 and m["content"][0]["text"] == "Hello from mock" and m["stop_reason"] == "end_turn", b)
        check("usage counts thinking tokens too", m["usage"] == {"input_tokens": 11, "output_tokens": 5}, m["usage"])
        up = [x for x in seen if x[2] and "gemini-3.8-flash:generateContent" in x[0]][-1][2]
        check("system prompt becomes systemInstruction", up["systemInstruction"]["parts"][0]["text"] == "be brief", up)
        check("the key travels in a header, not the URL", seen[-1][1] == "test-key" and "key=" not in seen[-1][0])

        s, hdr, b = call(port, "/v1/messages", {"model": "claude-sonnet-4-6", "stream": True, "max_tokens": 100, "messages": user})
        ev = events(b)
        names = [e[0] for e in ev]
        check("stream: event order", names[0] == "message_start" and names[1] == "content_block_start" and names[-3:] == ["content_block_stop", "message_delta", "message_stop"], names)
        text = "".join(e[1]["delta"]["text"] for e in ev if e[0] == "content_block_delta")
        check("stream: text", text == "Hello from mock", text)
        check("stream: ends with end_turn and usage", ev[-2][1]["delta"]["stop_reason"] == "end_turn" and ev[-2][1]["usage"]["output_tokens"] == 5, ev[-2])
        check("stream: content type", hdr.get("content-type", "").startswith("text/event-stream"), hdr)

        # --- which Gemini model a Claude name means
        for sent, expect in (("claude-opus-4-8", "gemini-pro-latest"), ("claude-3-5-haiku-20241022", "gemini-flash-lite-latest"),
                             ("claude-sonnet-4-6", "gemini-flash-latest"), ("anthropic/gemini-3.8-flash", "gemini-3.8-flash"),
                             ("gemini-2.5-pro", "gemini-2.5-pro")):
            call(port, "/v1/messages", {"model": sent, "max_tokens": 5, "messages": user})
            check("model %s -> %s" % (sent, expect), ("/models/%s:generateContent" % expect) in seen[-1][0], seen[-1][0])

        # --- tools: the schema, the call, the answer to it
        tools = [BASH_TOOL, NOARG_TOOL, {"type": "web_search_20250305", "name": "web_search"}]
        ask = [{"role": "user", "content": [{"type": "text", "text": "RUNTOOL please"}]}]
        s, _, b = call(port, "/v1/messages", {"model": "claude-opus-4-8", "stream": True, "max_tokens": 100, "messages": ask,
                                              "tools": tools, "tool_choice": {"type": "auto"}})
        ev = events(b)
        start = [e[1] for e in ev if e[0] == "content_block_start"][0]["content_block"]
        pj = "".join(e[1]["delta"]["partial_json"] for e in ev if e[0] == "content_block_delta")
        check("tool call becomes a tool_use block", start["type"] == "tool_use" and start["name"] == "Bash" and start["id"].startswith("toolu_"), start)
        check("its input arrives as JSON", json.loads(pj) == {"command": "echo hi"}, pj)
        check("stop reason is tool_use", ev[-2][1]["delta"]["stop_reason"] == "tool_use", ev[-2])
        up = seen[-1][2]
        decls = up["tools"][0]["functionDeclarations"]
        check("server tools are left out, a tool without arguments has no parameters",
              [d["name"] for d in decls] == ["Bash", "Clock"] and "parameters" not in decls[1], decls)
        pr = decls[0]["parameters"]
        flat = json.dumps(pr)
        check("schema: types in capitals, no $schema / additionalProperties / $ref / const",
              pr["type"] == "OBJECT" and not any(x in flat for x in ("$schema", "additionalProperties", "$ref", "const", "exclusive", '"string"')), flat)
        check("schema: nullable, anyOf-with-null and $ref resolved",
              pr["properties"]["timeout"] == {"type": "NUMBER", "nullable": True} and pr["properties"]["mode"]["type"] == "STRING"
              and pr["properties"]["opts"]["properties"]["v"]["type"] == "BOOLEAN" and pr["properties"]["kind"]["enum"] == ["bash"], flat)
        check("tool_choice auto", up["toolConfig"]["functionCallingConfig"]["mode"] == "AUTO")

        tid = start["id"]
        conv = ask + [
            {"role": "assistant", "content": [{"type": "text", "text": "running"}, {"type": "tool_use", "id": tid, "name": "Bash", "input": {"command": "echo hi"}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "content": [{"type": "text", "text": "hi"}]},
                                         {"type": "text", "text": "<reminder>"}]}]
        s, _, b = call(port, "/v1/messages", {"model": "claude-opus-4-8", "max_tokens": 100, "messages": conv, "tools": tools})
        check("the answer after the tool result", json.loads(b)["content"][0]["text"] == "TOOL SAID: hi", b)
        up = seen[-1][2]["contents"]
        fc = up[1]["parts"][1]
        check("the call goes back with Gemini's own thought signature", fc["functionCall"]["name"] == "Bash" and fc.get("thoughtSignature") == "sig123", fc)
        check("tool result becomes functionResponse (first in its turn)", up[2]["role"] == "user" and up[2]["parts"][0]["functionResponse"]["name"] == "Bash"
              and up[2]["parts"][0]["functionResponse"]["response"] == {"output": "hi"}, up[2])
        # a call the proxy never saw (it restarted): Gemini 3 gets the documented dummy signature, Gemini 2.5 none
        conv2 = [ask[0], {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_unknown", "name": "Bash", "input": {}}]},
                 {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_unknown", "content": "x"}]}]
        call(port, "/v1/messages", {"model": "gemini-3.8-flash", "max_tokens": 5, "messages": conv2})
        check("unknown call, Gemini 3: dummy signature", seen[-1][2]["contents"][1]["parts"][0].get("thoughtSignature") == "skip_thought_signature_validator")
        call(port, "/v1/messages", {"model": "gemini-2.5-pro", "max_tokens": 5, "messages": conv2})
        check("unknown call, Gemini 2.5: no signature", "thoughtSignature" not in seen[-1][2]["contents"][1]["parts"][0])

        # --- trouble
        s, hdr, b = call(port, "/v1/messages", {"model": "claude-sonnet-4-6", "max_tokens": 5, "messages": [{"role": "user", "content": "RATELIMIT"}]})
        check("429 stays 429 (Claude Code retries it)", s == 429 and json.loads(b)["error"]["type"] == "rate_limit_error" and hdr.get("x-should-retry") == "true", (s, b))
        s, _, b = call(port, "/v1/messages", {"model": "claude-sonnet-4-6", "stream": True, "max_tokens": 5, "messages": [{"role": "user", "content": "EMPTY"}]})
        ev = events(b)
        check("an answer blocked by Gemini says so", "SAFETY" in json.dumps(ev) and ev[-1][0] == "message_stop", ev)

        # --- a new key works at once, a bad one is reported
        open(keyfile, "w").write("other-key\n")
        call(port, "/v1/messages", {"model": "claude-sonnet-4-6", "max_tokens": 5, "messages": user})
        check("a new key is used at once", seen[-1][1] == "other-key", seen[-1][1])
        open(keyfile, "w").write("wrong\n")
        s, _, b = call(port, "/v1/messages", {"model": "claude-sonnet-4-6", "max_tokens": 5, "messages": user})
        check("a bad key: Gemini's reason is passed on", s == 400 and "API key not valid" in b, (s, b))
        open(keyfile, "w").write("test-key\n")

        s, _, b = call(port, "/v1/messages/count_tokens", {"model": "x", "messages": user})
        check("count_tokens estimates", s == 200 and json.loads(b)["input_tokens"] > 0, b)
        check("HEAD /api/hello", call(port, "/api/hello", token="", method="HEAD")[0] == 200)

        # --- the real Claude Code through it
        if want_claude:
            if not shutil.which("claude"):
                check("claude is installed", False, "no `claude` in PATH")
            else:
                # a clean environment for it: nothing of this machine's own Claude / Anthropic setup
                cenv = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "ANTHROPIC"))}
                cenv.update(ANTHROPIC_BASE_URL="http://127.0.0.1:%d" % port, ANTHROPIC_AUTH_TOKEN=TOKEN,
                            ANTHROPIC_MODEL="anthropic/gemini-3.8-flash", CLAUDE_CONFIG_DIR=tempfile.mkdtemp(), DISABLE_AUTOUPDATER="1",
                            CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS="1", DISABLE_PROMPT_CACHING="1",
                            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1", CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1",
                            CLAUDE_CODE_MAX_CONTEXT_TOKENS="1000000",
                            # (a machine that sends web traffic through an HTTP proxy must not send this local call)
                            NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
                n0 = len(seen)
                run = lambda args: subprocess.run(["claude", "-p"] + args + ["--output-format", "text"], env=cenv, capture_output=True,
                                                  text=True, timeout=240, cwd=tmp, stdin=subprocess.DEVNULL)
                r = run(["say hello"])
                check("Claude Code answers through the proxy", "Hello from mock" in r.stdout, (r.stdout[-300:], r.stderr[-500:]))
                got = [x for x in seen[n0:] if x[2] and "gemini-3.8-flash" in x[0]]
                check("…as the Gemini model it was told", bool(got), [x[0] for x in seen[n0:]])
                if got:
                    tn = [d["name"] for t in got[-1][2].get("tools", []) for d in t["functionDeclarations"]]
                    check("…with its tools converted (%d)" % len(tn), "Bash" in tn and "Read" in tn, tn[:8])
                # a prompt that makes it use a tool, answered by the stand-in
                r = run(["RUNTOOL run echo hi", "--allowedTools", "Bash"])
                check("Claude Code runs the tool Gemini asked for and sends the result back", "TOOL SAID" in r.stdout and "hi" in r.stdout, (r.stdout[-300:], r.stderr[-500:]))
    finally:
        proc.terminate()
        fake.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
    print("\n%s" % ("all passed" if not fails else "%d FAILED" % fails))
    sys.exit(1 if fails else 0)


main()
