"""Markdown and JSON rendering."""
from __future__ import annotations

from collections import defaultdict

from .analysis import LONG_DESCRIPTION_TOKENS
from .model import DuplicateGroup, McpServer, Skill


def _cell(text: str | None, limit: int = 90) -> str:
    t = (text or "").replace("|", "\\|").replace("\n", " ").strip()
    return t if len(t) <= limit else t[: limit - 1] + "…"


def _home(path: str, home: str) -> str:
    return path.replace(home, "~", 1) if path.startswith(home) else path


def startup_items(skills: list[Skill], servers: list[McpServer]) -> list[dict]:
    items = [{"kind": "skill", "name": s.qualified_name, "tokens": s.listing_tokens}
             for s in skills if s.active]
    for srv in servers:
        if srv.status == "ok" and srv.user_level:
            items += [{"kind": "mcp-tool", "name": f"{srv.name} › {t.name}", "tokens": t.total_tokens}
                      for t in srv.tools]
            if srv.instructions_tokens:
                items.append({"kind": "mcp-instructions", "name": f"{srv.name} (instructions)",
                              "tokens": srv.instructions_tokens})
    return sorted(items, key=lambda i: -i["tokens"])


def summarize(skills: list[Skill], servers: list[McpServer]) -> dict:
    active = [s for s in skills if s.active]
    user_srv = [s for s in servers if s.status == "ok" and s.user_level]
    skill_tokens = sum(s.listing_tokens for s in active)
    mcp_full = sum(s.total_tokens for s in user_srv)
    mcp_names = sum(s.name_only_tokens for s in user_srv) + sum(s.instructions_tokens for s in user_srv)
    return {
        "skills_total_found": len(skills),
        "skills_active_global": len(active),
        "skills_inactive": sum(1 for s in skills if s.scope == "inactive"),
        "skills_project": sum(1 for s in skills if s.scope.startswith("project")),
        "skill_listing_tokens": skill_tokens,
        "skill_body_tokens_active": sum(s.body_tokens for s in active),
        "mcp_servers_total": len(servers),
        "mcp_servers_measured": sum(1 for s in servers if s.status == "ok"),
        "mcp_servers_user_level_measured": len(user_srv),
        "mcp_user_tools": sum(len(s.tools) for s in user_srv),
        "mcp_user_full_schema_tokens": mcp_full,
        "mcp_user_deferred_tokens": mcp_names,
        "startup_total_eager": skill_tokens + mcp_full,
        "startup_total_deferred": skill_tokens + mcp_names,
    }


def render_markdown(*, title: str, generated: str, counter_method: str, is_estimate: bool,
                    fallback_reason: str | None, skills: list[Skill], servers: list[McpServer],
                    dups: list[DuplicateGroup], recs: list[dict], home: str, top: int = 20,
                    mcp_skipped: bool = False) -> str:
    S = summarize(skills, servers)
    active = [s for s in skills if s.active]
    L: list[str] = [f"# {title}", "", f"Készült: {generated}", ""]
    if is_estimate:
        L += [f"> **FIGYELEM: a számok BECSLÉSEK** (`{counter_method}`). Ok: {fallback_reason}. "
              "A Claude tokenizere jellemzően 10-30%-kal több tokent ad, magyar szövegnél akár többet is. "
              "Pontos számhoz futtasd `ANTHROPIC_API_KEY`-jel.", ""]
    else:
        L += [f"Mérés: Anthropic `messages.count_tokens` (`{counter_method}`), üzenet-overhead levonva.", ""]

    L += ["## Összesítő", "",
          "| Tétel | Darab | Token |", "|---|---:|---:|",
          f"| Aktív globális skillek listázása (minden session) | {S['skills_active_global']} | {S['skill_listing_tokens']:,} |",
          f"| User-szintű MCP eszközök, teljes sémával | {S['mcp_user_tools']} | {S['mcp_user_full_schema_tokens']:,} |",
          f"| User-szintű MCP eszközök, csak névvel (ToolSearch/deferred mód) | {S['mcp_user_tools']} | {S['mcp_user_deferred_tokens']:,} |",
          f"| **Induló összesen, ha az MCP-sémák betöltődnek** | | **{S['startup_total_eager']:,}** |",
          f"| **Induló összesen, deferred MCP módban** | | **{S['startup_total_deferred']:,}** |",
          f"| Aktív skillek teljes törzse (csak használatkor, összeadva) | {S['skills_active_global']} | {S['skill_body_tokens_active']:,} |",
          "",
          f"Talált SKILL.md: {S['skills_total_found']} (aktív globális {S['skills_active_global']}, "
          f"projekt-szintű {S['skills_project']}, inaktív cache/letiltott {S['skills_inactive']}). "
          f"MCP szerver-konfiguráció: {S['mcp_servers_total']}, ebből mérve {S['mcp_servers_measured']}.",
          "",
          "Megjegyzés: a Claude Code friss verziói az MCP-eszközöket ToolSearch-csel késleltetve töltik be "
          "(ekkor csak a nevek kerülnek a promptba), ezért két induló összeget adunk. A claude.ai "
          "connectorok (Gmail, Vercel, Docs stb.) nincsenek helyi konfigban, ezeket az eszköz nem látja.",
          ""]
    if mcp_skipped:
        L += ["_Az MCP-mérés ki volt kapcsolva (`--no-mcp`)._", ""]

    L += [f"## Top {min(10, top)} legdrágább induló tétel", "", "| # | Típus | Tétel | Token |", "|---:|---|---|---:|"]
    for i, it in enumerate(startup_items(skills, servers)[:10], 1):
        L.append(f"| {i} | {it['kind']} | `{_cell(it['name'], 70)}` | {it['tokens']:,} |")
    L.append("")

    L += [f"## Top {top} skill: induló költség (név + leírás)", "",
          "| # | Skill | Forrás | Listázás | Törzs |", "|---:|---|---|---:|---:|"]
    for i, s in enumerate(sorted(active, key=lambda s: -s.listing_tokens)[:top], 1):
        L.append(f"| {i} | `{s.qualified_name}` | {_cell(s.source, 40)} | {s.listing_tokens} | {s.body_tokens:,} |")
    L += ["", f"## Top {top} skill: használati költség (teljes SKILL.md)", "",
          "| # | Skill | Törzs | Útvonal |", "|---:|---|---:|---|"]
    for i, s in enumerate(sorted(active, key=lambda s: -s.body_tokens)[:top], 1):
        L.append(f"| {i} | `{s.qualified_name}` | {s.body_tokens:,} | {_cell(_home(s.path, home), 80)} |")
    L.append("")

    if not mcp_skipped:
        L += ["## MCP szerverek", "",
              "| Szerver | Hatókör | Transport | Állapot | Eszköz | Teljes token | Csak név | Megjegyzés |",
              "|---|---|---|---|---:|---:|---:|---|"]
        for srv in sorted(servers, key=lambda s: (s.status != "ok", -s.total_tokens, s.name)):
            scopes = ", ".join(_home(x, home) for x in srv.scopes)
            state = "mérve" if srv.status == "ok" else "**nem mérhető**"
            note = srv.reason or (f"instructions: {srv.instructions_tokens} token" if srv.instructions_tokens else "")
            L.append(f"| `{srv.name}` | {_cell(scopes, 60)} | {srv.transport} | {state} | {len(srv.tools)} | "
                     f"{srv.total_tokens:,} | {srv.name_only_tokens:,} | {_cell(note, 80)} |")
        L += ["", f"## Top {top} MCP eszköz", "",
              "| # | Szerver › eszköz | Hatókör | Leírás | Séma | Összes |", "|---:|---|---|---:|---:|---:|"]
        tools = [(srv, t) for srv in servers if srv.status == "ok" for t in srv.tools]
        for i, (srv, t) in enumerate(sorted(tools, key=lambda x: -x[1].total_tokens)[:top], 1):
            sc = "user" if srv.user_level else "projekt"
            L.append(f"| {i} | `{srv.name} › {t.name}` | {sc} | {t.description_tokens} | {t.schema_tokens} | {t.total_tokens:,} |")
        L.append("")

    L += ["## Duplikált skillek", ""]
    if not dups:
        L += ["Nincs.", ""]
    else:
        L += ["| Típus | Kulcs | Példányok | Listázási token összesen |", "|---|---|---|---:|"]
        for g in sorted(dups, key=lambda g: -sum(s.listing_tokens for s in g.skills)):
            kind = "azonos név" if g.kind == "same_name" else f"hasonló leírás ({g.similarity:.0%})"
            members = "<br>".join(f"`{s.qualified_name}` ({s.listing_tokens})" for s in g.skills)
            L.append(f"| {kind} | {_cell(g.key, 60)} | {members} | {sum(s.listing_tokens for s in g.skills)} |")
        L.append("")

    long_desc = sorted([s for s in active if s.listing_tokens > LONG_DESCRIPTION_TOKENS], key=lambda s: -s.listing_tokens)
    L += [f"## Túl hosszú leírások (> {LONG_DESCRIPTION_TOKENS} token): {len(long_desc)} db", "",
          f"Összesen {sum(s.listing_tokens for s in long_desc):,} token; a {LONG_DESCRIPTION_TOKENS} feletti rész "
          f"{sum(s.listing_tokens - LONG_DESCRIPTION_TOKENS for s in long_desc):,} token.", ""]
    if long_desc:
        L += ["| Skill | Token | Leírás eleje |", "|---|---:|---|"]
        L += [f"| `{s.qualified_name}` | {s.listing_tokens} | {_cell(s.description, 80)} |" for s in long_desc[:top]]
        if len(long_desc) > top:
            L.append(f"| … és még {len(long_desc) - top} | | |")
        L.append("")

    bad = [s for s in skills if s.errors and s.scope != "inactive"]
    L += ["## Hibás vagy hiányos frontmatter", ""]
    if bad:
        L += ["| Skill | Hatókör | Hiba | Útvonal |", "|---|---|---|---|"]
        for s in bad:
            L.append(f"| `{s.qualified_name}` | {_cell(_home(s.scope, home), 40)} | {', '.join(s.errors)} | {_cell(_home(s.path, home), 80)} |")
    else:
        L.append("Nincs.")
    L.append("")

    proj: dict[str, list[Skill]] = defaultdict(list)
    for s in skills:
        if s.scope.startswith("project:"):
            proj[s.scope[8:]].append(s)
    global_names = {s.name.lower() for s in active}
    if proj:
        L += ["## Projekt-szintű skillek (csak az adott projektben töltődnek)", "",
              "| Projekt | Skill | Listázási token | Ütközik globálissal |", "|---|---:|---:|---|"]
        for p, items in sorted(proj.items(), key=lambda kv: -sum(s.listing_tokens for s in kv[1])):
            clash = sorted({s.name for s in items if s.name.lower() in global_names})
            L.append(f"| {_cell(_home(p, home), 60)} | {len(items)} | {sum(s.listing_tokens for s in items):,} | "
                     f"{_cell(', '.join(clash), 90) or '-'} |")
        L.append("")

    inactive = [s for s in skills if s.scope == "inactive"]
    if inactive:
        by_reason: dict[str, int] = defaultdict(int)
        for s in inactive:
            by_reason[(s.inactive_reason or "?").split(":")[0]] += 1
        L += ["## Inaktív skillek (nem töltődnek, csak a lemezen vannak)", ""]
        L += [f"- {r}: {n} db" for r, n in sorted(by_reason.items(), key=lambda kv: -kv[1])]
        L.append("")

    L += ["## Javaslatok (megtakarítás szerint rendezve)", ""]
    if not recs:
        L.append("Nincs javaslat.")
    shorten = [r for r in recs if r["action"] == "shorten"]
    listed = [r for r in recs if r["action"] != "shorten"] + shorten[:15]
    listed.sort(key=lambda r: recs.index(r))
    for i, r in enumerate(listed, 1):
        save = f" — **~{r['saving_tokens']:,} token/session**" if r["saving_tokens"] else ""
        L.append(f"{i}. [{r['action']}] {r['text']}{save}")
    if len(shorten) > 15:
        rest = shorten[15:]
        L.append(f"{len(listed) + 1}. [shorten] További {len(rest)} hosszú leírás rövidíthető "
                 f"(együtt ~{sum(r['saving_tokens'] for r in rest):,} token/session); lista a JSON-ban.")
    L += ["", "_Az eszköz csak mér és javasol; semmilyen skillt vagy MCP-konfigot nem módosít._", ""]
    return "\n".join(L)
