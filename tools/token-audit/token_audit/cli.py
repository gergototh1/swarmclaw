"""Command line entry point: python -m token_audit"""
from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from .analysis import build_recommendations, find_duplicates, mark_shadowed
from .counter import DEFAULT_MODEL, TokenCounter
from .discovery import ClaudeHome, discover_mcp_configs, discover_skills
from .mcp_probe import ProbeError, describe_target, probe, transport_of
from .model import McpServer, McpTool
from .report import render_markdown, summarize


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def group_servers(entries: list[dict]) -> list[tuple[McpServer, dict]]:
    groups: dict[tuple, tuple[McpServer, dict]] = {}
    for e in entries:
        cfg = e["config"]
        ident = (e["name"], transport_of(cfg), cfg.get("url") or cfg.get("command"),
                 json.dumps([a for a in cfg.get("args") or [] if a not in ("-y", "--yes")]))
        if ident in groups:
            if e["scope"] not in groups[ident][0].scopes:
                groups[ident][0].scopes.append(e["scope"])
            continue
        srv = McpServer(e["name"], transport_of(cfg), [e["scope"]], describe_target(cfg))
        extra = {"CLAUDE_PLUGIN_ROOT": e["plugin_root"]} if e.get("plugin_root") else {}
        groups[ident] = (srv, {"cfg": cfg, "cwd": e["cwd"], "env": extra})
    return list(groups.values())


def measure_server(srv: McpServer, ctx: dict, timeout: float) -> None:
    t0 = time.monotonic()
    try:
        tools, instructions = probe(ctx["cfg"], ctx["cwd"], timeout, ctx["env"])
    except ProbeError as exc:
        srv.status, srv.reason = "unmeasurable", str(exc)
        srv.elapsed_s = round(time.monotonic() - t0, 1)
        return
    except Exception as exc:  # noqa: BLE001 - never stop the audit
        srv.status, srv.reason = "unmeasurable", f"váratlan hiba: {type(exc).__name__}: {exc}"
        srv.elapsed_s = round(time.monotonic() - t0, 1)
        return
    srv.status = "ok"
    srv.elapsed_s = round(time.monotonic() - t0, 1)
    srv._raw = (tools, instructions)  # type: ignore[attr-defined]
    if not tools:
        srv.reason = "nincs eszköz (tools/list üres vagy nem támogatott)"


def count_server(srv: McpServer, counter: TokenCounter) -> None:
    tools, instructions = srv._raw  # type: ignore[attr-defined]
    srv.instructions_tokens = counter.count(instructions)
    short = srv.name.split(":")[-1]
    for t in tools:
        schema = t.get("inputSchema") or {}
        full = json.dumps({"name": t.get("name"), "description": t.get("description") or "",
                           "input_schema": schema}, ensure_ascii=False)
        srv.tools.append(McpTool(
            name=str(t.get("name")),
            description_tokens=counter.count(t.get("description") or ""),
            schema_tokens=counter.count(json.dumps(schema, ensure_ascii=False)),
            total_tokens=counter.count(full),
            name_only_tokens=counter.count(f"mcp__{short}__{t.get('name')}"),
        ))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="token_audit", description=__doc__)
    ap.add_argument("--json", type=Path, help="write raw data to this JSON file")
    ap.add_argument("--md", type=Path, help="write the Markdown report to this file")
    ap.add_argument("--no-mcp", action="store_true", help="skip starting MCP servers")
    ap.add_argument("--timeout", type=float, default=30.0, help="per-server MCP timeout (s)")
    ap.add_argument("--project-root", type=Path, action="append",
                    help="where to look for project .claude/skills and .mcp.json (default: ~/DEV)")
    ap.add_argument("--home", type=Path, default=Path.home())
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--estimate", action="store_true", help="never call the API")
    ap.add_argument("--cache", type=Path, default=Path.home() / ".cache" / "token-audit" / "counts.json")
    ap.add_argument("--top", type=int, default=20)
    args = ap.parse_args(argv)

    roots = args.project_root or [args.home / "DEV"]
    ch = ClaudeHome.load(args.home)
    counter = TokenCounter(cache_path=args.cache, model=args.model, force_estimate=args.estimate)
    _log(f"token counting: {counter.method}" + (f" (fallback: {counter.fallback_reason})" if counter.is_estimate else ""))

    skills = discover_skills(ch, roots)
    _log(f"skills found: {len(skills)}")
    for s in skills:
        text = getattr(s, "_text", "")
        s.listing_tokens = counter.count(f"- {s.qualified_name}: {s.description or ''}")
        s.body_tokens = counter.count(text)

    servers: list[McpServer] = []
    if not args.no_mcp:
        pairs = group_servers(discover_mcp_configs(ch, roots))
        _log(f"probing {len(pairs)} MCP servers (timeout {args.timeout:.0f}s each)…")
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda p: measure_server(p[0], p[1], args.timeout), pairs))
        for srv, _ in pairs:
            if srv.status == "ok":
                count_server(srv, counter)
            _log(f"  {srv.name:40s} {srv.status:13s} {len(srv.tools):3d} tools  {srv.reason or ''}")
            servers.append(srv)
    counter.save()

    mark_shadowed(skills)
    dups = find_duplicates(skills)
    recs = build_recommendations(skills, servers, dups)
    now = datetime.now().astimezone()
    title = f"Token-audit – skillek és MCP-k – {now:%Y-%m-%d}"
    md = render_markdown(title=title, generated=now.strftime("%Y-%m-%d %H:%M %Z"),
                         counter_method=counter.method, is_estimate=counter.is_estimate,
                         fallback_reason=counter.fallback_reason, skills=skills, servers=servers,
                         dups=dups, recs=recs, home=str(args.home), top=args.top, mcp_skipped=args.no_mcp)
    data = {
        "generated": now.isoformat(), "counter": {"method": counter.method, "estimate": counter.is_estimate,
                                                  "fallback_reason": counter.fallback_reason,
                                                  "api_calls": counter.api_calls},
        "summary": summarize(skills, servers),
        "skills": [s.to_dict() for s in skills],
        "mcp_servers": [s.to_dict() for s in servers],
        "duplicates": [{"kind": g.kind, "key": g.key, "similarity": g.similarity,
                        "skills": [s.qualified_name for s in g.skills]} for g in dups],
        "recommendations": recs,
    }
    if args.md:
        args.md.parent.mkdir(parents=True, exist_ok=True)
        args.md.write_text(md)
        _log(f"markdown: {args.md}")
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(data, ensure_ascii=False, indent=2))
        _log(f"json: {args.json}")
    if not args.md:
        print(md)
    return 0
