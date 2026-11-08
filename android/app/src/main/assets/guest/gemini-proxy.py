#!/usr/bin/env python3
"""AntiCode: lets Claude Code talk to Google Gemini.

Claude Code speaks Anthropic's Messages API; this small local server turns each request into a
Gemini API call and the answer back into Anthropic's format (streaming, tools and images
included). It listens on 127.0.0.1 only, asks for a secret token (so no other app on the phone
can use your key), reads the Gemini API key from a file at every request (a new key works at
once), and keeps nothing on disk. Python's standard library only.

  gemini-proxy.py [--port N] [--port-file FILE]

Environment: GEMINI_PROXY_TOKEN (required), GEMINI_KEY_FILE, GEMINI_API_BASE,
GEMINI_MODEL_PRO / GEMINI_MODEL_FLASH / GEMINI_MODEL_LITE (what Claude's Opus / Sonnet / Haiku
names mean), GEMINI_PROXY_DEBUG (one line per request on stderr: never prompts, never the key).
"""
import http.server
import json
import os
import queue
import re
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

API = os.environ.get("GEMINI_API_BASE", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
KEY_FILE = os.environ.get("GEMINI_KEY_FILE", os.path.expanduser("~/.config/agy-terminal/gemini-api-key"))
TOKEN = os.environ.get("GEMINI_PROXY_TOKEN", "")
MODEL_PRO = os.environ.get("GEMINI_MODEL_PRO", "gemini-pro-latest")
MODEL_FLASH = os.environ.get("GEMINI_MODEL_FLASH", "gemini-flash-latest")
MODEL_LITE = os.environ.get("GEMINI_MODEL_LITE", "gemini-flash-lite-latest")
# Claude Code lists a gateway's models only when their id contains "claude" or "anthropic":
# ours carry this prefix (and lose it again here)
PREFIX = "anthropic/"
MAX_OUT = 65536
# a function call from Gemini 3 must come back with its "thought signature"; one we never saw
# (the proxy restarted, another model made it) is waved through with Google's documented dummy
DUMMY_SIGNATURE = "skip_thought_signature_validator"
NOT_CHAT = re.compile(r"tts|image|lyria|transcribe|robotics|computer-use|deep-research|antigravity|nano-banana|omni|embedding|aqa|imagen|veo|live|audio", re.I)


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
    return os.environ.get("GEMINI_API_KEY", "").strip()


# ------------------------------------------------------------------ models
_models_cache = {"at": 0.0, "key": "", "list": []}
FALLBACK_MODELS = [
    ("gemini-pro-latest", "Gemini Pro (latest)"),
    ("gemini-flash-latest", "Gemini Flash (latest)"),
    ("gemini-flash-lite-latest", "Gemini Flash-Lite (latest)"),
    ("gemini-2.5-pro", "Gemini 2.5 Pro"),
    ("gemini-2.5-flash", "Gemini 2.5 Flash"),
    ("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite"),
]


def resolve_model(name):
    """The Gemini model for the name Claude Code sent."""
    m = (name or "").strip()
    if m.startswith(PREFIX):
        m = m[len(PREFIX):]
    if m.startswith("models/"):
        m = m[7:]
    low = m.lower()
    if low.startswith("gemini") or low.startswith("gemma"):
        return m
    if "haiku" in low:
        return MODEL_LITE
    if "opus" in low:
        return MODEL_PRO
    return MODEL_FLASH if (low.startswith("claude") or not m) else m


def list_models(key):
    now = time.time()
    if _models_cache["list"] and _models_cache["key"] == key and now - _models_cache["at"] < 600:
        return _models_cache["list"]
    out = []
    try:
        req = urllib.request.Request(API + "/models?pageSize=1000", headers={"x-goog-api-key": key})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.load(r)
        for m in data.get("models", []):
            mid = m.get("name", "").replace("models/", "")
            if not mid.startswith("gemini") or NOT_CHAT.search(mid):
                continue
            if "generateContent" not in m.get("supportedGenerationMethods", []):
                continue
            out.append((mid, m.get("displayName") or mid))
    except Exception:
        out = []
    if not out:
        out = FALLBACK_MODELS
    else:
        # the stand-ins for "the newest" first, then the rest, newest names first
        first = [m for m in out if m[0].endswith("-latest")]
        rest = sorted((m for m in out if not m[0].endswith("-latest")), key=lambda m: m[0], reverse=True)
        out = first + rest
    _models_cache.update(at=now, key=key, list=out)
    return out


# ------------------------------------------------------------------ Anthropic -> Gemini
SIGS = {}  # tool_use id -> the thought signature Gemini gave with that call
ID_NAME = {}


def text_of(content):
    if isinstance(content, str):
        return content
    out = []
    for b in content or []:
        if isinstance(b, dict) and b.get("type") == "text":
            out.append(b.get("text", ""))
    return "\n".join(t for t in out if t)


# what Gemini's function declarations accept (an OpenAPI subset)
KEEP = {"type", "format", "description", "nullable", "enum", "items", "properties", "required",
        "minItems", "maxItems", "minimum", "maximum", "anyOf", "title"}


def clean_schema(s, defs=None, depth=0):
    if not isinstance(s, dict) or depth > 24:
        return {"type": "string"}
    defs = defs if defs is not None else {**s.get("$defs", {}), **s.get("definitions", {})}
    ref = s.get("$ref")
    if isinstance(ref, str):
        target = defs.get(ref.rsplit("/", 1)[-1])
        if isinstance(target, dict):
            merged = {**target, **{k: v for k, v in s.items() if k != "$ref"}}
            return clean_schema(merged, defs, depth + 1)
        return {"type": "string"}
    out = {}
    t = s.get("type")
    if isinstance(t, list):
        non_null = [x for x in t if x != "null"]
        if "null" in t:
            out["nullable"] = True
        t = non_null[0] if non_null else "string"
    if "const" in s and "enum" not in s:
        out["enum"] = [s["const"]]
        t = t or ("string" if isinstance(s["const"], str) else None)
    any_of = s.get("anyOf") or s.get("oneOf")
    if any_of and not t:
        opts = [clean_schema(o, defs, depth + 1) for o in any_of if isinstance(o, dict) and o.get("type") != "null"]
        if len(opts) < len(any_of):
            out["nullable"] = True
        if len(opts) == 1:
            out.update(opts[0])
        elif opts:
            out["anyOf"] = opts
        else:
            out["type"] = "string"
        return finish_schema(out)
    if t:
        out["type"] = str(t).lower()
    for k, v in s.items():
        if k not in KEEP or k in ("type", "anyOf") or (k == "nullable" and "nullable" in out):
            continue
        if k == "properties" and isinstance(v, dict):
            out[k] = {pk: clean_schema(pv, defs, depth + 1) for pk, pv in v.items()}
        elif k == "items":
            out[k] = clean_schema(v, defs, depth + 1)
        elif k == "enum" and isinstance(v, list):
            out[k] = [x if isinstance(x, str) else str(x) for x in v]
        elif k == "required" and isinstance(v, list):
            out[k] = [r for r in v if r in (s.get("properties") or {})]
        else:
            out[k] = v
    return finish_schema(out)


def finish_schema(out):
    if out.get("type") == "object":
        if not out.get("properties"):
            # Gemini refuses an object without properties: a free-form one goes as text
            out = {"type": "string", "description": (out.get("description", "") + " (JSON object as text)").strip()}
        elif not out.get("required"):
            out.pop("required", None)
    if out.get("type") == "array" and "items" not in out:
        out["items"] = {"type": "string"}
    if "type" not in out and "anyOf" not in out and "enum" not in out:
        out["type"] = "string"
    return out


def upper_types(s):
    """Gemini's documented spelling of the types: STRING, OBJECT …"""
    if isinstance(s, dict):
        r = {}
        for k, v in s.items():
            if k == "type" and isinstance(v, str):
                r[k] = v.upper()
            elif k == "properties" and isinstance(v, dict):
                r[k] = {pk: upper_types(pv) for pk, pv in v.items()}
            elif k == "items":
                r[k] = upper_types(v)
            elif k == "anyOf" and isinstance(v, list):
                r[k] = [upper_types(x) for x in v]
            else:
                r[k] = v
        return r
    return s


def convert_tools(tools):
    decls = []
    for t in tools or []:
        if not isinstance(t, dict) or "input_schema" not in t or not t.get("name"):
            continue  # (server tools — web search … — Gemini can't run for us)
        d = {"name": t["name"][:64], "description": (t.get("description") or t["name"])[:4000]}
        params = clean_schema(t["input_schema"])
        if params.get("type") == "object" and params.get("properties"):
            d["parameters"] = upper_types(params)
        decls.append(d)
    return [{"functionDeclarations": decls}] if decls else []


def convert_contents(messages, model):
    contents = []
    id_name = {}
    needs_sig = not model.lower().startswith("gemini-2")

    def add(role, parts):
        if not parts:
            return
        if contents and contents[-1]["role"] == role:
            contents[-1]["parts"].extend(parts)
        else:
            contents.append({"role": role, "parts": parts})

    for m in messages or []:
        role = "model" if m.get("role") == "assistant" else "user"
        c = m.get("content")
        if isinstance(c, str):
            if c.strip():
                add(role, [{"text": c}])
            continue
        parts = []
        results = []
        for b in c or []:
            if not isinstance(b, dict):
                continue
            t = b.get("type")
            if t == "text":
                if b.get("text", "").strip():
                    parts.append({"text": b["text"]})
            elif t == "image":
                src = b.get("source") or {}
                if src.get("type") == "base64":
                    parts.append({"inlineData": {"mimeType": src.get("media_type", "image/png"), "data": src.get("data", "")}})
            elif t == "tool_use":
                tid = b.get("id", "")
                id_name[tid] = b.get("name", "")
                p = {"functionCall": {"name": b.get("name", "")[:64], "args": b.get("input") or {}}}
                sig = SIGS.get(tid)
                if sig:
                    p["thoughtSignature"] = sig
                elif needs_sig:
                    p["thoughtSignature"] = DUMMY_SIGNATURE
                parts.append(p)
            elif t == "tool_result":
                name = id_name.get(b.get("tool_use_id", ""), "") or ID_NAME.get(b.get("tool_use_id", ""), "tool")
                body = b.get("content")
                text = body if isinstance(body, str) else text_of(body)
                resp = {"error": text or "error"} if b.get("is_error") else {"output": text or ""}
                results.append({"functionResponse": {"name": name[:64], "response": resp}})
                if isinstance(body, list):
                    for x in body:
                        if isinstance(x, dict) and x.get("type") == "image" and (x.get("source") or {}).get("type") == "base64":
                            s = x["source"]
                            results.append({"inlineData": {"mimeType": s.get("media_type", "image/png"), "data": s.get("data", "")}})
            # (thinking / redacted_thinking blocks of an earlier model stay out)
        if role == "user":
            add("user", results + parts)  # the answers to the calls first, as Gemini expects
        else:
            add("model", parts)
    # Gemini wants a conversation that starts with the user
    while contents and contents[0]["role"] != "user":
        contents.pop(0)
    return contents


def to_gemini(body, model):
    req = {"contents": convert_contents(body.get("messages"), model)}
    system = body.get("system")
    sys_text = system if isinstance(system, str) else text_of(system)
    if sys_text and sys_text.strip():
        req["systemInstruction"] = {"parts": [{"text": sys_text}]}
    tools = convert_tools(body.get("tools"))
    if tools:
        req["tools"] = tools
        tc = body.get("tool_choice") or {}
        mode = {"any": "ANY", "tool": "ANY", "none": "NONE"}.get(tc.get("type"), "AUTO")
        cfg = {"mode": mode}
        if tc.get("type") == "tool" and tc.get("name"):
            cfg["allowedFunctionNames"] = [tc["name"][:64]]
        req["toolConfig"] = {"functionCallingConfig": cfg}
    gen = {}
    if isinstance(body.get("max_tokens"), int):
        gen["maxOutputTokens"] = max(1, min(body["max_tokens"], MAX_OUT))
    for src, dst in (("temperature", "temperature"), ("top_p", "topP"), ("top_k", "topK")):
        if isinstance(body.get(src), (int, float)):
            gen[dst] = body[src]
    if body.get("stop_sequences"):
        gen["stopSequences"] = [s for s in body["stop_sequences"] if s][:5]
    if gen:
        req["generationConfig"] = gen
    return req


# ------------------------------------------------------------------ Gemini -> Anthropic
def stop_reason(finish, used_tool):
    if used_tool:
        return "tool_use"
    return "max_tokens" if finish == "MAX_TOKENS" else "end_turn"


def blocked_note(finish, feedback):
    why = finish or (feedback or {}).get("blockReason") or "no answer"
    return f"[Gemini gave no text ({why}). Try rephrasing, or another model with /model.]"


def new_tool_id(name, sig):
    tid = "toolu_" + uuid.uuid4().hex[:24]
    ID_NAME[tid] = name
    if sig:
        SIGS[tid] = sig
    for d in (SIGS, ID_NAME):
        while len(d) > 3000:
            d.pop(next(iter(d)))
    return tid


def message_from_response(data, model):
    """A whole (not streamed) answer."""
    cand = (data.get("candidates") or [{}])[0]
    blocks = []
    used_tool = False
    for p in (cand.get("content") or {}).get("parts", []) or []:
        if p.get("thought"):
            continue
        if "text" in p and p["text"]:
            if blocks and blocks[-1]["type"] == "text":
                blocks[-1]["text"] += p["text"]
            else:
                blocks.append({"type": "text", "text": p["text"]})
        elif "functionCall" in p:
            fc = p["functionCall"]
            used_tool = True
            blocks.append({"type": "tool_use", "id": new_tool_id(fc.get("name", ""), p.get("thoughtSignature")),
                           "name": fc.get("name", ""), "input": fc.get("args") or {}})
    if not blocks:
        blocks.append({"type": "text", "text": blocked_note(cand.get("finishReason"), data.get("promptFeedback"))})
    u = data.get("usageMetadata") or {}
    return {
        "id": "msg_" + uuid.uuid4().hex[:24], "type": "message", "role": "assistant", "model": model,
        "content": blocks, "stop_reason": stop_reason(cand.get("finishReason"), used_tool), "stop_sequence": None,
        "usage": {"input_tokens": u.get("promptTokenCount", 0),
                  "output_tokens": u.get("candidatesTokenCount", 0) + u.get("thoughtsTokenCount", 0)},
    }


def error_body(status, message):
    kind = {400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error",
            413: "request_too_large", 429: "rate_limit_error", 529: "overloaded_error"}.get(status, "api_error")
    return {"type": "error", "error": {"type": kind, "message": message}}


def upstream_error(e):
    """(status, message) from a failed Gemini call."""
    try:
        err = json.load(e).get("error", {})
        msg = err.get("message") or str(e)
    except Exception:
        msg = str(e)
    status = e.code
    if status == 503:
        status = 529
    low = msg.lower()
    if status == 400 and ("token count" in low or "exceeds the maximum" in low or "too long" in low):
        msg = "prompt is too long: " + msg
    return status, "Gemini: " + msg


# ------------------------------------------------------------------ the server
class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "anticode-gemini-proxy"

    def log_message(self, fmt, *args):  # (never the prompts, never the key: only what was asked for)
        if os.environ.get("GEMINI_PROXY_DEBUG"):
            sys.stderr.write("proxy: %s %s -> %s\n" % (self.command, self.path.split("?")[0], fmt % args))

    # --- helpers
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

    def authorized(self):
        if not TOKEN:
            return False
        auth = self.headers.get("authorization", "")
        return auth == "Bearer " + TOKEN or self.headers.get("x-api-key", "") == TOKEN

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

    # --- routes
    def do_HEAD(self):
        self.send_response(200)
        self.send_header("content-length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/health", "/"):
            return self.send_json(200, {"ok": True})
        if not self.authorized():
            return self.send_json(401, error_body(401, "wrong proxy token"))
        if path == "/v1/models":
            key = read_key()
            if not key:
                return self.send_json(401, error_body(401, "No Gemini API key yet — run: gemini-key"))
            data = [{"type": "model", "id": PREFIX + mid, "display_name": name, "created_at": "2025-01-01T00:00:00Z"}
                    for mid, name in list_models(key)]
            return self.send_json(200, {"data": data, "has_more": False,
                                        "first_id": data[0]["id"] if data else None, "last_id": data[-1]["id"] if data else None})
        self.send_json(404, error_body(404, "not found"))

    def do_POST(self):
        path = self.path.split("?")[0]
        raw = self.read_body()  # (always: an early refusal must not leave it on a kept-alive connection)
        if not self.authorized():
            return self.send_json(401, error_body(401, "wrong proxy token"))
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            return self.send_json(400, error_body(400, "the request is not JSON"))
        if path == "/v1/messages/count_tokens":
            # (an estimate: about 3.5 characters a token — Claude Code only needs it roughly)
            n = len(json.dumps(body.get("messages", []))) + len(json.dumps(body.get("system", ""))) + len(json.dumps(body.get("tools", [])))
            return self.send_json(200, {"input_tokens": int(n / 3.5) + 1})
        if path != "/v1/messages":
            return self.send_json(404, error_body(404, "not found"))
        key = read_key()
        if not key:
            return self.send_json(401, error_body(401, "No Gemini API key yet — run: gemini-key  (or Settings → Gemini API key)"))
        shown = body.get("model") or MODEL_FLASH
        model = resolve_model(shown)
        try:
            gem = to_gemini(body, model)
        except Exception as e:  # a request shape we don't know
            return self.send_json(400, error_body(400, "can't convert the request: %s" % e))
        stream = bool(body.get("stream"))
        url = "%s/models/%s:%s" % (API, model, "streamGenerateContent?alt=sse" if stream else "generateContent")
        req = urllib.request.Request(url, data=json.dumps(gem).encode(), method="POST",
                                     headers={"content-type": "application/json", "x-goog-api-key": key})
        try:
            resp = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as e:
            status, msg = upstream_error(e)
            return self.send_json(status, error_body(status, msg))
        except Exception as e:
            return self.send_json(529, error_body(529, "Gemini can't be reached: %s" % e))
        if not stream:
            with resp:
                return self.send_json(200, message_from_response(json.load(resp), shown))
        self.stream_answer(resp, shown)

    # --- streaming
    def sse(self, event, obj):
        self.wfile.write(("event: %s\ndata: %s\n\n" % (event, json.dumps(obj))).encode())
        self.wfile.flush()

    def stream_answer(self, resp, shown):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()
        self.close_connection = True
        mid = "msg_" + uuid.uuid4().hex[:24]
        self.sse("message_start", {"type": "message_start", "message": {
            "id": mid, "type": "message", "role": "assistant", "model": shown, "content": [],
            "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 0, "output_tokens": 0}}})
        lines = queue.Queue()

        def pump():
            try:
                for raw in resp:
                    lines.put(raw)
            except Exception as e:
                lines.put(e)
            lines.put(None)

        threading.Thread(target=pump, daemon=True).start()
        idx = -1
        open_kind = None  # "text" | "tool" | None
        used_tool = False
        finish = None
        feedback = None
        usage = {}
        try:
            while True:
                try:
                    raw = lines.get(timeout=8)
                except queue.Empty:
                    self.sse("ping", {"type": "ping"})  # (a model that thinks for long: the line stays alive)
                    continue
                if raw is None:
                    break
                if isinstance(raw, Exception):
                    raise raw
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                try:
                    chunk = json.loads(line[5:].strip())
                except ValueError:
                    continue
                usage = chunk.get("usageMetadata") or usage
                feedback = chunk.get("promptFeedback") or feedback
                cand = (chunk.get("candidates") or [{}])[0]
                finish = cand.get("finishReason") or finish
                for p in (cand.get("content") or {}).get("parts", []) or []:
                    if p.get("thought"):
                        continue
                    if p.get("text"):
                        if open_kind != "text":
                            if open_kind:
                                self.sse("content_block_stop", {"type": "content_block_stop", "index": idx})
                            idx += 1
                            open_kind = "text"
                            self.sse("content_block_start", {"type": "content_block_start", "index": idx,
                                                              "content_block": {"type": "text", "text": ""}})
                        self.sse("content_block_delta", {"type": "content_block_delta", "index": idx,
                                                          "delta": {"type": "text_delta", "text": p["text"]}})
                    elif "functionCall" in p:
                        fc = p["functionCall"]
                        if open_kind:
                            self.sse("content_block_stop", {"type": "content_block_stop", "index": idx})
                        idx += 1
                        open_kind = "tool"
                        used_tool = True
                        name = fc.get("name", "")
                        self.sse("content_block_start", {"type": "content_block_start", "index": idx, "content_block": {
                            "type": "tool_use", "id": new_tool_id(name, p.get("thoughtSignature")), "name": name, "input": {}}})
                        self.sse("content_block_delta", {"type": "content_block_delta", "index": idx, "delta": {
                            "type": "input_json_delta", "partial_json": json.dumps(fc.get("args") or {})}})
            if idx < 0:  # nothing came: say why instead of an empty answer
                idx = 0
                open_kind = "text"
                self.sse("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
                self.sse("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                  "delta": {"type": "text_delta", "text": blocked_note(finish, feedback)}})
            if open_kind:
                self.sse("content_block_stop", {"type": "content_block_stop", "index": idx})
            self.sse("message_delta", {"type": "message_delta",
                                       "delta": {"stop_reason": stop_reason(finish, used_tool), "stop_sequence": None},
                                       "usage": {"input_tokens": usage.get("promptTokenCount", 0),
                                                 "output_tokens": usage.get("candidatesTokenCount", 0) + usage.get("thoughtsTokenCount", 0)}})
            self.sse("message_stop", {"type": "message_stop"})
        except (BrokenPipeError, ConnectionResetError):
            pass  # Claude Code went away (Esc): nothing more to say
        except Exception as e:
            try:
                self.sse("error", {"type": "error", "error": {"type": "api_error", "message": "Gemini stream broke: %s" % e}})
            except Exception:
                pass
        finally:
            try:
                resp.close()
            except Exception:
                pass


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
        sys.exit("GEMINI_PROXY_TOKEN is not set")
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
