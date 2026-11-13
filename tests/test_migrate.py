"""cv-tools migrate: mapping, comments, warnings and errors."""

import io
import json
import os
import re
import warnings
from contextlib import redirect_stderr

import jsonschema
import pytest
import yaml
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from cv_tools import api
from cv_tools.loader import CVError, load_text
from cv_tools import migrate as migrate_module
from cv_tools.migrate import HEADER, MigrationError, migrate_text
from cv_tools.v1 import detect
from cv_tools.validate import schema, validate

from helpers import FIXTURES, ROOT, normalize_tex


def migrate(text):
    return migrate_text(text, "old.yaml")


def test_header_and_round_trip():
    out = migrate(ROOT.joinpath("examples", "v1", "cv.yaml").read_text(encoding="utf-8"))
    assert out.text.startswith(HEADER)
    assert out.warnings == []
    assert load_text(out.text).data["version"] == 2


def test_comments_are_carried_over():
    v1_text = """\
# My CV
# second line
heading:
  name: "Jane Roe"  # shown at the top

subheading:  # contact lines
  - type: links
    content:
      - name: "jane@roe.dev"  # email
        show_below: true

sections:
  # Experience first
  - type: experience
    content:
      - name: "Work"  # group title
        entity:
          - organization: "Org"  # employer
            dates: "2020"
            position: "Engineer"
            responsibilities:  # what I did
              - "Things"
  - type: talks  # talks
    title: "Talks"
    content:
      - name: "A talk"
        month: "Nov."  # month and year become one date
        year: "2023"
"""
    out = migrate(v1_text).text
    for comment in [
        "# My CV", "# second line", "# shown at the top", "# contact lines", "# Experience first",
        "# group title", "# employer", "# what I did", "# talks", "# month and year become one date",
    ]:
        assert out.count(comment) == 1, comment
    assert re.search(r"^name: Jane Roe +# shown at the top$", out, re.M)
    assert re.search(r"^      - title: Org +# employer$", out, re.M)
    assert re.search(r"^    layout: dated +# talks$", out, re.M)
    assert re.search(r"^      - date: Nov. 2023 +# month and year become one date$", out, re.M)
    # A comment on a contact item has no place in the v2 line and is dropped.
    assert "# email" not in out
    assert load_text(out).data["sections"][0]["entries"][0]["bullets"] == ["Things"]


def test_clean_text_and_raw_latex():
    out = migrate((FIXTURES / "v1" / "special-characters" / "cv.yaml").read_text(encoding="utf-8")).text
    data = load_text(out).data
    edu = data["sections"][0]["entries"][0]
    assert data["name"] == {"latex": "Jos\\'e Mar\\'ia"}
    assert edu["note"] == "Top 5%"  # \% became a plain %
    assert edu["details"] == ["Thesis Title: *Costs in $ and # of samples*", {"latex": "Supervisor: Dr. \\textsc{Smith}"}]
    bullets = data["sections"][1]["entries"][0]["bullets"]
    assert bullets[1] == "Used snake_case and C# daily"
    assert bullets[0] == {"latex": "Cut costs by 30\\% and latency by 2$\\times$"}


def test_scalars_keep_their_type():
    data = load_text(migrate((FIXTURES / "v1" / "scalar-types" / "cv.yaml").read_text(encoding="utf-8")).text).data
    edu = data["sections"][0]["entries"][0]
    assert edu["title"] == 42
    assert edu["location"] == 3.5
    assert edu["subtitle"] == "True"  # v1 printed YAML's yes as True
    assert data["sections"][3]["entries"][0]["date"] == "12 2023"


def test_explicit_highlight_only_when_the_default_differs():
    base = 'heading:\n  name: "{}"\nsections:\n  - type: publications\n    title: P\n    bibfile: x.bib\n'
    plain = load_text(migrate(base.format("Jane Roe")).text).data["sections"][0]
    assert "highlight" not in plain
    escaped = load_text(migrate(base.format("Jane \\\\& Roe")).text).data
    assert escaped["name"] == "Jane & Roe"
    assert escaped["sections"][0]["highlight"] == ["Jane \\& Roe"]


def test_dropped_data_is_reported():
    path = FIXTURES / "v1" / "ignored-data" / "cv.yaml"
    out = migrate_text(path.read_text(encoding="utf-8"), "cv.yaml")
    assert out.warnings == [
        "cv.yaml:5:3: warning: v1 ignores the field 'email'; it is dropped",
        "cv.yaml:6:1: warning: v1 ignores the field 'summary'; it is dropped",
        "cv.yaml:12:9: warning: v1 does not print subheading items without show_below: true or false; the item is dropped",
        "cv.yaml:13:9: warning: v1 does not print subheading items without show_below: true or false; the item is dropped",
        "cv.yaml:20:9: warning: v1 ignores the field 'extra'; it is dropped",
        "cv.yaml:23:5: warning: v1 ignores the field 'title'; it is dropped",
        "cv.yaml:29:9: warning: v1 ignores the field 'gpa'; it is dropped",
        "cv.yaml:30:5: warning: v1 does not print sections of type 'unknown-section'; the section is dropped",
    ]


def test_contact_lines_keep_v1_spacing():
    data = load_text(migrate((FIXTURES / "v1" / "socials-all" / "cv.yaml").read_text(encoding="utf-8")).text).data
    line1, line2 = data["contact"]
    # v1 joined a line with spaces; a second text item needs the explicit separator.
    assert line1["separator"] == " "
    assert [list(i)[0] if isinstance(i, dict) else "text" for i in line1["items"]] == ["github", "url", "text", "orcid"]
    # Spaces between items and the separator only before the date: every item
    # stays structured, and "| " prints the same as v1's separator.
    assert line2 == {
        "items": [
            {"twitter": "https://twitter.com/janeroe"},
            "+1 555 0100",
            {"url": "https://example.org/~jane"},
            {"linkedin": "https://www.linkedin.com/in/jane-roe"},
            "| Curriculum Vitae, {date}",
        ],
        "separator": " ",
    }

    data = load_text(migrate((FIXTURES / "v1" / "above-only" / "cv.yaml").read_text(encoding="utf-8")).text).data
    assert data["contact"][1] == [" Curriculum Vitae, {date}"]  # v1 started this line with a space

    data = load_text(migrate((FIXTURES / "v1" / "below-only" / "cv.yaml").read_text(encoding="utf-8")).text).data
    assert data["contact"][0] == []


def test_duplicate_keys_are_reported():
    with pytest.raises(CVError, match=r"duplicate key 'year' \(first defined on line 129\)") as info:
        migrate_text((FIXTURES / "invalid" / "duplicate-key-v1.yaml").read_text(encoding="utf-8"), "cv.yaml")
    assert info.value.line == 130


def test_v2_input_is_rejected():
    with pytest.raises(CVError, match="already uses the v2 format"):
        migrate((ROOT / "examples" / "cv.yaml").read_text(encoding="utf-8"))


def test_api_migrate_text_warns():
    text = (FIXTURES / "v1" / "ignored-data" / "cv.yaml").read_text(encoding="utf-8")
    with pytest.warns(UserWarning) as record:
        out = api.migrate_text(text)
    assert out.startswith(HEADER)
    assert len(record) == 8
    assert "v1 ignores the field 'email'" in str(record[0].message)


@pytest.mark.parametrize(
    "fixture, path, value",
    [
        ("yaml11-bools", ("sections", 0, "entries"), ["yes", "No", "on", "OFF", "y", "n"]),
        ("yaml11-sexagesimal", ("sections", 0, "entries"), ["10:30", "1:20:30", "-1:30"]),
        ("uk-honours-2-1", ("sections", 0, "entries", 0, "note"), "2:1"),
        ("skills-yes", ("sections", 0, "entries"), [
            {"title": "Driving licence", "text": "yes"}, {"title": "on", "text": "1:30"},
        ]),
    ],
)
def test_strings_stay_strings_under_both_yaml_versions(fixture, path, value):
    out = migrate((FIXTURES / "v1" / fixture / "cv.yaml").read_text(encoding="utf-8")).text
    for version in ("1.1", "1.2"):
        data = load_text(out, yaml_version=version).data
        for part in path:
            data = data[part]
        assert data == value, version
    if fixture == "uk-honours-2-1":
        assert '      note: "2:1"\n' in out


def test_migration_checks_its_own_output(monkeypatch):
    # A dump that changes the data is reported as an internal error, not written.
    real = migrate_module._dump
    monkeypatch.setattr(migrate_module, "_dump", lambda doc: real(doc).replace("name: Jane Roe", "name: yes\nx: 1"))
    with pytest.raises(MigrationError, match=r"internal error: the migrated file does not read back"):
        migrate('heading:\n  name: "Jane Roe"\nsections: []\n')


def test_self_check_compares_types():
    assert migrate_module._difference({"a": [1, "x"]}, {"a": [1, "x"]}, ()) is None
    assert migrate_module._difference({"a": True}, {"a": 1}, ()) == "['a']: expected 1, got True"
    assert migrate_module._difference(float("nan"), float("nan"), ()) is None
    assert "expected keys" in migrate_module._difference({"b": 1}, {"a": 1}, ())


# -- generated v1 documents

FUZZ = os.environ.get("CV_TOOLS_FUZZ", "") not in ("", "0")
BIB = str((FIXTURES / "v2" / "publications.bib").resolve())
v1_chars = list("*[]()'\n \t#$%&_{}~^<>|?!-.:/ab1Z\"") + ["**", "\\%", "\\&", "\\textbf{x}", "yes", "on", "2:1",
                                                          "10:30", "017", "1e3", "null", "~", "  ", "    ", "{date}"]
v1_text = st.lists(st.sampled_from(v1_chars), max_size=6).map("".join)
scalar = st.one_of(v1_text, v1_text, st.integers(-5, 3000), st.floats(allow_nan=False, allow_infinity=False, width=16),
                   st.booleans(), st.none())


def optional(d):
    return st.fixed_dictionaries({}, optional=d)


link = optional({"name": scalar, "highlight": st.booleans(), "show_below": st.booleans()})
social = optional({
    "type": st.sampled_from(["orcid_id", "linkedin", "github", "twitter"]),
    "url": st.one_of(st.sampled_from(["https://x.org/a_b", "0000-0002-1825-0097", "https://x.org/~u#f"]), v1_text),
    "show_below": st.booleans(),
})
texts_list = st.lists(st.one_of(scalar, st.none()), max_size=3)
sections = st.one_of(
    st.fixed_dictionaries({"type": st.just("education"), "content": st.lists(optional({
        "university": scalar, "location": scalar, "dates": scalar, "degree": scalar, "honors": scalar,
        "thesis_title": scalar, "supervisor": scalar, "bullets": texts_list}), max_size=2)}),
    st.fixed_dictionaries({"type": st.just("experience"), "content": st.lists(optional({
        "name": scalar, "entity": st.lists(optional({
            "organization": scalar, "dates": scalar, "position": scalar, "supervisor": scalar,
            "department": scalar, "location": scalar, "responsibilities": texts_list}), max_size=2)}), max_size=2)}),
    st.fixed_dictionaries({"type": st.just("bullets"), "title": scalar}, optional={
        "description": scalar,
        "content": st.lists(optional({"item": scalar, "subitems": texts_list}), min_size=1, max_size=3)}),
    st.fixed_dictionaries({"type": st.just("skills"), "content": st.lists(optional({"name": scalar, "data": scalar}),
                                                                         max_size=2)}),
    st.fixed_dictionaries({"type": st.just("talks"), "title": scalar, "content": st.lists(optional({
        "name": scalar, "month": scalar, "year": scalar}), max_size=2)}),
    st.fixed_dictionaries({"type": st.just("publications"), "title": scalar, "bibfile": st.just(BIB)}),
    st.just({"type": "newpage"}),
)
v1_documents = st.fixed_dictionaries(
    {"heading": st.fixed_dictionaries({"name": scalar}), "sections": st.lists(sections, max_size=4)},
    optional={"subheading": st.lists(st.one_of(
        st.fixed_dictionaries({"type": st.just("links"), "content": st.lists(link, max_size=3)}),
        st.fixed_dictionaries({"type": st.just("socials"), "content": st.lists(social, max_size=3)}),
    ), max_size=2)},
)


@settings(max_examples=1000 if FUZZ else 60, deadline=None, suppress_health_check=[HealthCheck.too_slow, HealthCheck.data_too_large])
@given(v1_documents)
def test_migrated_files_are_valid_and_render_like_v1(v1_doc):
    text = yaml.safe_dump(v1_doc, sort_keys=False, allow_unicode=True)
    out = migrate_text(text, "gen.yaml").text  # also runs the internal reload check
    src = load_text(out, "<migrated>")
    assert src.yaml_version == "1.2"
    assert validate(src) == [], out
    v1_tex = api.render_tex(api.loads(text, "gen.yaml")).tex
    v2_tex = api.render_tex(api.loads(out, "<migrated>")).tex
    assert normalize_tex(v2_tex) == normalize_tex(v1_tex)
    # The in-memory conversion is valid v2 data too.
    from cv_tools import v1

    assert list(jsonschema.Draft202012Validator(schema()).iter_errors(v1.convert(load_text(text)).data)) == []


@pytest.mark.parametrize("name", ["nel\x85x", "a b", "a\rb", "a\x0bb", "a\x01b", "a﻿b", "a\tb\nc\x85d"])
def test_control_characters_survive_migration(name):
    # YAML reads U+0085 and U+2028 in a plain or single-quoted scalar as a line break.
    v1_text = yaml.safe_dump({"heading": {"name": "J"}, "sections": [
        {"type": "bullets", "title": "T", "content": [{"item": name}]}]})
    out = migrate(v1_text).text  # raises MigrationError if the text does not read back
    entry = load_text(out, yaml_version="1.2").data["sections"][0]["entries"][0]
    special = name.replace("\t", "").replace("\n", "")[1:-1].strip("abcd")
    assert special in (entry["latex"] if isinstance(entry, dict) else entry)


@pytest.mark.parametrize("where", ["name", "item", "contact", "date"])
def test_very_long_scalars_migrate(where):
    # ruamel.yaml folded long scalars, and a folded line that looked like "  - title:" got a blank line.
    long = "a " * 2045 + "b " + "- title: y z" + " w" * 10 + "  - newpage " + "c" * 5000
    doc = {"heading": {"name": "J"}, "sections": [{"type": "newpage"}]}
    if where == "name":
        doc["heading"]["name"] = long
    elif where == "item":
        doc["sections"] = [{"type": "bullets", "title": "T", "content": [{"item": long}]}, {"type": "newpage"}]
    elif where == "contact":
        doc["subheading"] = [{"type": "links", "content": [{"name": long, "show_below": True},
                                                            {"name": "b", "show_below": False}]}]
    else:
        doc["sections"] = [{"type": "talks", "title": "T", "content": [{"name": "x", "month": long, "year": 2020}]}]
    out = migrate(yaml.safe_dump(doc, width=10**6)).text  # raises MigrationError on a difference
    # Every scalar stays on one line.
    assert any(long in line for line in out.splitlines())


def test_migrated_layout():
    out = migrate((ROOT / "examples" / "v1" / "cv.yaml").read_text(encoding="utf-8")).text
    lines = out.splitlines()
    # Contact lines are written "- - item", and a blank line separates the
    # top-level blocks and the sections, but never follows "sections:".
    assert "  - - url: https://www.johndoeportfolio.com" in lines
    assert "    - orcid: 0000-0000-0000-0000" in lines
    assert lines[lines.index("contact:") - 1] == ""
    assert lines[lines.index("sections:") - 1] == ""
    assert lines[lines.index("sections:") + 1].startswith("  - title:")
    starts = [i for i, line in enumerate(lines) if line.startswith("  - title:") or line == "  - newpage"]
    assert len(starts) > 3 and all(lines[i - 1] == "" for i in starts[1:])


# -- generated v1 files as raw text, with the YAML 1.1 scalars, block scalars,
# comments and anchors that yaml.safe_dump never writes

ATOMS = ["yes", "No", "on", "off", "y", "2:1", "10:30", "1:20:30", "017", "0o17", "0x1F", "1e3", "1_000", ".5",
         "-.inf", ".NaN", "null", "~", "true", "2024-05-01", "+12", "0b101", "a", "Jane", "x y", "*b*", "**c**",
         "[l](https://x.org/a_b)", "'q'", "50\\%", "C\\#", "a_b", "\\textbf{x}", "{date}", "--", "a^b", "<>", "|",
         "é", "—", "?`", "\\\\", "5\\*", "a #c", "&", "@x", "{a}", "[a]", "-x", "a: b", "\t", "  ", "    ", "- title: x"]


@st.composite
def raw_scalar(draw, indent):
    text = "".join(draw(st.lists(st.sampled_from(ATOMS), min_size=1, max_size=3)))
    style = draw(st.sampled_from(["plain", "single", "double", "literal", "folded", "number"]))
    if style == "plain":
        try:
            loaded = yaml.safe_load(f"k: {text}")
        except yaml.YAMLError:
            loaded = None
        ok = isinstance(loaded, dict) and list(loaded) == ["k"] and text.strip() == text
        if ok and "\t" not in text and not text.startswith(("-", "?", ":", "@", "`", "|", ">", "%", "!", "&", "*")):
            return text
        style = "single"
    if style == "single":
        return "'" + text.replace("'", "''") + "'"
    if style in ("literal", "folded"):
        pad = " " * (indent + 2)
        chomp = draw(st.sampled_from(["", "-", "+"]))
        head = ("|" if style == "literal" else ">") + chomp
        return f"{head}\n{pad}{text.replace(chr(9), ' ').strip() or 'x'}\n{pad}second line"
    if style == "number":
        return str(draw(st.sampled_from([0, 7, 2023, 1.5, -3, True, False])))
    return json.dumps(text, ensure_ascii=False)


@st.composite
def raw_v1_documents(draw):
    comment = lambda: draw(st.sampled_from(["", "  # note", "  # a: b", "  #"]))  # noqa: E731
    out = ["# my CV\n"]
    if draw(st.booleans()):
        out.append("version: 1\n")
    anchor = draw(st.booleans())
    out.append(f"heading:\n  name: {'&n ' if anchor else ''}{draw(raw_scalar(2))}{comment()}\n")
    if draw(st.booleans()):
        out.append("subheading:\n")
        for _ in range(draw(st.integers(1, 2))):
            if draw(st.booleans()):
                out.append("  - type: links\n    content:\n")
                for _ in range(draw(st.integers(0, 2))):
                    out.append(f"      - name: {draw(raw_scalar(8))}\n        show_below: {draw(st.sampled_from(['true', 'false', 'yes']))}\n")
                    if draw(st.booleans()):
                        out.append("        highlight: true\n")
            else:
                out.append("  - type: socials\n    content:\n")
                for _ in range(draw(st.integers(0, 2))):
                    kind = draw(st.sampled_from(["orcid_id", "github", "linkedin", "twitter"]))
                    out.append(f"      - type: {kind}\n        url: {draw(raw_scalar(8))}\n"
                               f"        show_below: {draw(st.sampled_from(['true', 'false']))}{comment()}\n")
    out.append("sections:\n")
    for _ in range(draw(st.integers(1, 3))):
        kind = draw(st.sampled_from(["education", "experience", "bullets", "skills", "talks", "newpage"]))
        s = lambda indent: draw(raw_scalar(indent))  # noqa: E731
        if kind == "education":
            out.append(f"  - type: education{comment()}\n    content:\n      - university: {s(8)}\n        dates: {s(8)}\n"
                       f"        degree: {s(8)}\n        honors: {s(8)}\n        thesis_title: {s(8)}\n"
                       f"        bullets:\n          - {s(12)}\n")
        elif kind == "experience":
            out.append(f"  - type: experience\n    content:\n      - name: {s(8)}\n        entity:\n"
                       f"          - organization: {s(12)}\n            dates: {s(12)}\n            position: {s(12)}\n"
                       f"            supervisor: {s(12)}\n            department: {s(12)}\n            location: {s(12)}\n"
                       f"            responsibilities:\n              - {s(16)}{comment()}\n")
        elif kind == "bullets":
            alias = "*n" if anchor and draw(st.booleans()) else s(8)
            out.append(f"  - type: bullets\n    title: {s(4)}\n    description: {s(4)}\n    content:\n"
                       f"      - item: {alias}\n        subitems: [s, null]\n      - item: {s(8)}\n")
        elif kind == "skills":
            out.append(f"  - type: skills\n    content:\n      - name: {s(8)}\n        data: {s(8)}\n")
        elif kind == "talks":
            out.append(f"  - type: talks\n    title: {s(4)}\n    content:\n      - name: {s(8)}\n"
                       f"        month: {s(8)}\n        year: {s(8)}\n")
        else:
            out.append("  - type: newpage\n")
    return "".join(out)


@settings(max_examples=1000 if FUZZ else 60, deadline=None, suppress_health_check=[HealthCheck.too_slow, HealthCheck.data_too_large])
@given(raw_v1_documents())
def test_raw_v1_text_migrates(text):
    # A loadable v1 file migrates and renders the same, or stops with an error about the file.
    try:
        src = load_text(text, "gen.yaml")
        assert detect(src) == "v1"
        out = migrate_text(text, "gen.yaml").text
    except MigrationError:
        raise
    except CVError:
        return
    migrated = load_text(out, "<migrated>")
    assert validate(migrated) == [], out
    with warnings.catch_warnings(), redirect_stderr(io.StringIO()):
        warnings.simplefilter("ignore")
        v1_tex = api.render_tex(api.loads(text, "gen.yaml")).tex
    v2_tex = api.render_tex(api.loads(out, "<migrated>")).tex
    assert normalize_tex(v2_tex) == normalize_tex(v1_tex)
