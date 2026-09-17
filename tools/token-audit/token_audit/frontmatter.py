"""Tolerant SKILL.md frontmatter parser.

Only top-level scalar keys matter here (name, description), so this avoids a
YAML dependency and, more importantly, never raises on the malformed
frontmatter that real skill folders contain.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

_KEY_RE = re.compile(r"^([A-Za-z0-9_-]+)\s*:(.*)$")


@dataclass
class Frontmatter:
    name: str | None
    description: str | None
    body: str
    raw: str
    fields: dict[str, str] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)


def _unquote(value: str) -> str:
    v = value.strip()
    if len(v) >= 2 and v[0] == v[-1] == '"':
        inner = v[1:-1]
        return (inner.replace('\\"', '"').replace("\\n", "\n")
                .replace("\\t", "\t").replace("\\\\", "\\"))
    if len(v) >= 2 and v[0] == v[-1] == "'":
        return v[1:-1].replace("''", "'")
    return v


def _parse_block(lines: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    i = 0
    while i < len(lines):
        line = lines[i]
        m = _KEY_RE.match(line)
        if not m or line[:1] in (" ", "\t"):
            i += 1
            continue
        key, rest = m.group(1), m.group(2).strip()
        # gather indented / continuation lines belonging to this key
        j = i + 1
        cont: list[str] = []
        while j < len(lines) and (lines[j][:1] in (" ", "\t") or lines[j].strip() == ""):
            cont.append(lines[j])
            j += 1
        while cont and cont[-1].strip() == "":
            cont.pop()
        if rest[:1] in (">", "|"):
            stripped = [c.strip() for c in cont]
            if rest[0] == ">":
                value = " ".join(s for s in stripped if s)
            else:
                value = "\n".join(stripped)
        elif cont and all(c.strip().startswith("- ") or c.strip() == "" for c in cont) and rest == "":
            value = ""  # a list; not a scalar we care about
        else:
            parts = [rest] + [c.strip() for c in cont if c.strip()]
            joined = " ".join(p for p in parts if p)
            value = _unquote(joined)
        out[key] = value
        i = j
    return out


def parse_skill_md(text: str) -> Frontmatter:
    text = text.lstrip("﻿").replace("\r\n", "\n")
    errors: list[str] = []
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return Frontmatter(None, None, text, "", {}, ["missing_frontmatter"])
    end = None
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            end = idx
            break
    if end is None:
        fm_lines = lines[1:]
        body = ""
        errors.append("unterminated_frontmatter")
    else:
        fm_lines = lines[1:end]
        body = "\n".join(lines[end + 1:])
    fields = _parse_block(fm_lines)
    name = fields.get("name") or None
    desc = fields.get("description")
    if not name:
        errors.append("missing_name")
    if not desc:
        errors.append("missing_description")
    return Frontmatter(name, desc, body, "\n".join(fm_lines), fields, errors)
