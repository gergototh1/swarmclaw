"""Plain data records shared by discovery, measurement and reporting."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class Skill:
    qualified_name: str
    name: str
    description: str | None
    path: str
    source: str  # user | user-plugin:<ns> | plugin:<key> | project:<dir> | synced
    active: bool  # loaded into a global (user-level) session listing
    scope: str = "user"  # user | project:<path> | inactive
    errors: list[str] = field(default_factory=list)
    body_chars: int = 0
    listing_tokens: int = 0  # "- name: description" line, paid every session
    body_tokens: int = 0  # full SKILL.md, paid when the skill is invoked
    inactive_reason: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class McpTool:
    name: str
    description_tokens: int = 0
    schema_tokens: int = 0
    total_tokens: int = 0
    name_only_tokens: int = 0


@dataclass
class McpServer:
    name: str
    transport: str  # stdio | http | sse
    scopes: list[str]
    target: str  # redacted command or url, never secrets
    status: str = "pending"  # ok | unmeasurable | skipped
    reason: str | None = None
    tools: list[McpTool] = field(default_factory=list)
    instructions_tokens: int = 0
    elapsed_s: float = 0.0

    @property
    def total_tokens(self) -> int:
        return sum(t.total_tokens for t in self.tools) + self.instructions_tokens

    @property
    def name_only_tokens(self) -> int:
        return sum(t.name_only_tokens for t in self.tools)

    @property
    def user_level(self) -> bool:
        return "user" in self.scopes

    def to_dict(self) -> dict:
        d = asdict(self)
        d["total_tokens"] = self.total_tokens
        d["name_only_tokens"] = self.name_only_tokens
        return d


@dataclass
class DuplicateGroup:
    kind: str  # same_name | similar_description
    key: str
    skills: list[Skill]
    similarity: float = 1.0
