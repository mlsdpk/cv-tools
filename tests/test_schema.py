"""JSON Schema: validity, valid files, and friendly line-numbered errors."""

import json
import warnings

import jsonschema
import pytest
import yaml

from cv_tools import api, v1
from cv_tools.loader import CVError, load_file, load_text
from cv_tools.migrate import migrate_text
from cv_tools.validate import V1_HINT, ValidationError, schema, validate

from helpers import FIXTURES, ROOT, fixture_dirs

V2_FILES = sorted((FIXTURES / "v2").glob("*.yaml")) + [ROOT / "examples" / "cv.yaml"]
V1_FILES = [d / "cv.yaml" for d in fixture_dirs("v1") + fixture_dirs("v1-bugfix")] + [ROOT / "examples" / "v1" / "cv.yaml"]


def ids(paths):
    return [str(p.relative_to(ROOT)) for p in paths]


def test_schema_is_valid_draft_2020_12():
    jsonschema.Draft202012Validator.check_schema(schema())
    assert schema()["$schema"] == "https://json-schema.org/draft/2020-12/schema"


def test_schema_file_is_packaged_json():
    path = ROOT / "src" / "cv_tools" / "schema" / "cv-v2.schema.json"
    assert json.loads(path.read_text()) == schema()


@pytest.mark.parametrize("path", V2_FILES, ids=ids(V2_FILES))
def test_v2_files_validate(path):
    assert validate(load_file(path)) == []


@pytest.mark.parametrize("path", V1_FILES, ids=ids(V1_FILES))
def test_v1_conversions_validate(path):
    # Both the in-memory conversion and the migrated file are valid v2.
    src = load_file(path)
    assert v1.detect(src) == "v1"
    validator = jsonschema.Draft202012Validator(schema())
    assert list(validator.iter_errors(v1.convert(src).data)) == []
    migrated = migrate_text(path.read_text(encoding="utf-8"), str(path))
    assert validate(load_text(migrated.text, "<migrated>")) == []


INVALID = {
    "boolean-text.yaml": ["7:9: sections[0].entries[0]: expected text (a string, a number or {latex: ...}), got a boolean"],
    "contact-item.yaml": [
        "4:7: contact[0][0]: expected exactly one of the keys url, orcid, linkedin, github, twitter"
    ],
    "contact-lines.yaml": ["4:3: contact: at most 3 items allowed, got 4"],
    "duplicate-key-v1.yaml": ["130:9: duplicate key 'year' (first defined on line 129)"],
    "duplicate-key-v2.yaml": ["3:1: duplicate key 'name' (first defined on line 2)"],
    "latex-typo.yaml": ["2:8: name.latx: unknown key 'latx'; did you mean 'latex'?"],
    "missing-name.yaml": ["1:1: missing required key 'name'"],
    "missing-title.yaml": ["4:5: sections[0]: missing required key 'title'"],
    "misspelled-key.yaml": ["7:9: sections[0].entries[0].titel: unknown key 'titel'; did you mean 'title'?"],
    "newpage-typo.yaml": ["4:5: sections[0]: expected 'newpage' or a section mapping, got 'new page'"],
    "no-version.yaml": [
        "1:1: cannot tell the CV format: expected 'version: 2' at the top of a v2 file "
        "(v1 files have 'heading', 'subheading' or sections with 'type')"
    ],
    "publications-without-bib.yaml": [
        "6:5: sections[0].bibfile: unknown key 'bibfile'; did you mean 'bib'? " + V1_HINT
    ],
    "syntax-error.yaml": ["3:9: expected ',' or ']', but got ':'"],
    "unknown-key.yaml": ["8:9: sections[0].entries[0].dates: unknown key 'dates'; did you mean 'date'?"],
    "unknown-layout.yaml": ["5:13: sections[0].layout: unknown value 'dates'; did you mean 'dated'?"],
    "v1-key-in-v2.yaml": ["6:5: sections[0].content: unknown key 'content'; did you mean 'entries'? " + V1_HINT],
    "v1-field-names.yaml": [
        "7:9: sections[0].entries[0].organization: unknown key 'organization'; did you mean 'title'?",
        "8:9: sections[0].entries[0].position: unknown key 'position'; did you mean 'subtitle'?",
        "9:9: sections[0].entries[0].honors: unknown key 'honors'; did you mean 'note'?",
        "10:9: sections[0].entries[0].year: unknown key 'year'; did you mean 'date'?",
        "11:9: sections[0].entries[0].responsibilities: unknown key 'responsibilities'; did you mean 'bullets'? "
        + V1_HINT,
    ],
    "v1-section-type.yaml": ["4:5: sections[0]: missing required key 'layout' (v1 sections had 'type'). " + V1_HINT],
    "contact-newline.yaml": ["4:7: contact[0][0]: contact items are single-line; add another contact line"],
    "date-newline.yaml": ["3:7: date: the date is printed in a contact line and must be single-line"],
    "null-list-item.yaml": [
        "8:8: sections[0].entries[1]: empty list item (null); remove the '-' line or give the item a value"
    ],
    "text-bullets.yaml": ["8:9: sections[0].entries[0].bullets: unknown key 'bullets' (expected one of: text)"],
    "version-3.yaml": ["1:10: unsupported version 3: expected 'version: 2' (or 'version: 1' for the deprecated v1 format)"],
    "wrong-type.yaml": ["8:18: sections[0].entries[0].bullets: expected a list, got a string"],
    "v1-structure.yaml": ["5:14: expected a list, got a string"],
    "v1-missing-bibfile.yaml": ["4:5: section 'Papers' is missing a 'bibfile' entry"],
    "missing-bib-file.yaml": ["6:10: BibTeX file not found: {dir}/does-not-exist.bib"],
    "v1-missing-bib-file.yaml": ["6:14: BibTeX file not found: {dir}/does-not-exist.bib"],
}


def test_every_invalid_fixture_has_an_expectation():
    assert sorted(INVALID) == sorted(p.name for p in (FIXTURES / "invalid").glob("*.yaml"))


@pytest.mark.parametrize("name", sorted(INVALID))
def test_invalid_fixture_message(name):
    path = FIXTURES / "invalid" / name
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        with pytest.raises(CVError) as info:
            api.load(path)
    errors = info.value.errors if isinstance(info.value, ValidationError) else [info.value]
    expected = [f"{path}:" + m.replace("{dir}", str(path.parent.resolve())) for m in INVALID[name]]
    assert [str(e) for e in errors] == expected


def test_validation_reports_every_error_in_order():
    src = load_text(
        "version: 2\nname: x\nsections:\n  - title: A\n    layout: pairs\n    entries:\n"
        "      - {title: a}\n      - {title: b, text: c, extra: d}\n",
        "f.yaml",
    )
    assert [str(e) for e in validate(src)] == [
        "f.yaml:7:9: sections[0].entries[0]: missing required key 'text'",
        "f.yaml:8:29: sections[0].entries[1].extra: unknown key 'extra' (expected one of: text, title)",
    ]


def test_latex_and_numbers_are_text():
    src = load_text("version: 2\nname: {latex: x}\nsections:\n  - {title: 2024, layout: text, entries: [1.5]}\n")
    assert validate(src) == []


def v2(sections, **top):
    data = {"version": 2, "name": "Jane Roe", **top, "sections": sections}
    return api.loads(yaml.safe_dump(data, sort_keys=False), "<test>", FIXTURES / "v2")


def errors(sections, **top):
    data = {"version": 2, "name": "Jane Roe", **top, "sections": sections}
    return [str(e) for e in validate(load_text(yaml.safe_dump(data, sort_keys=False), "f.yaml"))]


@pytest.mark.parametrize(
    "layout, shorthand, mapping",
    [
        ("list", "Best *paper*", {"text": "Best *paper*"}),
        ("text", "A paragraph.", {"text": "A paragraph."}),
        ("dated", "A talk.", {"text": "A talk."}),
        ("list", {"latex": "\\emph{x}"}, {"text": {"latex": "\\emph{x}"}}),
        ("text", 2024, {"text": 2024}),
    ],
)
def test_text_shorthand_and_mapping_render_the_same(layout, shorthand, mapping):
    # Schema -> model: both forms validate and give the same model and LaTeX.
    a = v2([{"title": "T", "layout": layout, "entries": [shorthand]}])
    b = v2([{"title": "T", "layout": layout, "entries": [mapping]}])
    assert a.sections[0].entries == b.sections[0].entries
    assert api.render_tex(a).tex == api.render_tex(b).tex


@pytest.mark.parametrize(
    "layout, entry, message",
    [
        ("pairs", "x", "expected a mapping, got a string"),
        ("entries", "x", "expected a mapping, got a string"),
        ("entries-inline", "x", "expected a mapping, got a string"),
        ("text", {"text": "x", "bullets": ["y"]}, "unknown key 'bullets' (expected one of: text)"),
        ("dated", {"text": "x", "bullets": ["y"]}, "unknown key 'bullets' (expected one of: date, text)"),
        ("list", {"text": "x", "date": "y"}, "unknown key 'date' (expected one of: bullets, text)"),
        ("dated", {"date": "Nov. 2023"}, "missing required key 'text'"),
    ],
)
def test_entries_the_model_cannot_render_are_rejected(layout, entry, message):
    # Model -> schema: entry forms without a meaning in a layout fail validation.
    found = errors([{"title": "T", "layout": layout, "entries": [entry]}])
    assert len(found) == 1 and found[0].endswith(message), found


def test_every_layout_field_is_rendered():
    # Every key the schema allows in an entry appears in the LaTeX.
    defs = schema()["$defs"]
    fields = sorted(defs["entry"]["properties"])
    entry = {f: (["X" + f.upper()] if f in ("details", "bullets") else "X" + f.upper()) for f in fields}
    for layout in ("entries", "entries-inline"):
        tex = api.render_tex(v2([{"title": "T", "layout": layout, "description": "XDESC", "entries": [entry]}])).tex
        for f in fields + ["desc"]:
            assert "X" + f.upper() in tex, (layout, f)


@pytest.mark.parametrize(
    "date, latex",
    [
        ("auto", "\\customdate\\today"),
        ("Spring 2025", "Spring 2025"),
        ("*Updated* 2025", "\\textit{Updated} 2025"),
        ("50% done", "50\\% done"),
        (2025, "2025"),
        ({"latex": "\\today"}, "\\today"),
    ],
)
def test_top_level_date_is_text(date, latex):
    # Every insertion ends with {}, so letters may follow {date}.
    doc = v2([], date=date, contact=[["Curriculum Vitae, {date}"]])
    assert ("\\address{Curriculum Vitae, " + latex + "{}}") in api.render_tex(doc).tex


def test_v2_strings_are_yaml_1_2():
    # yes, on and 2:1 are text in a v2 file, as the JSON Schema and editors read them.
    doc = api.loads(
        "version: 2\nname: Jane Roe\nsections:\n  - title: Awards\n    layout: list\n"
        "    entries: [yes, on, 2:1, 10:30, 2024-05-01]\n"
    )
    assert [e.text for e in doc.sections[0].entries] == ["yes", "on", "2:1", "10:30", "2024-05-01"]


@pytest.mark.parametrize("item", ["a\nb", "a\rb", "a\u2028b", "a\x85b"])
def test_contact_items_are_single_line(item):
    found = errors([], contact=[[item], [{"url": item}], {"items": ["x"], "separator": item}])
    assert len(found) == 3 and all(f.endswith("contact items are single-line; add another contact line") for f in found)


def test_null_list_items_are_rejected_everywhere():
    found = errors(
        [
            {"title": "T", "layout": "list", "entries": [None, {"text": "x", "bullets": [None]}]},
            {"title": "E", "layout": "entries", "entries": [{"title": "x", "details": [None], "bullets": [None]}]},
        ],
        contact=[[None]],
    )
    assert len(found) == 5 and all("empty list item (null)" in f for f in found), found


@pytest.mark.parametrize(
    "layout, entry, hint",
    [
        ("dated", "{name: a}", "text"),
        ("list", "{name: a}", "text"),
        ("text", "{name: a}", "text"),
        ("pairs", "{name: a, text: b}", "title"),
        ("entries", "{name: a}", "title"),
        ("entries-inline", "{name: a}", "title"),
    ],
)
def test_name_hint_depends_on_the_layout(layout, entry, hint):
    # v1 used 'name' for the main label of skills and the text of talks.
    text = f"version: 2\nname: x\nsections:\n  - title: T\n    layout: {layout}\n    entries:\n      - {entry}\n"
    assert [e.message for e in validate(load_text(text))] == [
        f"sections[0].entries[0].name: unknown key 'name'; did you mean '{hint}'?"
    ]


SCHEMA_URL = "https://cv-tools.phonethk.com/schema/v2.json"


def test_schema_url_is_the_site_url():
    from cv_tools import migrate

    assert schema()["$id"] == SCHEMA_URL
    assert migrate.SCHEMA_URL == SCHEMA_URL
    header = f"# yaml-language-server: $schema={SCHEMA_URL}\n"
    for path in (ROOT / "examples" / "cv.yaml", ROOT / "src" / "cv_tools" / "starter" / "cv.yaml"):
        assert path.read_text(encoding="utf-8").startswith(header), path
    old = "mlsdpk.github.io/cv-tools"
    paths = [ROOT / "README.md", ROOT / "CHANGELOG.md"]
    for folder in ("src", "examples", "tests", "docs", "tools"):
        paths += (ROOT / folder).rglob("*")
    for path in paths:
        if path.is_file() and path.suffix in (".py", ".yaml", ".json", ".md", ".jinja", ".tex", ".cls", ".txt"):
            if ".egg-info" not in str(path) and path.name != "test_schema.py":
                assert old not in path.read_text(encoding="utf-8", errors="replace"), path
    assert SCHEMA_URL in (ROOT / "README.md").read_text(encoding="utf-8")
