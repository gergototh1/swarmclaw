"""Find SKILL.md files and MCP server configs on this machine (read-only)."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from .frontmatter import parse_skill_md
from .model import Skill

SKIP_DIRS = {"node_modules", ".git", ".venv", "venv", "__pycache__", ".trash", "dist", ".next"}


@dataclass
class ClaudeHome:
    home: Path
    claude_dir: Path
    enabled_plugins: dict[str, bool] = field(default_factory=dict)
    installed: dict[str, list[dict]] = field(default_factory=dict)

    @classmethod
    def load(cls, home: Path) -> "ClaudeHome":
        cdir = home / ".claude"
        settings = _read_json(cdir / "settings.json") or {}
        inst = _read_json(cdir / "plugins" / "installed_plugins.json") or {}
        return cls(home, cdir, settings.get("enabledPlugins") or {}, inst.get("plugins") or {})

    def install_entries_for(self, path: Path) -> list[tuple[str, dict]]:
        rp = os.path.realpath(path)
        return [(key, e) for key, entries in self.installed.items() for e in entries
                if os.path.realpath(e.get("installPath", "")) == rp]


def _read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def _walk_skill_files(root: Path, max_depth: int) -> list[Path]:
    out: list[Path] = []
    if not root.is_dir():
        return out
    base_depth = len(root.parts)
    for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
        p = Path(dirpath)
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith("temp_git_")]
        if len(p.parts) - base_depth >= max_depth:
            dirnames[:] = []
        if "SKILL.md" in filenames:
            out.append(p / "SKILL.md")
    return sorted(out)


def _make_skill(path: Path, namespace: str | None, source: str, active: bool, scope: str,
                inactive_reason: str | None = None) -> Skill:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return Skill(f"{namespace + ':' if namespace else ''}{path.parent.name}", path.parent.name, None,
                     str(path), source, active, scope, [f"unreadable: {exc}"], 0, inactive_reason=inactive_reason)
    fm = parse_skill_md(text)
    name = fm.name or path.parent.name
    qualified = f"{namespace}:{name}" if namespace else name
    s = Skill(qualified, name, fm.description, os.path.realpath(path), source, active, scope,
              list(fm.errors), len(text), inactive_reason=inactive_reason)
    s._text = text  # type: ignore[attr-defined]  # not serialised; used for counting
    return s


def _plugin_state(ch: ClaudeHome, key: str) -> tuple[bool, str | None]:
    if ch.enabled_plugins.get(key) is True:
        return True, None
    if key in ch.enabled_plugins:
        return False, "plugin letiltva (enabledPlugins=false)"
    return False, "plugin nincs engedélyezve"


def discover_skills(ch: ClaudeHome, project_roots: list[Path]) -> list[Skill]:
    skills: list[Skill] = []
    sdir = ch.claude_dir / "skills"

    # 1) plain user skills and 2) plugin-like bundles living under ~/.claude/skills
    if sdir.is_dir():
        for entry in sorted(sdir.iterdir()):
            if entry.name.startswith(".") or entry.name == "synced" or not entry.is_dir():
                continue
            if (entry / "SKILL.md").is_file():
                skills.append(_make_skill(entry / "SKILL.md", None, "user", True, "user"))
            elif (entry / "skills").is_dir():
                keys = [k for k in ch.enabled_plugins if k.split("@")[0] == entry.name]
                active = True if not keys else any(ch.enabled_plugins[k] for k in keys)
                reason = None if active else "plugin letiltva"
                for f in _walk_skill_files(entry / "skills", 3):
                    skills.append(_make_skill(f, entry.name, f"user-plugin:{entry.name}", active,
                                              "user" if active else "inactive", reason))

    # 3) synced (claude.ai) skills
    for synced in (sdir / "synced", ch.claude_dir / "plugins" / "synced"):
        if not synced.is_dir():
            continue
        for bucket in sorted(p for p in synced.iterdir() if p.is_dir() and not p.name.startswith(".")):
            for child in sorted(p for p in bucket.iterdir() if p.is_dir()):
                if (child / "SKILL.md").is_file():
                    skills.append(_make_skill(child / "SKILL.md", "anthropic-skills", "synced", True, "user"))
                elif (child / "skills").is_dir():
                    pname = child.name.split("~")[0]
                    active, reason = _plugin_state(ch, f"{pname}@synced")
                    for f in _walk_skill_files(child / "skills", 3):
                        skills.append(_make_skill(f, pname, f"synced-plugin:{child.name}", active,
                                                  "user" if active else "inactive", reason))

    # 4) plugin cache: <market>/<plugin>/<version>/...
    cache = ch.claude_dir / "plugins" / "cache"
    if cache.is_dir():
        for market in sorted(p for p in cache.iterdir() if p.is_dir() and not p.name.startswith("temp_git_")):
            for plugin in sorted(p for p in market.iterdir() if p.is_dir()):
                for version in sorted(p for p in plugin.iterdir() if p.is_dir()):
                    files = _walk_skill_files(version, 6)
                    if not files:
                        continue
                    key = f"{plugin.name}@{market.name}"
                    entries = ch.install_entries_for(version)
                    user_entries = [e for _, e in entries if e.get("scope") == "user"]
                    proj_entries = [e for _, e in entries if e.get("scope") in ("project", "local")]
                    if user_entries:
                        active, reason = _plugin_state(ch, key)
                        scope = "user" if active else "inactive"
                    elif proj_entries:
                        active, reason = False, None
                        scope = "project:" + ",".join(sorted(e.get("projectPath", "?") for e in proj_entries))
                    else:
                        active, reason, scope = False, "régi / nem telepített plugin-verzió a cache-ben", "inactive"
                    for f in files:
                        skills.append(_make_skill(f, plugin.name, f"plugin:{key}@{version.name}",
                                                  active, scope, reason))

    # 5) project-level .claude/skills
    seen_proj: set[str] = set()
    for root in project_roots:
        for proj_skills in _find_project_skill_dirs(root):
            rp = os.path.realpath(proj_skills)
            if rp in seen_proj or rp == os.path.realpath(sdir):
                continue
            seen_proj.add(rp)
            proj = proj_skills.parent.parent
            for f in _walk_skill_files(proj_skills, 3):
                skills.append(_make_skill(f, None, f"project:{proj}", False, f"project:{proj}"))
    return skills


def _find_project_skill_dirs(root: Path, max_depth: int = 5) -> list[Path]:
    out = []
    if not root.is_dir():
        return out
    base = len(root.parts)
    for dirpath, dirnames, _ in os.walk(root):
        p = Path(dirpath)
        if p.name == ".claude":
            if (p / "skills").is_dir():
                out.append(p / "skills")
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and d != "worktrees"
                       and (not d.startswith(".") or d == ".claude")]
        if len(p.parts) - base >= max_depth:
            dirnames[:] = [d for d in dirnames if d == ".claude"]
    return sorted(out)


# ---------------------------------------------------------------- MCP configs

def _servers_from(obj, bare_ok: bool = False) -> dict:
    if not isinstance(obj, dict):
        return {}
    if isinstance(obj.get("mcpServers"), dict):
        return obj["mcpServers"]
    if not bare_ok:
        return {}
    # plugin-style .mcp.json may be the bare mapping
    return {k: v for k, v in obj.items() if isinstance(v, dict) and ("command" in v or "url" in v)}


def discover_mcp_configs(ch: ClaudeHome, project_roots: list[Path]) -> list[dict]:
    """Return raw entries: {name, config, scope, cwd, plugin_root}."""
    found: list[dict] = []
    home = ch.home
    cj = _read_json(home / ".claude.json") or {}
    for name, cfg in _servers_from(cj).items():
        found.append({"name": name, "config": cfg, "scope": "user", "cwd": str(home)})
    for ppath, pdata in (cj.get("projects") or {}).items():
        for name, cfg in _servers_from(pdata or {}).items():
            found.append({"name": name, "config": cfg, "scope": f"local:{ppath}", "cwd": ppath})
    settings = _read_json(ch.claude_dir / "settings.json") or {}
    for name, cfg in _servers_from(settings).items():
        found.append({"name": name, "config": cfg, "scope": "user", "cwd": str(home)})

    for root in project_roots:
        for mcp_file in _find_files(root, ".mcp.json", 4):
            for name, cfg in _servers_from(_read_json(mcp_file)).items():
                found.append({"name": name, "config": cfg, "scope": f"project:{mcp_file.parent}",
                              "cwd": str(mcp_file.parent)})

    # enabled user-scope plugins
    for key, entries in ch.installed.items():
        for e in entries:
            if e.get("scope") != "user" or ch.enabled_plugins.get(key) is not True:
                continue
            root = Path(e.get("installPath", ""))
            servers = dict(_servers_from(_read_json(root / ".mcp.json"), bare_ok=True))
            pj = _read_json(root / ".claude-plugin" / "plugin.json") or {}
            ms = pj.get("mcpServers")
            if isinstance(ms, str):
                servers.update(_servers_from(_read_json(root / ms), bare_ok=True))
            elif isinstance(ms, dict):
                servers.update(_servers_from({"mcpServers": ms}))
            for name, cfg in servers.items():
                found.append({"name": f"plugin:{key.split('@')[0]}:{name}", "config": cfg,
                              "scope": "user", "cwd": str(root), "plugin_root": str(root)})
    return found


def _find_files(root: Path, filename: str, max_depth: int) -> list[Path]:
    out = []
    if not root.is_dir():
        return out
    base = len(root.parts)
    for dirpath, dirnames, filenames in os.walk(root):
        p = Path(dirpath)
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".") and d != "worktrees"]
        if len(p.parts) - base >= max_depth:
            dirnames[:] = []
        if filename in filenames:
            out.append(p / filename)
    return sorted(out)
