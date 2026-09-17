from token_audit.analysis import find_duplicates
from token_audit.model import Skill


def mk(qname, desc, path=None, source="user"):
    name = qname.split(":")[-1]
    return Skill(qualified_name=qname, name=name, description=desc,
                 path=path or f"/x/{qname}/SKILL.md", source=source, active=True)


def test_namespaced_same_name_is_duplicate():
    skills = [mk("kkv-ado", "Adójog"), mk("anthropic-skills:kkv-ado", "Adójog tanácsadó")]
    groups = find_duplicates(skills)
    assert len(groups) == 1
    assert groups[0].kind == "same_name"
    assert {s.qualified_name for s in groups[0].skills} == {"kkv-ado", "anthropic-skills:kkv-ado"}


def test_similar_description_different_name():
    d = "Use when you have a spec or requirements for a multi-step task, before touching code"
    skills = [mk("superpowers:writing-plans", d), mk("plan-writer", d + ".")]
    groups = find_duplicates(skills)
    assert len(groups) == 1
    assert groups[0].kind == "similar_description"


def test_unrelated_not_duplicate():
    skills = [mk("seo-audit", "Audit a website for SEO problems"),
              mk("kkv-ado", "Magyar adójogi tanácsadó KKV-knak")]
    assert find_duplicates(skills) == []


def test_same_file_via_symlink_counted_once():
    a = mk("skill-creator", "Create skills", path="/real/SKILL.md")
    b = mk("skill-creator", "Create skills", path="/real/SKILL.md")
    assert find_duplicates([a, b]) == []


def test_triple_same_name_single_group():
    skills = [mk("skill-creator", "a"), mk("anthropic-skills:skill-creator", "b"),
              mk("skill-factory:skill-creator", "c")]
    groups = find_duplicates(skills)
    assert len(groups) == 1 and len(groups[0].skills) == 3


def test_inactive_skills_ignored():
    a = mk("x", "same text here for both")
    b = mk("plugin:x", "same text here for both")
    b.active = False
    assert find_duplicates([a, b]) == []


def test_shadowing_counts_same_file_and_same_qualified_name_once():
    from token_audit.analysis import mark_shadowed
    user = mk("directory-submitter", "Submit", path="/p/ds/SKILL.md", source="user")
    plug = mk("wm:directory-submitter", "Submit", path="/p/ds/SKILL.md", source="user-plugin:wm")
    s1 = mk("anthropic-skills:docs", "Docs", path="/sync/a/docs/SKILL.md", source="synced")
    s2 = mk("anthropic-skills:docs", "Docs", path="/sync/b/docs/SKILL.md", source="synced")
    other = mk("kkv-ado", "Adó")
    mark_shadowed([plug, user, s1, s2, other])
    assert user.active and not plug.active
    assert "árnyékolt" in plug.inactive_reason
    assert s1.active and not s2.active
    assert other.active
