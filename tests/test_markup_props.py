"""Property-based tests for the markup converter. ``CV_TOOLS_FUZZ=1`` runs a much longer search."""

import os
import re
import subprocess
import tempfile
import unicodedata
from collections import Counter
from pathlib import Path

import jsonschema
import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from cv_tools import model
from cv_tools.markup import to_latex
from cv_tools.render import latex
from cv_tools.validate import schema

from helpers import FIXTURES, compile_result, link_targets, page_count

FUZZ = os.environ.get("CV_TOOLS_FUZZ", "") not in ("", "0")

CHARS = list(
    "*[]()'\n \t#$%&_{}~^\\<>|`?!-.,:;/\"@=+ab1Z"
    "\r\f\v\x00\x01\x1b\x7f\x85\u2028"
    "éüßØ"
    "łőŁČ—–“”‘’…€†•"
)
TOKENS = CHARS + ["**", "***", "[a](", "](http://x.org/", ")", "  ", "    ", "''", "``", "--", "^^", "\\*", "\\\\", "{date}"]
texts = st.lists(st.sampled_from(TOKENS), max_size=12).map("".join)
# Contact items and the date are single-line; the schema rejects line ends there.
LINE_ENDS = re.compile("[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]")
lines = texts.map(lambda s: LINE_ENDS.sub(" ", s))
urls = st.lists(st.sampled_from(list("ab1/:.?=&#%_~^ ()é{}\\") + ["https://x.org/", "%20"]), max_size=10).map(
    lambda parts: "https://x.org/" + LINE_ENDS.sub("", "".join(parts))
)
plain_alphabet = st.text(alphabet="".join(CHARS), max_size=40)


def tokens(latex: str):
    i = 0
    while i < len(latex):
        c = latex[i]
        if c == "\\":
            if i + 1 < len(latex) and latex[i + 1].isalpha():
                i += 1
                while i < len(latex) and latex[i].isalpha():
                    i += 1
                continue
            i += 2  # control symbol such as \\ \{ \% or \ (control space)
            continue
        yield c
        i += 1


@given(texts)
def test_braces_are_balanced(text):
    depth = 0
    for c in tokens(to_latex(text, date=latex.AUTO_DATE)):
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            assert depth >= 0, to_latex(text)
    assert depth == 0, to_latex(text)


@given(texts)
def test_no_unescaped_comment_or_parameter_chars(text):
    # % would comment out the rest of the line, # breaks macro arguments.
    assert not {"%", "#"} & set(tokens(to_latex(text)))


@given(texts)
def test_no_unescaped_specials_outside_urls(text):
    # Inside \href{...} the URL may keep & _ ~ $, which hyperref handles.
    latex_ = re.sub(r"\\href\{(?:[^{}\\]|\\.)*\}", "", to_latex(text))
    assert not {"$", "&", "_", "^", "~"} & set(tokens(latex_))


@given(texts)
def test_no_control_characters_or_ligature_pairs(text):
    out = to_latex(text)
    assert not re.search(r"[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]", out)
    assert "?`" not in out and "!`" not in out
    assert "^^" not in out


MARKUP_ONLY = st.lists(
    st.sampled_from(["*", "**", "***", "[", "]", "(", ")", "'", "\\", " ", "\n", "\t", "a", "b", "z", "1", "7",
                     "[a](", "](http://x/", ")"]),
    max_size=16,
).map("".join)


def alnum(text):
    return Counter(c for c in text if c.isalnum())


@given(MARKUP_ONLY)
def test_markup_never_drops_text(text):
    # Every letter and digit of the input is printed (or is part of a link target).
    shown = alnum("".join(tokens(to_latex(text))))
    missing = alnum(text) - shown
    assert not missing, (text, to_latex(text))


@given(plain_alphabet)
def test_conversion_is_total(text):
    to_latex(text)
    to_latex(text, date=latex.AUTO_DATE)


# -- compiling every field context

case = st.fixed_dictionaries(
    {
        "title": texts, "date": texts, "subtitle": texts, "note": texts, "location": texts,
        "detail": texts, "bullet": texts, "text": texts, "description": texts,
        "contact": lines, "separator": lines, "url": urls, "highlight": texts,
    }
)


def document(cases, date):
    first = cases[0]
    contact = [
        [c["contact"], {"url": c["url"]}, {"github": c["url"]}, f"{c['contact']} {{date}}"] for c in cases[:2]
    ] + [{"items": [first["contact"], {"orcid": first["url"]}, first["contact"]], "separator": first["separator"]}]
    sections = []
    for c in cases:
        entry = {key: c[key] for key in ("title", "date", "subtitle", "note", "location")}
        entry.update(details=[c["detail"], c["text"]], bullets=[c["bullet"], c["text"]])
        common = {"title": c["title"], "description": c["description"]}
        sections += [
            {**common, "layout": "entries", "entries": [entry, {"title": c["text"]}]},
            {**common, "layout": "entries-inline", "entries": [entry, {"title": c["text"]}]},
            {**common, "layout": "list", "entries": [c["text"], {"text": c["bullet"], "bullets": [c["detail"]]}]},
            {**common, "layout": "pairs", "entries": [{"title": c["title"], "text": c["text"]}]},
            {**common, "layout": "dated", "entries": [{"date": c["date"], "text": c["text"]}, c["bullet"]]},
            {**common, "layout": "text", "entries": [c["text"], {"text": c["detail"]}]},
            {**common, "layout": "publications", "bib": "publications.bib", "highlight": [c["highlight"], "Jane Roe"]},
            "newpage",
        ]
    return {"version": 2, "name": first["title"], "date": date, "contact": contact, "sections": sections}


def expected_uri(url: str) -> str:
    """The link target a URL field must give (v2-spec section 3.4)."""
    out, fragment = "", False
    for c in url:
        if c in "\\{}^ \t\n\r" or not 0x20 <= ord(c) <= 0x7E or (c == "#" and fragment):
            out += "".join(f"%{b:02X}" for b in c.encode("utf-8"))
        else:
            out += c
        fragment = fragment or c == "#"
    return out


# A URL never holds a brace (escaping percent-encodes them); link text may hold balanced braces.
LINK_COMMANDS = re.compile(r"\\(href|url|orcidicon)\{((?:[^{}\\]|\\.)*)\}")


def _group(tex: str, start: int) -> str:
    depth, i = 0, start
    while True:
        if tex[i] == "\\":
            i += 2
            continue
        depth += {"{": 1, "}": -1}.get(tex[i], 0)
        if depth == 0:
            return tex[start + 1 : i]
        i += 1


def tex_link_targets(tex: str) -> tuple[list[str], list[str]]:
    """All link targets of the LaTeX, and those that must be URI links.

    An ``\\href`` without letters or digits may give no annotation, and a target without a scheme is a file link.
    """
    every, visible = [], []
    for match in LINK_COMMANDS.finditer(tex):
        command, arg = match.groups()
        uri = re.sub(r"\\([%#])", r"\1", arg)
        uri = "https://orcid.org/" + uri if command == "orcidicon" else uri
        every.append(uri)
        if re.match(r"[A-Za-z][A-Za-z0-9+.-]*:", uri) and (
            command != "href" or visible_alnum(_group(tex, match.end()))
        ):
            visible.append(uri)
    return every, visible


def visible_alnum(latex_: str) -> Counter:
    """Case-folded ASCII letters and digits that LaTeX prints."""
    shown = "".join(tokens(re.sub(r"\\href\{(?:[^{}\\]|\\.)*\}", "", latex_)))
    return Counter(c for c in shown.casefold() if c.isascii() and c.isalnum())


def pdf_alnum(pdf: bytes) -> Counter:
    """Case-folded ASCII letters and digits of the PDF text, ligatures unfolded."""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "in.pdf"
        path.write_bytes(pdf)
        text = subprocess.run(["pdftotext", str(path), "-"], check=True, capture_output=True).stdout.decode()
    text = unicodedata.normalize("NFKC", text)
    return Counter(c for c in text.casefold() if c.isascii() and c.isalnum())


def printed_fields(data: dict) -> Counter:
    """The letters and digits of the fields every layout always prints (entry lines 2 and 3 need a subtitle)."""
    date = latex.date_latex(model.from_data({**data, "sections": []}, FIXTURES).date)
    out = Counter()
    for line in data["contact"]:
        items = line["items"] if isinstance(line, dict) else line
        for item in items:
            if isinstance(item, str):
                out += visible_alnum(to_latex(item, date=date))
    for section in data["sections"]:
        if section == "newpage":
            continue
        out += visible_alnum(to_latex(section["title"])) + visible_alnum(to_latex(section["description"]))
        for entry in section.get("entries", []):
            entry = entry if isinstance(entry, dict) else {"text": entry}
            for key in ("title", "text"):
                if key in entry:
                    out += visible_alnum(to_latex(entry[key]))
            if section["layout"] == "list":
                for bullet in entry.get("bullets", []):
                    out += visible_alnum(to_latex(bullet))
    return out


@pytest.mark.tex
@settings(
    max_examples=200 if FUZZ else 6,
    deadline=None,
    derandomize=not FUZZ,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.data_too_large],
)
@given(st.lists(case, min_size=1, max_size=6 if FUZZ else 3), st.one_of(st.just("auto"), lines))
def test_every_field_compiles(cases, date):
    data = document(cases, date)
    errors = list(jsonschema.Draft202012Validator(schema()).iter_errors(data))
    assert errors == [], [e.message for e in errors]
    doc = model.from_data(data, FIXTURES / "v2")
    result = latex.render(doc)
    pdf = compile_result(result)
    assert page_count(pdf) >= len(cases)
    # hyperref's \\href drops an empty fragment and \\url keeps it, so a trailing # is ignored.
    def uris(targets):
        return Counter(uri[:-1] if uri.endswith("#") else uri for uri in targets)

    found = uris(uri for page in link_targets(pdf) for uri in page)
    every, visible = tex_link_targets(result.tex)
    assert not found - uris(every), "links the LaTeX does not ask for"
    assert not uris(visible) - found, "links missing from the PDF"
    contact_links = [expected_uri(c["url"]) for c in cases[:2] for _ in range(2)]
    contact_links.append("https://orcid.org/" + expected_uri(cases[0]["url"]))
    assert not uris(contact_links) - found
    # The text of every field that is always printed reaches the PDF.
    missing = printed_fields(data) - pdf_alnum(pdf)
    assert not missing, missing


@pytest.mark.tex
@pytest.mark.parametrize("date", ["auto", {"latex": r"\today"}, {"latex": r"\the\year"}, "Spring 2025"])
def test_date_placeholder_compiles_before_letters(date):
    # \customdate\todayth or \todayth would be an undefined control sequence.
    data = {"version": 2, "name": "x", "date": date,
            "contact": [["{date}th", "*Updated {date}*", "[{date}](https://x.org)"]]}
    tex = latex.render(model.from_data(data, FIXTURES)).tex
    assert latex.date_latex(model.from_data(data, FIXTURES).date) + "{}th" in tex
    pdf = compile_result(latex.render(model.from_data(data, FIXTURES)))
    assert link_targets(pdf) == [["https://x.org"]]
