# token-audit

Measures how many tokens Claude Code skills and MCP servers cost on this machine:

- **session start**: every active skill's `- name: description` listing line, plus every
  user-level MCP tool (full `name + description + inputSchema`, and the name-only cost
  when ToolSearch/deferred loading is on) and MCP server `instructions`;
- **on use**: the full `SKILL.md` of each skill.

It then flags duplicate skills, over-long descriptions, broken frontmatter and broken MCP
configs, and ranks concrete savings. It is read-only: nothing under `~/.claude` or any
`.mcp.json` is modified.

Lives in `tools/` rather than `scripts/` because it is a small Python package with its own
tests and optional dependencies, not a single-file operational script.

## Run

```bash
cd tools/token-audit
uv venv .venv && uv pip install -p .venv/bin/python -r requirements.txt   # once
ANTHROPIC_API_KEY=... .venv/bin/python -m token_audit --md out/audit.md --json out/audit.json
.venv/bin/python -m token_audit --no-mcp          # skills only, prints Markdown
.venv/bin/python -m pytest -q
```

Options: `--timeout 30` (per MCP server), `--project-root DIR` (repeatable, default `~/DEV`),
`--estimate` (never call the API), `--model`, `--top`, `--cache`.

## What it looks at

| Source | Counted at session start? |
|---|---|
| `~/.claude/skills/*/SKILL.md` | yes |
| `~/.claude/skills/<bundle>/skills/**` (superpowers, whispercode-marketing) | yes, unless the plugin is disabled |
| `~/.claude/skills/synced/**` (claude.ai `anthropic-skills:*`) | yes, one copy per qualified name |
| `~/.claude/plugins/cache/<market>/<plugin>/<version>/**` (no `temp_git_*`) | only the installed, user-scope, enabled version |
| `<project>/.claude/skills/**` under the project roots | reported per project |
| MCP: `~/.claude.json` (user + per-project local), `~/.claude/settings.json`, `.mcp.json` files, enabled plugins | user-level servers only |

A copy that points at the same file as another skill (symlink) or repeats a qualified name is
counted once, the same way Claude Code lists it.

## Token counting

With `ANTHROPIC_API_KEY` set: `messages.count_tokens` (default model `claude-opus-5`), with the
fixed per-message overhead subtracted. Without it: `tiktoken` `cl100k_base`, or chars/3.5 if
tiktoken is missing. The report says loudly when numbers are estimates. Results are cached by
`sha256(method, text)` in `~/.cache/token-audit/counts.json`, so repeated runs are cheap.

## MCP probing

Stdio servers are started with their configured command/env, sent `initialize` and
`tools/list` (paginated), then killed. Streamable-HTTP servers get the same over POST,
with configured headers and redirects followed. Any failure (timeout, crash, auth, TLS) marks
the server "nem mérhető" with a reason and the audit continues. Secrets in args, URLs and
stderr are redacted in the output.
