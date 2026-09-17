import json
import sys
import textwrap

import pytest

from token_audit.mcp_probe import ProbeError, describe_target, probe

FAKE_SERVER = textwrap.dedent("""
    import json, sys
    for line in sys.stdin:
        msg = json.loads(line)
        if "id" not in msg:
            continue
        if msg["method"] == "initialize":
            res = {"capabilities": {"tools": {}}, "instructions": "be nice"}
        elif msg["method"] == "tools/list":
            if msg.get("params", {}).get("cursor"):
                res = {"tools": [{"name": "b", "inputSchema": {"type": "object"}}]}
            else:
                res = {"tools": [{"name": "a", "description": "d"}], "nextCursor": "p2"}
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": res}), flush=True)
""")


def test_stdio_probe_paginates(tmp_path):
    script = tmp_path / "srv.py"
    script.write_text(FAKE_SERVER)
    tools, instructions = probe({"command": sys.executable, "args": [str(script)]}, str(tmp_path), 10)
    assert [t["name"] for t in tools] == ["a", "b"]
    assert instructions == "be nice"


def test_stdio_timeout_is_reported(tmp_path):
    script = tmp_path / "hang.py"
    script.write_text("import time\ntime.sleep(30)\n")
    with pytest.raises(ProbeError, match="időtúllépés"):
        probe({"command": sys.executable, "args": [str(script)]}, str(tmp_path), 1)


def test_missing_binary_is_reported(tmp_path):
    with pytest.raises(ProbeError):
        probe({"command": "definitely-not-a-binary-xyz"}, str(tmp_path), 5)


def test_target_redacts_secrets():
    cfg = {"command": "npx", "args": ["-y", "@x/server", "--api_token=abc", "A" * 40]}
    out = describe_target(cfg)
    assert "abc" not in out and "A" * 40 not in out
    assert "--api_token=***" in out and "@x/server" in out


def test_stderr_summary_prefers_error_line():
    from token_audit.mcp_probe import stderr_summary
    lines = ["at foo (x.js:1)", "Error: Cannot find module 'zod'", "}", "", "Node.js v22.1.0"]
    assert stderr_summary(lines) == "Error: Cannot find module 'zod'"


def test_http_probe_follows_308(tmp_path):
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path == "/mcp":
                self.send_response(308)
                self.send_header("Location", "/mcp/")
                self.end_headers()
                return
            if "id" not in body:
                self.send_response(202)
                self.end_headers()
                return
            res = ({"capabilities": {"tools": {}}} if body["method"] == "initialize"
                   else {"tools": [{"name": "t"}]})
            out = ("data: " + json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": res}) + "\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        tools, _ = probe({"type": "http", "url": f"http://127.0.0.1:{srv.server_port}/mcp"}, "", 5)
        assert [t["name"] for t in tools] == ["t"]
    finally:
        srv.shutdown()
