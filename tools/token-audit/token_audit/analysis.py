"""Duplicate detection and recommendation building."""
from __future__ import annotations

import re
from difflib import SequenceMatcher

from .model import DuplicateGroup, McpServer, Skill

SIMILARITY_THRESHOLD = 0.85
LONG_DESCRIPTION_TOKENS = 60


def base_name(qualified: str) -> str:
    return qualified.split(":")[-1].strip().lower()


def _norm_desc(desc: str | None) -> str:
    return re.sub(r"[^\w]+", " ", (desc or "").lower()).strip()


def _unique_by_path(skills: list[Skill]) -> list[Skill]:
    seen: set[tuple[str, str]] = set()
    out = []
    for s in skills:
        key = (s.path, s.qualified_name)
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


def mark_shadowed(skills: list[Skill]) -> None:
    """Claude Code lists one entry per file and per qualified name; drop the extra copies.

    A plain user skill wins over a plugin copy of the same file.
    """
    pref = {"user": 0, "synced": 1}
    seen_path: dict[str, Skill] = {}
    seen_name: dict[str, Skill] = {}
    for s in sorted([s for s in skills if s.active], key=lambda s: (pref.get(s.source, 2), s.path)):
        winner = seen_path.get(s.path) or seen_name.get(s.qualified_name)
        if winner is not None:
            s.active = False
            s.scope = "inactive"
            why = "ugyanaz a fájl" if winner.path == s.path else "ugyanaz a minősített név, másik példány"
            s.inactive_reason = f"árnyékolt ({why}): `{winner.qualified_name}` listázódik helyette"
            continue
        seen_path[s.path] = s
        seen_name[s.qualified_name] = s


def find_duplicates(skills: list[Skill], threshold: float = SIMILARITY_THRESHOLD) -> list[DuplicateGroup]:
    pool = _unique_by_path([s for s in skills if s.active])
    groups: list[DuplicateGroup] = []
    by_name: dict[str, list[Skill]] = {}
    for s in pool:
        by_name.setdefault(base_name(s.qualified_name), []).append(s)
    grouped: set[int] = set()
    for key, members in sorted(by_name.items()):
        if len({m.path for m in members}) > 1:
            groups.append(DuplicateGroup("same_name", key, members))
            grouped.update(id(m) for m in members)

    # similar descriptions under different names (union-find over pairs)
    cands = [s for s in pool if id(s) not in grouped and len(_norm_desc(s.description)) >= 20]
    norms = [_norm_desc(s.description) for s in cands]
    parent = list(range(len(cands)))
    best: dict[int, float] = {}

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(cands)):
        for j in range(i + 1, len(cands)):
            a, b = norms[i], norms[j]
            if min(len(a), len(b)) / max(len(a), len(b)) < threshold:
                continue
            sm = SequenceMatcher(None, a, b, autojunk=False)
            if sm.real_quick_ratio() < threshold or sm.quick_ratio() < threshold:
                continue
            r = sm.ratio()
            if r >= threshold:
                ri, rj = find(i), find(j)
                parent[rj] = ri
                best[ri] = min(best.get(ri, 1.0), best.get(rj, 1.0), r)
    clusters: dict[int, list[Skill]] = {}
    for i, s in enumerate(cands):
        clusters.setdefault(find(i), []).append(s)
    for root, members in clusters.items():
        if len(members) > 1:
            key = " / ".join(sorted(m.qualified_name for m in members))
            groups.append(DuplicateGroup("similar_description", key, members, round(best.get(root, 1.0), 3)))
    return groups


def _keep_choice(members: list[Skill]) -> Skill:
    """Prefer the copy the user maintains (plain user skill), then the shortest listing."""
    rank = {"user": 0}
    return sorted(members, key=lambda s: (rank.get(s.source, 1), s.listing_tokens, s.qualified_name))[0]


def build_recommendations(skills: list[Skill], servers: list[McpServer],
                          dups: list[DuplicateGroup]) -> list[dict]:
    recs: list[dict] = []
    for g in dups:
        keep = _keep_choice(g.skills)
        drop = [s for s in g.skills if s is not keep]
        saving = sum(s.listing_tokens for s in drop)
        verb = "Duplikált név" if g.kind == "same_name" else f"Szinte azonos leírás ({g.similarity:.0%})"
        hint = ""
        if any(s.source == "synced" for s in drop):
            hint = " A `anthropic-skills:*` példányok a claude.ai-ról szinkronizálódnak: ott kapcsold ki őket (Settings → Capabilities → Skills)."
        recs.append({
            "action": "merge" if g.kind == "similar_description" else "delete",
            "saving_tokens": saving,
            "target": ", ".join(s.qualified_name for s in drop),
            "text": (f"{verb}: `{g.key}`. Tartsd meg: `{keep.qualified_name}`; "
                     f"töröld vagy tiltsd le: {', '.join('`' + s.qualified_name + '`' for s in drop)}.{hint}"),
        })
    for s in skills:
        if s.active and s.listing_tokens > LONG_DESCRIPTION_TOKENS:
            saving = s.listing_tokens - 40
            recs.append({
                "action": "shorten", "saving_tokens": saving, "target": s.qualified_name,
                "text": (f"Rövidítsd a leírást: `{s.qualified_name}` ({s.listing_tokens} token); "
                         f"~40 tokenre vágva ~{saving} token/session megtakarítás. "
                         "A trigger-szavak maradjanak, a magyarázat menjen a törzsbe."),
            })
        if s.errors and s.active:
            recs.append({
                "action": "fix", "saving_tokens": 0, "target": s.qualified_name,
                "text": f"Javítsd a frontmattert: `{s.qualified_name}` ({', '.join(s.errors)}) — {s.path}",
            })
    for srv in servers:
        if srv.status == "ok" and srv.total_tokens > 3000:
            heavy = max(srv.tools, key=lambda t: t.total_tokens, default=None)
            where = ("user-szinten minden sessionben ott van; ha csak egy projektben kell, tedd át a projekt "
                     ".mcp.json-jába" if srv.user_level else
                     "projekt-szintű; ha ritkán kell, tiltsd le alapból és kapcsold be /mcp-vel, amikor dolgozol vele")
            recs.append({
                "action": "scope", "saving_tokens": srv.total_tokens, "target": srv.name,
                "text": (f"`{srv.name}` MCP: {len(srv.tools)} eszköz, {srv.total_tokens:,} token teljes sémával "
                         f"(legnagyobb: `{heavy.name}`, {heavy.total_tokens:,}); {where}. "
                         "Deferred (ToolSearch) módban ebből csak a nevek és az instructions töltődnek; "
                         "a megtakarítás a teljes sémás (eager) betöltésre vonatkozik."),
            })
        elif srv.status != "ok":
            recs.append({
                "action": "fix-mcp", "saving_tokens": 0, "target": srv.name,
                "text": f"`{srv.name}` MCP nem indul ({srv.reason}). Javítsd vagy töröld a konfigból: {', '.join(srv.scopes)}",
            })
    order = {"delete": 0, "merge": 1, "scope": 2, "shorten": 3, "fix": 4, "fix-mcp": 5}
    recs.sort(key=lambda r: (-r["saving_tokens"], order[r["action"]]))
    return recs
