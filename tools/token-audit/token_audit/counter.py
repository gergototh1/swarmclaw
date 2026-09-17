"""Token counting: Anthropic count_tokens API with a cached, labelled fallback."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
from typing import Callable

DEFAULT_MODEL = "claude-opus-5"
CHARS_PER_TOKEN = 3.5
BASELINE_TEXT = "."


def char_estimate(text: str) -> int:
    if not text:
        return 0
    return max(1, math.floor(len(text) / CHARS_PER_TOKEN))


class TokenCounter:
    def __init__(self, cache_path: Path | None = None, model: str = DEFAULT_MODEL,
                 client_factory: Callable[[], object] | None = None,
                 use_tiktoken: bool = True, force_estimate: bool = False):
        self.model = model
        self.cache_path = Path(cache_path) if cache_path else None
        self._cache: dict[str, int] = {}
        self._dirty = False
        self.fallback_reason: str | None = None
        self.api_calls = 0
        self._client = None
        self._baseline = 0
        self._enc = None
        if self.cache_path and self.cache_path.exists():
            try:
                self._cache = json.loads(self.cache_path.read_text())
            except (OSError, ValueError):
                self._cache = {}

        self.method = ""
        if force_estimate:
            self.fallback_reason = "--estimate flag"
        elif not os.environ.get("ANTHROPIC_API_KEY"):
            self.fallback_reason = "ANTHROPIC_API_KEY is not set"
        else:
            try:
                if client_factory is None:
                    import anthropic  # noqa: PLC0415

                    client_factory = anthropic.Anthropic
                self._client = client_factory()
                self.method = f"api:{model}"
                self._baseline = self._api_count(BASELINE_TEXT) - 1
            except Exception as exc:  # noqa: BLE001 - any failure means fallback
                self._client = None
                self.fallback_reason = f"count_tokens API unavailable: {exc}"
        if not self._client:
            self.method = "estimate-chars"
            if use_tiktoken:
                try:
                    import tiktoken  # noqa: PLC0415

                    self._enc = tiktoken.get_encoding("cl100k_base")
                    self.method = "estimate-tiktoken-cl100k"
                except Exception:  # noqa: BLE001
                    self._enc = None

    @property
    def is_estimate(self) -> bool:
        return self._client is None

    @staticmethod
    def cache_key(method: str, text: str) -> str:
        return hashlib.sha256(f"{method}\0{text}".encode()).hexdigest()

    def _api_count(self, text: str) -> int:
        self.api_calls += 1
        resp = self._client.messages.count_tokens(
            model=self.model, messages=[{"role": "user", "content": text}])
        return int(resp.input_tokens)

    def _count_uncached(self, text: str) -> int:
        if self._client is not None:
            return max(0, self._api_count(text) - self._baseline)
        if self._enc is not None:
            return len(self._enc.encode(text, disallowed_special=()))
        return char_estimate(text)

    def count(self, text: str) -> int:
        if not text:
            return 0
        key = self.cache_key(self.method, text)
        if key in self._cache:
            return self._cache[key]
        n = self._count_uncached(text)
        self._cache[key] = n
        self._dirty = True
        return n

    def save(self) -> None:
        if not (self.cache_path and self._dirty):
            return
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.cache_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._cache))
        tmp.replace(self.cache_path)
        self._dirty = False
