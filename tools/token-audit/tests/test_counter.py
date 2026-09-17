import json

from token_audit.counter import TokenCounter, char_estimate


def test_char_estimate():
    assert char_estimate("") == 0
    assert char_estimate("abcdefg") == 2  # 7 / 3.5
    assert char_estimate("a") == 1  # never rounds a non-empty text to zero


def test_fallback_when_no_key(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    c = TokenCounter(cache_path=tmp_path / "c.json", use_tiktoken=False)
    assert c.method == "estimate-chars"
    assert c.is_estimate
    assert c.count("x" * 35) == 10


def test_cache_hit_avoids_recount(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    path = tmp_path / "c.json"
    c = TokenCounter(cache_path=path, use_tiktoken=False)
    c.count("hello world")
    c.save()
    data = json.loads(path.read_text())
    assert len(data) == 1

    c2 = TokenCounter(cache_path=path, use_tiktoken=False)
    calls = []
    c2._count_uncached = lambda text: calls.append(text) or 999
    assert c2.count("hello world") == 3
    assert calls == []
    assert c2.count("new text") == 999


def test_cache_is_keyed_by_method(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    path = tmp_path / "c.json"
    path.write_text(json.dumps({TokenCounter.cache_key("api:claude-opus-5", "hello"): 777}))
    c = TokenCounter(cache_path=path, use_tiktoken=False)
    assert c.count("hello") != 777


def test_api_counter_subtracts_baseline(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    class FakeMessages:
        def count_tokens(self, model, messages):
            return type("R", (), {"input_tokens": 8 + len(messages[0]["content"])})()

    class FakeClient:
        messages = FakeMessages()

    c = TokenCounter(cache_path=tmp_path / "c.json", client_factory=lambda: FakeClient())
    assert c.method.startswith("api:")
    assert not c.is_estimate
    # baseline text "." -> 9 tokens -> overhead 8
    assert c.count("abcd") == 4


def test_api_failure_falls_back(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    def boom():
        raise RuntimeError("no network")

    c = TokenCounter(cache_path=tmp_path / "c.json", client_factory=boom, use_tiktoken=False)
    assert c.is_estimate
    assert "no network" in (c.fallback_reason or "")
