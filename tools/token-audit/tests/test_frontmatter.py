from token_audit.frontmatter import parse_skill_md


def test_simple_frontmatter():
    fm = parse_skill_md("---\nname: foo\ndescription: Does foo things.\n---\n# Body\ntext\n")
    assert fm.name == "foo"
    assert fm.description == "Does foo things."
    assert fm.body.startswith("# Body")
    assert fm.errors == []


def test_quoted_description_with_colon():
    fm = parse_skill_md('---\nname: kkv-ado\ndescription: "KKV: ÁFA, TAO"\nmcp_tools:\n  - a\n  - b\n---\nx')
    assert fm.name == "kkv-ado"
    assert fm.description == "KKV: ÁFA, TAO"


def test_single_quoted_with_escaped_quote():
    fm = parse_skill_md("---\nname: x\ndescription: 'it''s fine'\n---\n")
    assert fm.description == "it's fine"


def test_folded_block_scalar():
    text = "---\nname: bar\ndescription: >\n  line one\n  line two\nother: 1\n---\nbody"
    fm = parse_skill_md(text)
    assert fm.description == "line one line two"


def test_literal_block_scalar():
    text = "---\nname: bar\ndescription: |\n  line one\n  line two\n---\nbody"
    fm = parse_skill_md(text)
    assert fm.description == "line one\nline two"


def test_plain_multiline_continuation():
    text = "---\nname: bar\ndescription: first part\n  continues here\n---\n"
    fm = parse_skill_md(text)
    assert fm.description == "first part continues here"


def test_missing_frontmatter():
    fm = parse_skill_md("# Just a heading\n")
    assert fm.name is None
    assert "missing_frontmatter" in fm.errors
    assert fm.body == "# Just a heading\n"


def test_unterminated_frontmatter():
    fm = parse_skill_md("---\nname: x\ndescription: y\n")
    assert "unterminated_frontmatter" in fm.errors


def test_empty_description_flagged():
    fm = parse_skill_md("---\nname: x\ndescription:\n---\n")
    assert fm.description in (None, "")
    assert "missing_description" in fm.errors


def test_missing_name_flagged():
    fm = parse_skill_md("---\ndescription: y\n---\n")
    assert "missing_name" in fm.errors


def test_bom_and_crlf():
    fm = parse_skill_md("﻿---\r\nname: x\r\ndescription: y\r\n---\r\nbody")
    assert fm.name == "x" and fm.description == "y"
