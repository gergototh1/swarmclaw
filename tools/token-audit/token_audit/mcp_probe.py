"""Ask MCP servers for their tool list (tools/list) over stdio or streamable HTTP.

Stdlib only. Every failure is turned into a readable "unmeasurable" reason;
nothing here raises to the caller.
"""
from __future__ import annotations

import json
import os
import queue
import re
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

PROTOCOL_VERSION = "2025-06-18"
CLIENT_INFO = {"name": "token-audit", "version": "0.1.0"}
SECRET_WORD = re.compile(r"(token|key|secret|passw|auth|bearer)", re.I)
ENV_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")


class ProbeError(Exception):
    pass


def expand(value: str, env: dict[str, str]) -> str:
    return ENV_RE.sub(lambda m: env.get(m.group(1), m.group(2) or ""), value)


def redact_arg(arg: str) -> str:
    if "=" in arg and SECRET_WORD.search(arg.split("=", 1)[0]):
        return arg.split("=", 1)[0] + "=***"
    if len(arg) >= 30 and "/" not in arg and not arg.startswith("@") and " " not in arg:
        return "***"
    return arg


def describe_target(cfg: dict) -> str:
    if cfg.get("url"):
        return re.sub(r"([?&][^=]*(?:key|token)[^=]*=)[^&]+", r"\1***", cfg["url"], flags=re.I)
    return " ".join([cfg.get("command", "?")] + [redact_arg(str(a)) for a in cfg.get("args") or []])


def transport_of(cfg: dict) -> str:
    t = cfg.get("type")
    if t:
        return "http" if t == "streamable-http" else t
    return "http" if cfg.get("url") else "stdio"


def _scrub(text: str) -> str:
    text = re.sub(r"(?i)(bearer\s+)\S+", r"\1***", text)
    text = re.sub(r"\b[A-Za-z0-9_\-\.]{32,}\b", "***", text)
    return text.strip()[:200]


def stderr_summary(lines: list[str]) -> str:
    """Pick the most telling stderr line (the last one that names an error)."""
    meaningful = [ln.strip() for ln in lines if ln.strip() and ln.strip() not in ("}", "{", "^")
                  and not ln.strip().startswith("Node.js v")]
    errs = [ln for ln in meaningful if re.search(r"(error|exception|cannot|not found|denied)", ln, re.I)]
    pick = errs[-1] if errs else (meaningful[-1] if meaningful else "")
    return _scrub(pick)


# ------------------------------------------------------------------ stdio

class _Stdio:
    def __init__(self, cfg: dict, cwd: str, env: dict[str, str]):
        cmd = [expand(cfg["command"], env)] + [expand(str(a), env) for a in cfg.get("args") or []]
        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=cwd if cwd and os.path.isdir(cwd) else None, env=env, start_new_session=True)
        self.q: queue.Queue = queue.Queue()
        self.stderr: list[str] = []  # bounded tail
        threading.Thread(target=self._read_out, daemon=True).start()
        threading.Thread(target=self._read_err, daemon=True).start()

    def _read_out(self):
        for raw in self.proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                self.q.put(json.loads(line))
            except ValueError:
                pass  # servers sometimes log to stdout
        self.q.put(None)

    def _read_err(self):
        for raw in self.proc.stderr:
            self.stderr.append(raw.decode("utf-8", "replace").rstrip())
            del self.stderr[:-40]

    def send(self, msg: dict):
        try:
            self.proc.stdin.write((json.dumps(msg) + "\n").encode())
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise ProbeError(f"a folyamat kilépett ({self._tail()})") from exc

    def _tail(self) -> str:
        return stderr_summary(self.stderr) or f"exit={self.proc.poll()}"

    def request(self, rid: int, method: str, params: dict, deadline: float) -> dict:
        self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise ProbeError(f"időtúllépés ({method}); stderr: {self._tail()}")
            try:
                msg = self.q.get(timeout=left)
            except queue.Empty:
                continue
            if msg is None:
                raise ProbeError(f"a folyamat kilépett ({self._tail()})")
            if "method" in msg and "id" in msg:  # server->client request: answer politely
                result = {"roots": []} if msg["method"] == "roots/list" else {}
                self.send({"jsonrpc": "2.0", "id": msg["id"], "result": result})
                continue
            if msg.get("id") == rid:
                if "error" in msg:
                    raise ProbeError(f"{method} hiba: {_scrub(json.dumps(msg['error']))}")
                return msg.get("result") or {}

    def close(self):
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
        except OSError:
            pass
        try:
            self.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except OSError:
                pass


def _session(request, notify, deadline: float) -> tuple[list[dict], str]:
    init = request(1, "initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                                     "clientInfo": CLIENT_INFO}, deadline)
    notify({"jsonrpc": "2.0", "method": "notifications/initialized"})
    if "tools" not in (init.get("capabilities") or {}):
        return [], init.get("instructions") or ""
    tools: list[dict] = []
    cursor = None
    rid = 2
    while True:
        res = request(rid, "tools/list", {"cursor": cursor} if cursor else {}, deadline)
        tools.extend(res.get("tools") or [])
        cursor = res.get("nextCursor")
        rid += 1
        if not cursor or rid > 50:
            break
    return tools, init.get("instructions") or ""


def probe_stdio(cfg: dict, cwd: str, timeout: float, extra_env: dict | None = None) -> tuple[list[dict], str]:
    env = dict(os.environ)
    env.update(extra_env or {})
    env.update({k: expand(str(v), env) for k, v in (cfg.get("env") or {}).items()})
    try:
        conn = _Stdio(cfg, cwd, env)
    except (OSError, KeyError) as exc:
        raise ProbeError(f"nem indítható: {exc}") from exc
    try:
        return _session(conn.request, conn.send, time.monotonic() + timeout)
    finally:
        conn.close()


# ------------------------------------------------------------------ http

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib refuses to re-POST on 307/308; handle every redirect ourselves."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _raise_http(exc: urllib.error.HTTPError, payload: dict):
    if exc.code in (401, 403):
        raise ProbeError(f"hitelesítés szükséges (HTTP {exc.code})") from exc
    raise ProbeError(f"HTTP {exc.code} ({payload.get('method')})") from exc


def _parse_http_body(body: str, ctype: str, rid: int) -> dict | None:
    if "text/event-stream" in ctype:
        data: list[str] = []
        for line in body.splitlines() + [""]:
            if line.startswith("data:"):
                data.append(line[5:].strip())
            elif line == "" and data:
                try:
                    msg = json.loads("\n".join(data))
                except ValueError:
                    msg = None
                data = []
                if isinstance(msg, dict) and msg.get("id") == rid:
                    return msg
        return None
    if not body.strip():
        return None
    msg = json.loads(body)
    if isinstance(msg, list):
        return next((m for m in msg if m.get("id") == rid), None)
    return msg


def probe_http(cfg: dict, timeout: float, extra_env: dict | None = None) -> tuple[list[dict], str]:
    env = dict(os.environ)
    env.update(extra_env or {})
    url = expand(cfg["url"], env)
    headers = {k: expand(str(v), env) for k, v in (cfg.get("headers") or {}).items()}
    deadline = time.monotonic() + timeout
    state = {"sid": None, "url": url}

    def post(payload: dict) -> tuple[str, str]:
        h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
             "MCP-Protocol-Version": PROTOCOL_VERSION, **headers}
        if state["sid"]:
            h["Mcp-Session-Id"] = state["sid"]
        for _hop in range(4):
            req = urllib.request.Request(state["url"], data=json.dumps(payload).encode(), headers=h, method="POST")
            left = max(1.0, deadline - time.monotonic())
            try:
                with _OPENER.open(req, timeout=left) as resp:
                    sid = resp.headers.get("Mcp-Session-Id")
                    if sid:
                        state["sid"] = sid
                    return resp.read().decode("utf-8", "replace"), resp.headers.get("Content-Type", "")
            except urllib.error.HTTPError as exc:
                if exc.code in (301, 302, 307, 308) and exc.headers.get("Location"):
                    state["url"] = urllib.parse.urljoin(state["url"], exc.headers["Location"])
                    continue
                _raise_http(exc, payload)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                raise ProbeError(f"hálózati hiba / időtúllépés: {getattr(exc, 'reason', exc)}") from exc
        raise ProbeError("túl sok átirányítás")

    def request(rid, method, params, _deadline):
        if time.monotonic() > deadline:
            raise ProbeError(f"időtúllépés ({method})")
        body, ctype = post({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        try:
            msg = _parse_http_body(body, ctype, rid)
        except ValueError as exc:
            raise ProbeError(f"érvénytelen válasz ({method})") from exc
        if msg is None:
            raise ProbeError(f"nincs válasz ({method})")
        if "error" in msg:
            raise ProbeError(f"{method} hiba: {_scrub(json.dumps(msg['error']))}")
        return msg.get("result") or {}

    def notify(msg):
        try:
            post(msg)
        except ProbeError:
            pass

    return _session(request, notify, deadline)


def probe(cfg: dict, cwd: str, timeout: float = 30.0, extra_env: dict | None = None) -> tuple[list[dict], str]:
    t = transport_of(cfg)
    if t == "stdio":
        if not cfg.get("command"):
            raise ProbeError("hiányzó command")
        return probe_stdio(cfg, cwd, timeout, extra_env)
    if t == "http":
        return probe_http(cfg, timeout, extra_env)
    raise ProbeError(f"nem támogatott transport: {t}")
