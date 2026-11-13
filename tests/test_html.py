"""The HTML preview. Golden snapshots (v2 fixtures, the aliases fixture, one v1 file) are in tests/golden/html/.

Update them with ``pytest tests/test_html.py --update-golden`` and review the diff.
"""

from __future__ import annotations

import datetime
import io
import os
import re
import subprocess
import time
import unicodedata
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

import pytest
import yaml
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from cv_tools import api, model
from cv_tools.bib import Author, Publication
from cv_tools.loader import load_text
from cv_tools.markup import Latex, safe_url, split_date_html, to_html, to_latex
from cv_tools.model import ICON_KINDS
from cv_tools.render import html as html_render

from helpers import FIXTURES, ROOT, SOURCE_DATE_EPOCH, TESTS, compile_result, font_cmap, page_count, tex_font

FUZZ = os.environ.get("CV_TOOLS_FUZZ", "") not in ("", "0")
GOLDEN = TESTS / "golden" / "html"
V2_CASES = sorted((FIXTURES / "v2").glob("*.yaml"))
GOLDEN_CASES = {p.stem: p for p in V2_CASES} | {
    "aliases": FIXTURES / "aliases" / "cv.yaml",
    "v1-master-example": FIXTURES / "v1" / "master-example" / "cv.yaml",
}
EXAMPLE = ROOT / "examples" / "cv.yaml"
# The date of SOURCE_DATE_EPOCH, which the PDF tests print for date: auto.
TODAY = datetime.datetime.fromtimestamp(SOURCE_DATE_EPOCH, datetime.timezone.utc).date()

ALLOWED_TAGS = {
    "div", "header", "h1", "h2", "p", "section", "span", "a", "strong", "em", "br", "sup", "code",
    "ul", "li", "svg", "path",
}
ALLOWED_ATTRS = {
    "class", "href", "aria-label", "aria-hidden", "focusable", "viewbox", "fill", "d", "transform",
    "data-path", "data-raw", "data-latex", "data-entry", "data-section", "data-newpage", "data-layout",
    "data-contact", "data-readonly", "data-source-format", "data-editable", "data-via-alias", "data-anchor",
}
SAFE_HREF = re.compile(r"(?i)(https?|mailto):")


def render(path: Path, today: datetime.date = TODAY) -> api.HtmlResult:
    return api.render_html(api.load(path), today=today)


class Elements(HTMLParser):
    """Every start tag with its attributes, and the text with a space at each non-phrasing element boundary."""

    VOID = {"br", "path"}
    PHRASING = {"strong", "em", "a", "sup", "code", "span"}
    # Phrasing elements that the stylesheet lays out as separate boxes.
    BOXES = {"cv-head", "cv-date", "cv-right", "cv-subtitle", "cv-note", "cv-month", "cv-year", "cv-text",
             "cv-pair-title", "cv-dated-date", "cv-sep", "cv-contact-text", "cv-url", "cv-icon"}

    def __init__(self, html: str):
        super().__init__(convert_charrefs=True)
        self.elements: list[tuple[str, dict[str, str | None]]] = []
        self.text: list[str] = []
        self.latex_text: list[str] = []
        self._stack: list[str] = []
        self._latex = 0
        self.feed(html)
        self.close()

    def _boundary(self, tag, attrs) -> None:
        classes = set((attrs.get("class") or "").split())
        if tag not in self.PHRASING or classes & self.BOXES:
            (self.latex_text if self._latex else self.text).append(" ")

    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))
        self._boundary(tag, dict(attrs))
        if tag in self.VOID:
            return
        self._stack.append((tag, dict(attrs)))
        if tag == "code" and "cv-latex" in (dict(attrs).get("class") or ""):
            self._latex = len(self._stack)

    def handle_startendtag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))

    def handle_endtag(self, tag):
        if tag in self.VOID:
            return
        assert self._stack and self._stack[-1][0] == tag, f"unbalanced </{tag}> in {self._stack}"
        if self._latex == len(self._stack):
            self._latex = 0
        self._boundary(*self._stack.pop())

    def handle_data(self, data):
        (self.latex_text if self._latex else self.text).append(data)

    def close(self):
        super().close()
        assert not self._stack, f"unclosed elements: {self._stack}"

    def with_attr(self, name: str) -> list[dict]:
        return [a for _, a in self.elements if name in a]


def walk(data, path: str):
    node = data
    for part in api.split_path(path):
        node = node[part]
    return node


# -- rendering


@pytest.mark.parametrize("path", V2_CASES + [EXAMPLE], ids=lambda p: p.stem if p != EXAMPLE else "example")
def test_every_layout_renders(path):
    result = render(path)
    doc = api.load(path)
    parsed = Elements(result.html)
    layouts = [a["data-layout"] for _, a in parsed.elements if "data-layout" in a]
    assert layouts == [s.layout for s in doc.sections if s.layout != "newpage"]
    assert result.pages == 1 + sum(s.layout == "newpage" for s in doc.sections)
    assert len([1 for t, a in parsed.elements if t == "div" and "cv-page" in a.get("class", "").split()]) == result.pages
    assert result.editable
    assert result.css == html_render.stylesheet()


def test_example_has_every_layout():
    layouts = {s.layout for s in api.load(EXAMPLE).sections} | {
        s.layout for p in V2_CASES for s in api.load(p).sections
    }
    assert layouts == {"entries", "entries-inline", "list", "pairs", "dated", "text", "publications", "newpage"}


@pytest.mark.parametrize("name", sorted(GOLDEN_CASES))
def test_golden_html(name, update_golden):
    html = render(GOLDEN_CASES[name]).html
    golden = GOLDEN / f"{name}.html"
    if update_golden:
        golden.parent.mkdir(exist_ok=True)
        golden.write_text(html, encoding="utf-8")
        pytest.skip("golden file updated")
    assert golden.exists(), f"missing {golden}; run pytest --update-golden"
    assert html == golden.read_text(encoding="utf-8")


def test_no_stale_golden_html():
    assert sorted(p.stem for p in GOLDEN.glob("*.html")) == sorted(GOLDEN_CASES)


def test_render_is_deterministic_and_cached():
    a = render(EXAMPLE).html
    b = render(EXAMPLE).html
    assert a == b
    assert html_render._environment() is html_render._environment()


def test_newpage_starts_a_page_box():
    result = render(FIXTURES / "v2" / "text.yaml")
    pages = result.html.split('<div class="cv-page"')
    assert result.pages == 2 and len(pages) == 3
    assert pages[2].startswith(' data-newpage="sections.1">')
    assert "After a Page Break" in pages[2] and "After a Page Break" not in pages[1]
    assert "cv-header" in pages[1] and "cv-header" not in pages[2]


def test_render_time():
    doc = api.load(EXAMPLE)
    api.render_html(doc, today=TODAY)  # compiles the templates
    times = []
    for _ in range(5):
        start = time.perf_counter()
        api.render_html(doc, today=TODAY)
        times.append(time.perf_counter() - start)
    assert sorted(times)[2] < 0.05, times


# -- data-path


def _leaf(value, path: tuple) -> str:
    """The data-path of a text value: a {latex: ...} value points at its string."""
    return html_render.dotted(path + ("latex",) if isinstance(value, dict) else path)


def _is_icon(item) -> bool:
    return isinstance(item, dict) and bool(set(item) & set(ICON_KINDS))


def _date_uses(text) -> int:
    if not isinstance(text, str):
        return 0
    return text.count("{date}") - sum(t.count("{date}") for t in re.findall(r"\]\(([^()]*)\)", text))


def printed_paths(data: dict) -> Counter:
    """The data-path values a v2 document must print, with how often each appears."""
    out: Counter = Counter()
    out[_leaf(data["name"], ("name",))] += 1
    date_uses = 0
    for i, line in enumerate(data.get("contact", [])):
        items, base = (line["items"], ("contact", i, "items")) if isinstance(line, dict) else (line, ("contact", i))
        for j, item in enumerate(items):
            if isinstance(item, dict) and "latex" not in item:
                (kind, value), = item.items()
                out[_leaf(value, base + (j, kind))] += 1
            else:
                out[_leaf(item, base + (j,))] += 1
                date_uses += _date_uses(item)
        if isinstance(line, dict) and "separator" in line:
            uses = sum(1 for j, item in enumerate(items) if j and not _is_icon(item))
            if uses:
                out[_leaf(line["separator"], ("contact", i, "separator"))] += uses
    if "date" in data and date_uses:
        out[_leaf(data["date"], ("date",))] += date_uses
    for i, section in enumerate(data.get("sections", [])):
        if section == "newpage":
            continue
        for key in ("title", "description"):
            if key in section:
                out[_leaf(section[key], ("sections", i, key))] += 1
        for j, entry in enumerate(section.get("entries", [])):
            at = ("sections", i, "entries", j)
            if not isinstance(entry, dict) or "latex" in entry:
                out[_leaf(entry, at)] += 1
                continue
            for key, value in entry.items():
                if key in ("details", "bullets"):
                    for k, item in enumerate(value):
                        out[_leaf(item, at + (key, k))] += 1
                else:
                    out[_leaf(value, at + (key,))] += 1
    return out


@pytest.mark.parametrize("path", V2_CASES + [EXAMPLE], ids=lambda p: p.stem if p != EXAMPLE else "example")
def test_data_paths_resolve_and_cover_every_printed_field(path):
    data = load_text(path.read_text(encoding="utf-8"), str(path), yaml_version="1.2").data
    parsed = Elements(render(path).html)
    with_path = parsed.with_attr("data-path")
    assert with_path
    for attrs in with_path:
        value = walk(data, attrs["data-path"])
        assert isinstance(value, (str, int, float)) and not isinstance(value, bool), attrs
        assert attrs["data-raw"] == str(value), attrs
        assert ("data-latex" in attrs) == attrs["data-path"].endswith(".latex")
    assert Counter(a["data-path"] for a in with_path) == printed_paths(data)


@pytest.mark.parametrize("path", V2_CASES + [EXAMPLE], ids=lambda p: p.stem if p != EXAMPLE else "example")
def test_sections_and_entries_carry_their_paths(path):
    data = load_text(path.read_text(encoding="utf-8"), str(path), yaml_version="1.2").data
    parsed = Elements(render(path).html)
    sections = [a["data-section"] for a in parsed.with_attr("data-section")]
    newpages = [a["data-newpage"] for a in parsed.with_attr("data-newpage")]
    assert sections == [f"sections.{i}" for i, s in enumerate(data.get("sections", [])) if s != "newpage"]
    assert newpages == [f"sections.{i}" for i, s in enumerate(data.get("sections", [])) if s == "newpage"]
    entries = [a["data-entry"] for a in parsed.with_attr("data-entry")]
    assert entries == [
        f"sections.{i}.entries.{j}"
        for i, s in enumerate(data.get("sections", []))
        if s != "newpage"
        for j in range(len(s.get("entries", [])))
    ]
    contact = [a["data-contact"] for a in parsed.with_attr("data-contact")]
    assert contact == [f"contact.{i}" for i in range(len(data.get("contact", [])))]


def test_shorthand_and_mapping_entries_have_different_paths():
    parsed = Elements(render(FIXTURES / "v2" / "list.yaml").html)
    paths = {a["data-path"] for a in parsed.with_attr("data-path")}
    assert "sections.0.entries.1" in paths  # - Best Paper Award (2023)
    assert "sections.0.entries.3.text" in paths  # - text: A mapping without bullets
    assert "sections.0.entries.2.latex" in paths  # - {latex: ...}
    assert "sections.0.entries.0.bullets.1" in paths


def test_contact_line_paths():
    parsed = Elements(render(FIXTURES / "v2" / "contact.yaml").html)
    paths = Counter(a["data-path"] for a in parsed.with_attr("data-path"))
    for p in ("contact.0.0.url", "contact.0.1.orcid", "contact.0.3.github", "contact.1.items.0",
              "contact.1.items.1", "contact.2.0", "contact.2.1.latex"):
        assert paths[p] == 1, p
    assert paths["contact.1.separator"] == 1
    assert paths["date"] == 3  # "Updated {date}" and twice in "**{date}**th [{date}](...)"


def test_publications_are_read_only():
    parsed = Elements(render(FIXTURES / "v2" / "publications.yaml").html)
    citations = [a for t, a in parsed.elements if "cv-citation" in (a.get("class") or "")]
    assert len(citations) == 4
    assert all("data-readonly" in a and "data-path" not in a for a in citations)


@pytest.mark.parametrize("path", sorted((FIXTURES / "v1").glob("*/cv.yaml")), ids=lambda p: p.parent.name)
def test_v1_renders_without_paths(path):
    result = api.render_html(api.load(path), today=TODAY)
    assert not result.editable
    parsed = Elements(result.html)
    root = parsed.elements[0][1]
    assert root["data-source-format"] == "v1" and root["data-editable"] == "false"
    for name in ("data-path", "data-raw", "data-entry", "data-section", "data-newpage", "data-contact"):
        assert not parsed.with_attr(name), name


def test_date_without_date_key_is_not_editable():
    result = render(EXAMPLE)
    assert '<span class="cv-date-value">14<sup>th</sup> November 2023</span>' in result.html


@pytest.mark.parametrize(
    "day, expected",
    [(1, "1<sup>st</sup>"), (2, "2<sup>nd</sup>"), (3, "3<sup>rd</sup>"), (4, "4<sup>th</sup>"),
     (11, "11<sup>th</sup>"), (12, "12<sup>th</sup>"), (13, "13<sup>th</sup>"), (21, "21<sup>st</sup>"),
     (22, "22<sup>nd</sup>"), (23, "23<sup>rd</sup>"), (31, "31<sup>st</sup>")],
)
def test_auto_date_matches_customdate(day, expected):
    assert html_render.auto_date_html(datetime.date(2024, 1, day)) == f"{expected} January 2024"


# -- markup


@pytest.mark.parametrize(
    "text, expected",
    [
        ("**b**, *i*, ***bi***", "<strong>b</strong>, <em>i</em>, <strong><em>bi</em></strong>"),
        ("**a *b***", "<strong>a <em>b</em></strong>"),
        ("*see [d](https://x.org/a*b) here*", '<em>see <a class="cv-link" href="https://x.org/a*b">d</a> here</em>'),
        ("'quoted' and Dean's", "“quoted” and Dean’s"),
        ("a -- b --- c ``d''", "a – b — c “d”"),
        ("Line one\nLine two", "Line one<br>Line two"),
        ("a  b", 'a<span class="cv-space"> </span>b'),
        ("a    b\tc", 'a<span class="cv-space"><span class="cv-quad"></span></span>b'
                      '<span class="cv-space"><span class="cv-quad"></span></span>c'),
        ("a   b", 'a<span class="cv-space">  </span>b'),
        ("5\\* \\[x\\](y) \\'q\\' \\\\", "5* [x](y) ’q’ \\"),
        ("~ ^ < > & \" # $ % _ { } |", "∼ ˆ &lt; &gt; &amp; ” # $ % _ { } |"),
        ("[[1]](https://en.wikipedia.org/wiki/Foo_(bar))",
         '<a class="cv-link" href="https://en.wikipedia.org/wiki/Foo_(bar)">[1]</a>'),
        ("a\rb\x01c", "a<br>bc"),
        ("{date}", "{date}"),
        (2024, "2024"),
        (Latex("\\emph{x} ``y''"), '<code class="cv-latex">\\emph{x} ``y\'\'</code>'),
    ],
)
def test_to_html(text, expected):
    assert to_html(text) == expected


def test_date_placeholder():
    assert to_html("*Updated {date}*th", date="<b>D</b>") == "<em>Updated <b>D</b></em>th"
    assert to_html("[{date}](https://x.org/{date})", date="D") == '<a class="cv-link" href="https://x.org/%7Bdate%7D">D</a>'


@pytest.mark.parametrize(
    "url, expected",
    [
        ("https://x.org/a b", "https://x.org/a%20b"),
        ("HTTP://X.ORG", "HTTP://X.ORG"),
        ("mailto:a@b.c", "mailto:a@b.c"),
        (" \x01https://x.org", "https://x.org"),
        ('https://x.org/"onmouseover="a', "https://x.org/%22onmouseover=%22a"),
        ("javascript:alert(1)", None),
        ("JaVaScRiPt:alert(1)", None),
        ("java\tscript:alert(1)", None),
        ("java\nscript:alert(1)", None),
        ("\x00javascript:alert(1)", None),
        ("data:text/html,x", None),
        ("vbscript:x", None),
        ("//evil.org", None),
        ("x.org", None),
        ("", None),
        # A browser reads "https:javascript:..." as an https URL (host "javascript").
        ("https:javascript:alert(1)", "https:javascript:alert(1)"),
        # Browsers strip only C0 controls and spaces; a URL that starts with
        # another character has no scheme, so it is not linked.
        ("\xa0javascript:alert(1)", None),
        ("\u2028javascript:alert(1)", None),
        ("\ufeffjavascript:alert(1)", None),
        ("\xa0https://x.org", None),
        # Character references are not decoded: the text is the URL.
        ("javascript&#58;alert(1)", None),
        ("&#106;avascript:alert(1)", None),
        ("jav&#x09;ascript:alert(1)", None),
        ("javascript&colon;alert(1)", None),
        ("https://x.org/?a=1&b=2", "https://x.org/?a=1&b=2"),
    ],
)
def test_safe_url(url, expected):
    assert safe_url(url) == expected


def test_unsafe_link_renders_as_text():
    assert to_html("[x](javascript:alert(1))") == '<span class="cv-link">x</span>'
    assert to_html("[x](javascript&#58;alert(1))") == '<span class="cv-link">x</span>'
    # The attribute escapes "&", so a browser cannot decode a reference in the target.
    assert to_html("[x](https://x.org/?a=1&b=2)") == '<a class="cv-link" href="https://x.org/?a=1&amp;b=2">x</a>'


def test_split_date_html():
    assert split_date_html("Nov. 2023") == ("Nov.", "2023")
    assert split_date_html("2022") == ("", "2022")
    assert split_date_html(2020) == ("", "2020")
    assert split_date_html(Latex("a {b c} d")) == ('<code class="cv-latex">a {b c}</code>', '<code class="cv-latex">d</code>')
    assert split_date_html(None) == ("", "")


MARKUP = list("*[]()'\n \t#$%&_{}~^\\<>|`?!-ab1\"") + [
    "**", "***", "[a](", "](https://x.org/", "](javascript:x", ")", "  ", "    ", "''", "``", "\\*", "{date}",
]
markup = st.lists(st.sampled_from(MARKUP), max_size=14).map("".join)


# Both outputs as (text, bold, italic, link) runs, with "\n" for a line break and
# "\t" for \quad. Only the innermost link counts, as in the PDF.

_LATEX_CHARS = {
    "\\textbackslash{}": "\\", "\\ensuremath{\\sim}": "∼", "\\textasciicircum{}": "ˆ",
    "\\textless{}": "<", "\\textgreater{}": ">", "\\textbar{}": "|",
}


def latex_runs(tex: str) -> list[tuple[str, bool, bool, bool]]:
    """Parse the LaTeX that :func:`to_latex` writes for markup."""
    runs: list[tuple[str, bool, bool, bool]] = []
    text: list[str] = []
    marks = [(False, False, False)]

    def flush():
        if text:
            runs.append((html_render.tex_ligatures_text("".join(text)), *marks[-1]))
            text.clear()

    def group(b=None, i=None, link=None):
        flush()
        top = marks[-1]
        marks.append((top[0] if b is None else b, top[1] if i is None else i, top[2] if link is None else link))

    k = 0
    while k < len(tex):
        rest = tex[k:]
        hit = next((c for c in _LATEX_CHARS if rest.startswith(c)), None)
        if hit:
            flush()
            runs.append((_LATEX_CHARS[hit], *marks[-1]))
            k += len(hit)
        elif rest.startswith("\\textbf{"):
            group(b=True)
            k += 8
        elif rest.startswith("\\textit{"):
            group(i=True)
            k += 8
        elif rest.startswith("\\href{"):
            depth, j = 1, k + 6
            while depth:
                depth += {"{": 1, "}": -1}.get(tex[j], 0) if tex[j - 1] != "\\" or tex[j - 2] == "\\" else 0
                j += 1
            assert tex[j] == "{", tex
            group(link=True)
            k = j + 1
        elif rest.startswith("\\leavevmode"):
            k += 11
        elif rest.startswith("\\\\"):
            flush()
            runs.append(("\n", *marks[-1]))
            k += 2
        elif rest.startswith("\\quad"):
            flush()
            runs.append(("\t", *marks[-1]))
            k += 5
            while k < len(tex) and tex[k] == " ":
                k += 1
        elif rest.startswith("\\") and len(rest) > 1 and rest[1] in " {}#$%&_":
            flush()
            runs.append((rest[1], *marks[-1]))
            k += 2
        elif rest[0] == "{":
            group()
            k += 1
        elif rest[0] == "}":
            flush()
            marks.pop()
            k += 1
        else:
            assert rest[0] != "\\", f"unexpected command in {tex!r}"
            text.append("”" if rest[0] == '"' else rest[0])
            k += 1
    flush()
    assert len(marks) == 1, f"unbalanced braces in {tex!r}"
    return _normalize_runs(runs)


class _HtmlRuns(HTMLParser):
    def __init__(self, html: str):
        super().__init__(convert_charrefs=True)
        self.runs: list[tuple[str, bool, bool, bool]] = []
        self.stack: list[tuple[str, tuple[bool, bool, bool]]] = []
        self.marks = (False, False, False)
        self.feed(html)
        self.close()

    def handle_starttag(self, tag, attrs):
        classes = (dict(attrs).get("class") or "").split()
        if tag == "br":
            self.runs.append(("\n", *self.marks))
            return
        b, i, link = self.marks
        if tag == "a":
            assert not any(t == "a" for t, _ in self.stack), "a link inside a link"
        if tag == "span" and "cv-quad" in classes:
            self.runs.append(("\t", *self.marks))
        self.stack.append((tag, self.marks))
        self.marks = (b or tag == "strong", i or tag == "em", link or "cv-link" in classes)

    def handle_endtag(self, tag):
        open_tag, self.marks = self.stack.pop()
        assert open_tag == tag

    def handle_data(self, data):
        self.runs.append((data, *self.marks))


def html_runs(html: str) -> list[tuple[str, bool, bool, bool]]:
    return _normalize_runs(_HtmlRuns(html).runs)


def _normalize_runs(runs):
    chars = [(c, *m) for text, *m in runs for c in text]
    out = []
    for c, *m in chars:
        if c == " " and (not out or out[-1][0] in " \n"):
            continue  # one space per run; none at the start of a line
        if c == "\n" and out and out[-1][0] == " ":
            out.pop()
        out.append((c, *m))
    while out and out[-1][0] == " ":
        out.pop()
    return out


@settings(max_examples=2000 if FUZZ else 300, derandomize=not FUZZ)
@given(markup)
def test_html_and_latex_parse_alike(text):
    """Both outputs have the same characters with the same bold, italic and links."""
    assert html_runs(to_html(text, date="D")) == latex_runs(to_latex(text, date="D"))


@pytest.mark.parametrize(
    "text",
    ["**a *b* c**", "***x*** [*l* **m**](https://x.org) 'q *r*'", "a\nb  c    d\te", "[[a](https://u1.org) b](https://u2.org)",
     "[*x [y](https://u.org)*](https://v.org) z", "\\*\\[x\\] ~ ^ \\\\ \" `` ''", "-- --- 'it''s' {date}"],
)
def test_html_and_latex_parse_alike_examples(text):
    assert html_runs(to_html(text, date="D")) == latex_runs(to_latex(text, date="D"))


def test_structure_comparison_sees_differences():
    assert html_runs("<strong>a</strong>b") != latex_runs("\\textbf{ab}")
    assert html_runs("<em>a</em>") != latex_runs("\\textbf{a}")
    assert html_runs("a<br>b") != latex_runs("ab")
    assert html_runs("ab") != latex_runs("ba")


# -- safety

HOSTILE = [
    "<script>alert(1)</script>", '"onload="alert(1)', "'onerror='x", "javascript:alert(1)", "JAVASCRIPT:x",
    "&amp;", "&#x3c;script&#x3e;", "&lt;b&gt;", "</div>", "<!--", "-->", "<![CDATA[", "\x00", "\x01", "\x0b",
    "\r", "\n", "\x7f", "\x85", " ", "﻿", "\U0001F600", "*", "**", "[", "](", ")", "](javascript:x)",
    "](data:text/html,x)", "](https://x.org/\"><script>)", "{date}", "\\", "'", "`", "a", " ", "\t",
    "<svg onload=x>", "style=x", "{latex:", "%", "#",
]
hostile = st.lists(st.sampled_from(HOSTILE), min_size=1, max_size=8).map("".join)
hostile_value = st.one_of(hostile, hostile.map(lambda s: {"latex": s}))
hostile_url = st.one_of(hostile, hostile.map(lambda s: "https://x.org/" + s))


@st.composite
def hostile_documents(draw):
    v = lambda: draw(hostile_value)  # noqa: E731
    entry = lambda: {  # noqa: E731
        "title": v(), "date": v(), "subtitle": v(), "note": v(), "location": v(),
        "details": [v(), v()], "bullets": [v(), v()],
    }
    data = {
        "version": 2,
        "name": v(),
        "date": draw(st.one_of(st.just("auto"), hostile_value)),
        "contact": [
            [{"url": draw(hostile_url)}, {"orcid": draw(hostile)}, {"linkedin": draw(hostile_url)},
             {"github": draw(hostile_url)}, {"twitter": draw(hostile_url)}, v(), draw(hostile) + "{date}"],
            {"items": [v(), {"url": draw(hostile_url)}], "separator": v()},
        ],
        "sections": [
            {"title": v(), "layout": "entries", "description": v(), "entries": [entry()]},
            {"title": v(), "layout": "entries-inline", "description": v(), "entries": [entry()]},
            {"title": v(), "layout": "list", "description": v(), "entries": [v(), {"text": v(), "bullets": [v()]}]},
            {"title": v(), "layout": "pairs", "description": v(), "entries": [{"title": v(), "text": v()}]},
            {"title": v(), "layout": "dated", "description": v(), "entries": [v(), {"date": v(), "text": v()}]},
            "newpage",
            {"title": v(), "layout": "text", "description": v(), "entries": [v(), {"text": v()}]},
        ],
    }
    return data


def _publication(draw) -> Publication:
    h = lambda: draw(hostile)  # noqa: E731
    return Publication(
        key=h(), authors=(Author(h(), True), Author(h(), False)), title=h(), venue=h(), year=h(),
        url=draw(hostile_url),
    )


@settings(max_examples=400 if FUZZ else 40, derandomize=not FUZZ, suppress_health_check=[HealthCheck.too_slow],
          deadline=None)
@given(st.data())
def test_hostile_input_cannot_inject_html(data):
    doc_data = data.draw(hostile_documents())
    doc = model.from_data(doc_data, Path("."), "v2")
    pubs = model.Section("publications", title=model._text(data.draw(hostile_value)), path=("sections", 7))
    pubs.publications = [_publication(data.draw) for _ in range(2)]
    doc.sections.append(pubs)
    result = api.render_html(doc, today=TODAY)

    parsed = Elements(result.html)
    for tag, attrs in parsed.elements:
        assert tag in ALLOWED_TAGS, tag
        assert set(attrs) <= ALLOWED_ATTRS, (tag, attrs)
        if "href" in attrs:
            assert SAFE_HREF.match(attrs["href"]), attrs["href"]
        if tag == "path" or tag == "svg":
            assert "data-path" not in attrs
    # Every editable value reads back exactly from data-raw.
    for attrs in parsed.with_attr("data-path"):
        assert attrs["data-raw"] == walk(doc_data, attrs["data-path"]), attrs["data-path"]


def test_no_raw_html_passthrough():
    assert "<script>" not in to_html("<script>x</script>")
    assert to_html(Latex("<b>x</b>")) == '<code class="cv-latex">&lt;b&gt;x&lt;/b&gt;</code>'
    assert html_render.citation_html(Publication("k", (Author("<i>A</i>", True),), "<b>T</b>", None, "2020",
                                                 "javascript:x")) == (
        "<strong>&lt;i&gt;A&lt;/i&gt;</strong>, <em>&lt;b&gt;T&lt;/b&gt;</em>, 2020 <span class=\"cv-link\">[Link]</span>."
    )


# -- bib


@pytest.mark.parametrize(
    "latex, text",
    [
        ("{TOP*} in Jos{\\'e}", "TOP* in José"),
        ("\\emph{Foo} 30\\% \\& \\_", "Foo 30% & _"),
        ("Plain title", "Plain title"),
        ("$\\alpha$-test", "α-test"),
    ],
)
def test_bib_text(latex, text):
    assert html_render.bib_text(latex) == text


def test_citation_layout_matches_latex():
    pub = Publication("k", (Author("Jane Roe", True), Author("John Doe", False), Author("A. B", False)),
                      "Another 'Paper'", "Journal", "2024", "https://x.org/p")
    assert html_render.citation_html(pub) == (
        "<strong>Jane Roe</strong>, John Doe and A. B, <em>Another ’Paper’</em>, Journal, 2024 "
        '<a class="cv-link" href="https://x.org/p">[Link]</a>.'
    )


# -- API


def test_api_surface():
    result = render(EXAMPLE)
    page = result.standalone(title="<x>", font_url="/fonts")
    assert page.startswith("<!doctype html>") and "<title>&lt;x&gt;</title>" in page
    assert 'url("/fonts/cmunrm.woff2") format("woff2")' in page
    assert result.css in page and result.html in page
    css = html_render.font_face_css("fonts/", "otf")
    assert [m for m in re.findall(r"fonts/([\w-]+)\.otf", css)] == [f[3] for f in html_render.FONT_FILES]
    assert '"CMU Serif"' in result.css and '"CMU Typewriter Text"' in result.css
    assert api.split_path("sections.2.entries.0.bullets.1") == ("sections", 2, "entries", 0, "bullets", 1)
    assert api.split_path("") == ()
    assert html_render.dotted(("contact", 0, "items", 1)) == "contact.0.items.1"


def test_today_defaults_to_the_current_date():
    # Read the date on both sides of the render, so a render across midnight passes.
    before = datetime.date.today()
    html = api.render_html(api.load(EXAMPLE)).html
    after = datetime.date.today()
    assert any(html_render.auto_date_html(day) in html for day in {before, after})


def test_today_is_read_at_render_time(monkeypatch):
    class Day(datetime.date):
        @classmethod
        def today(cls):
            return cls(2030, 2, 1)

    monkeypatch.setattr(html_render._dt, "date", Day)
    assert "1<sup>st</sup> February 2030" in api.render_html(api.load(EXAMPLE)).html


def test_model_paths_do_not_change_equality():
    a = model.from_data({"name": "x", "sections": [{"title": "t", "layout": "text", "entries": ["a"]}]}, Path("."))
    b = model.from_data({"name": "x", "sections": [{"title": "t", "layout": "text", "entries": ["a"]}]}, Path("."), "v1")
    assert a.sections == b.sections and a.contact == b.contact
    assert a.sections[0].entries[0].paths == {"text": ("sections", 0, "entries", 0)}
    assert b.sections[0].entries[0].paths == {} and b.paths == {}


# -- text parity


def words(text: str) -> Counter:
    text = unicodedata.normalize("NFKC", text).casefold().replace("_", " ")
    return Counter(re.findall(r"\w+", text))


def pdftotext(pdf: bytes) -> str:
    out = subprocess.run(["pdftotext", "-", "-"], input=pdf, capture_output=True, check=True).stdout.decode()
    return re.sub(r"-\s*\n\s*", "", out)


@pytest.mark.tex
@pytest.mark.parametrize("path", V2_CASES + [EXAMPLE], ids=lambda p: p.stem if p != EXAMPLE else "example")
def test_text_matches_the_pdf(path):
    """The words of the preview are the words of the PDF, except inside raw LaTeX."""
    doc = api.load(path)
    parsed = Elements(api.render_html(doc, today=TODAY).html)
    pdf = words(pdftotext(compile_result(api.render_tex(doc))))
    # pdftotext reads the FontAwesome twitter glyph as "7"; the preview draws an SVG.
    pdf -= Counter({"7": sum(item.kind == "twitter" for line in doc.contact for item in line.items)})
    shown = words("".join(parsed.text))
    latex = words("".join(parsed.latex_text))
    extra, missing = shown - pdf, pdf - shown - latex
    # pdftotext joins words that touch on the page ("Early2021").
    joined = pdf - shown
    assert chars(extra) <= chars(joined), f"in the preview but not in the PDF: {extra}"
    assert chars(missing) <= chars(extra) + chars(latex), f"in the PDF but not in the preview: {missing}"
    assert sum(extra.values()) <= 2 * sum(joined.values()), (extra, joined)


def chars(counter: Counter) -> Counter:
    return Counter("".join(w * n for w, n in counter.items()))


# -- aliases and merge keys

ALIASES = FIXTURES / "aliases" / "cv.yaml"


def _by(parsed: Elements, name: str, value: str) -> list[dict]:
    return [a for a in parsed.with_attr(name) if a[name] == value]


def test_values_through_aliases_are_read_only_and_anchors_are_marked():
    parsed = Elements(render(ALIASES).html)
    paths = {a["data-path"]: a for a in parsed.with_attr("data-path")}
    # Anchored scalars: name is &nm, used by *nm in a contact line.
    assert paths["name"]["data-anchor"] == "nm"
    nm = _by(parsed, "data-via-alias", "nm")
    assert len(nm) == 1 and "data-path" not in nm[0] and "data-raw" not in nm[0]
    assert paths["sections.0.title"]["data-anchor"] == "t"
    assert len(_by(parsed, "data-via-alias", "t")) == 1  # title: *t
    # Whole-entry alias (- *base) and merge key with an override (<<: *base, date: 2025).
    for field in ("title", "date", "subtitle", "note"):
        assert paths[f"sections.0.entries.0.{field}"]["data-anchor"] == "base"
        assert f"sections.0.entries.2.{field}" not in paths
    assert "sections.0.entries.1.title" not in paths
    assert "data-anchor" not in paths["sections.0.entries.1.date"]  # the override is the entry's own
    assert paths["sections.0.entries.1.date"]["data-raw"] == "2025"
    # 4 values of entries 1 and 2 come from &base (the date of entry 1 is its own).
    assert len(_by(parsed, "data-via-alias", "base")) == 3 + 4 + 1  # + the entry element of - *base
    # List alias (bullets: *bl); the copies name the innermost anchor, &bl, also through *base.
    assert paths["sections.0.entries.0.bullets.0"]["data-anchor"] == "bl"
    assert len([a for a in _by(parsed, "data-via-alias", "bl") if "class" in a]) == 6
    # Section alias (- *sec): the section and everything in it.
    section = _by(parsed, "data-section", "sections.4")
    assert section and section[0]["data-via-alias"] == "sec"
    assert not any(p.startswith("sections.4.") for p in paths)
    assert all("data-anchor" in a for p, a in paths.items() if p.startswith("sections.2."))
    # Every element with a value has exactly one of data-path and data-via-alias.
    for _, a in parsed.elements:
        assert not ("data-path" in a and "data-via-alias" in a)
        assert "data-raw" not in a or "data-path" in a


def test_items_inside_an_alias_have_no_structural_path():
    parsed = Elements(render(ALIASES).html)
    entries = [a["data-entry"] for a in parsed.with_attr("data-entry")]
    # The entry that is itself an alias keeps its path (moving or deleting it is
    # safe); the entries inside the aliased section have none.
    assert "sections.0.entries.2" in entries
    assert _by(parsed, "data-entry", "sections.0.entries.2")[0]["data-via-alias"] == "base"
    assert _by(parsed, "data-entry", "sections.0.entries.0")[0]["data-anchor"] == "base"
    assert not any(e.startswith("sections.4.") for e in entries)
    rows = [a for t, a in parsed.elements if "cv-dated-row" in (a.get("class") or "")]
    assert [r.get("data-via-alias") for r in rows] == [None] * 3 + ["sec"] * 3
    assert all("data-anchor" in r for r in rows[:3])


def test_alias_attributes_follow_every_printed_value():
    """Every value under an alias or merge key has data-via-alias, every other one its path."""
    src = load_text(ALIASES.read_text(encoding="utf-8"), str(ALIASES))
    parsed = Elements(render(ALIASES).html)
    printed = printed_paths(src.data)
    expected = Counter({p: n for p, n in printed.items() if api.split_path(p) not in src.aliases})
    assert Counter(a["data-path"] for a in parsed.with_attr("data-path")) == expected
    via = sum(n for p, n in printed.items() if api.split_path(p) in src.aliases)
    values = [a for a in parsed.with_attr("data-via-alias") if "data-entry" not in a and "data-section" not in a
              and "cv-dated-row" not in a.get("class", "")]
    assert len(values) == via


# -- v1 files


@pytest.mark.parametrize("path", sorted((FIXTURES / "v1").glob("*/cv.yaml")), ids=lambda p: p.parent.name)
def test_v1_values_render_as_text(path):
    html = api.render_html(api.load(path), today=TODAY).html
    assert "cv-latex" not in html
    Elements(html)


def test_v1_markup_is_decoded():
    path = FIXTURES / "v1" / "master-example" / "cv.yaml"
    html = api.render_html(api.load(path), today=TODAY).html.replace(html_render.SP, " ")
    assert '<span class="cv-subtitle">Bachelor of Science in <em>Computer Science</em></span>' in html
    assert ('<em>An Exploration of <a class="cv-link" href="https://en.wikipedia.org/wiki/Quantum_computing">'
            "“Quantum Computing”</a> in Virtual Environments</em>") in html
    assert '<a class="cv-url" href="https://www.johndoeportfolio.com">https://www.johndoeportfolio.com</a>' in html
    assert 'href="https://orcid.org/0000-0000-0000-0000"' in html and "<svg" in html


@pytest.mark.parametrize(
    "latex, html",
    [
        ("\\textbf{a \\textit{b}} \\emph{c}", "<strong>a <em>b</em></strong> <em>c</em>"),
        ("a\\\\b\\newline c\\quad d\\ e", 'a<br>b<br>c<span class="cv-quad"></span>d e'),
        ("50\\% \\& \\$ \\# \\_ \\{x\\} \\textbackslash{} $\\alpha$ \\ensuremath{\\sim} ``q'' --",
         "50% &amp; $ # _ {x} \\ α ∼ “q” –"),
        ("\\href{https://x.org/a\\_b}{t} \\url{https://y.org}",
         '<a class="cv-link" href="https://x.org/a_b">t</a> <a class="cv-link" href="https://y.org">https://y.org</a>'),
        ("\\href{javascript:x}{t}", '<span class="cv-link">t</span>'),
        ("<b>&</b> \\textbf x", "&lt;b&gt;&amp;&lt;/b&gt; \\textbf x"),
        ("\\href{https://a.org}{\\href{https://b.org}{x} y}",
         '<a class="cv-link" href="https://b.org">x</a><a class="cv-link" href="https://a.org"> y</a>'),
    ],
)
def test_latex_text_html(latex, html):
    assert html_render.latex_text_html(latex) == html


def test_bib_text_decodes_text_commands():
    assert html_render.bib_text("a \\textbackslash{} b \\textless{}c\\textgreater{} \\textbar{} \\LaTeX{}") == "a \\ b <c> | LaTeX"


# -- pages


@pytest.mark.parametrize(
    "items, boxes, starts",
    [
        (["newpage", "A", "newpage", "newpage", "B", "newpage"], [["A"], ["B"]], ["0", "2"]),
        (["A", "newpage", "newpage", "newpage"], [], []),
        (["newpage", "newpage", "A"], [["A"]], ["0"]),
        (["A", "newpage", "B"], [["B"]], ["1"]),
        (["newpage"], [], []),
    ],
)
def test_newpage_on_an_empty_page_starts_no_box(items, boxes, starts):
    """TeX ignores \\newpage on an empty page; the first page has the name."""
    sections = [i if i == "newpage" else {"title": i, "layout": "text", "entries": [i.lower()]} for i in items]
    doc = api.loads(yaml.safe_dump({"version": 2, "name": "N", "sections": sections}))
    result = api.render_html(doc, today=TODAY)
    pages = result.html.split('<div class="cv-page"')[1:]
    titles = [re.findall(r'class="cv-section-title"[^>]*>([^<]*)<', page) for page in pages]
    assert result.pages == len(pages) == 1 + len(boxes)
    assert titles[1:] == boxes
    # Each box after the first names the newpage item that starts it.
    assert [re.match(r' data-newpage="sections\.(\d+)"', p).group(1) for p in pages[1:]] == starts


@pytest.mark.tex
def test_page_boxes_match_the_pdf_page_count():
    for items in (["newpage", "A", "newpage", "newpage", "B", "newpage"], ["newpage", "newpage", "A"]):
        sections = [i if i == "newpage" else {"title": i, "layout": "text", "entries": ["x"]} for i in items]
        doc = api.loads(yaml.safe_dump({"version": 2, "name": "N", "sections": sections}))
        assert api.render_html(doc, today=TODAY).pages == page_count(compile_result(api.render_tex(doc)))


# -- nested links


def test_nested_links_become_sibling_links():
    # In the PDF the inner link lies on top of the outer one: "inner" opens
    # u1 and " mid" opens u2. HTML cannot nest <a>, so the outer link is split.
    assert to_html("pre [[inner](https://u1.org) mid](https://u2.org) post") == (
        'pre <a class="cv-link" href="https://u1.org">inner</a><a class="cv-link" href="https://u2.org"> mid</a> post'
    )
    assert to_html("[**a [b](https://u1.org) c**](https://u2.org)") == (
        '<a class="cv-link" href="https://u2.org"><strong>a </strong></a>'
        '<strong><a class="cv-link" href="https://u1.org">b</a></strong>'
        '<a class="cv-link" href="https://u2.org"><strong> c</strong></a>'
    )
    assert to_html("[[[a](https://u1.org)](https://u2.org)](https://u3.org)") == (
        '<a class="cv-link" href="https://u1.org">a</a>'
    )
    # An unsafe link prints as text, which may hold a link.
    assert to_html("[[a](https://u1.org) b](javascript:x)") == (
        '<span class="cv-link"><a class="cv-link" href="https://u1.org">a</a> b</span>'
    )


def test_a_link_in_the_date_inside_a_link_is_not_nested():
    doc = api.loads('version: 2\nname: N\ndate: "[d](https://d.org)"\ncontact: [["[{date} x](https://u.org)"]]\n')
    parsed = Elements(api.render_html(doc, today=TODAY).html)  # asserts balanced elements
    links = [a["href"] for t, a in parsed.elements if t == "a"]
    # The date is all link, so the outer link wraps only " x".
    assert links == ["https://d.org", "https://u.org"]


@pytest.mark.tex
def test_nested_links_match_the_pdf_annotations():
    from pypdf import PdfReader

    doc = api.loads('version: 2\nname: N\nsections:\n  - {title: T, layout: text, entries: '
                    '["[[inner](https://u1.org) mid](https://u2.org)"]}\n')
    reader = PdfReader(io.BytesIO(compile_result(api.render_tex(doc))))
    annots = [a.get_object() for a in reader.pages[0]["/Annots"]]
    rects = {a["/A"]["/URI"]: [float(x) for x in a["/Rect"]] for a in annots}
    # The inner link is written last (on top) and covers only "inner".
    assert [a["/A"]["/URI"] for a in annots] == ["https://u2.org", "https://u1.org"]
    assert rects["https://u1.org"][2] < rects["https://u2.org"][2]


# -- fonts, cache


def test_tilde_prints_with_a_font_that_has_the_glyph():
    # CMU has no math-axis tilde, so ∼ comes from Latin Modern Math.
    assert to_html("a~b") == "a∼b"
    css = html_render.font_face_css("/fonts/")
    rule = next(r for r in css.splitlines() if "latinmodern-math" in r)
    assert '"Latin Modern Math"' in rule and "U+223C" in rule
    serif = re.search(r"--cv-serif: ([^;]+);", html_render.stylesheet()).group(1)
    assert serif.startswith('"CMU Serif", "Latin Modern Math",')
    mono = re.search(r"--cv-mono: ([^;]+);", html_render.stylesheet()).group(1)
    assert mono.startswith('"CMU Typewriter Text", "Latin Modern Math",')


def font_range() -> set[int]:
    covered = set()
    for part in html_render.FONT_RANGES["latinmodern-math"].split(", "):
        lo, _, hi = part[2:].partition("-")
        covered |= set(range(int(lo, 16), int(hi or lo, 16) + 1))
    return covered


def test_font_ranges_cover_the_math_characters():
    for c in "∼≤≥≈↔⇒∞∈∉⊂∑∏∂∇ϖϕϱ":
        assert ord(c) in font_range(), c


def test_font_ranges_hold_exactly_the_characters_cmu_lacks():
    names = ("cmunrm", "cmunbx", "cmunti", "cmunbi", "cmuntt")
    paths = {n: tex_font(n) for n in (*names, "latinmodern-math")}
    if not all(paths.values()):
        pytest.skip("the CMU and Latin Modern Math fonts of TeX Live are not installed")
    faces = {n: font_cmap(paths[n]) for n in names}
    math = font_cmap(paths["latinmodern-math"])

    def prints(c: int, face: set[int]) -> bool:
        # Browsers compose a character the font lacks (≠, Ģ) from its decomposition.
        parts = unicodedata.normalize("NFD", chr(c))
        return c in face or (len(parts) > 1 and all(ord(p) in face for p in parts))

    covered = font_range()
    for c in covered:
        assert c in math and not all(prints(c, face) for face in faces.values()), chr(c)
    assert ord("ϕ") in faces["cmunrm"] and ord("ϕ") not in faces["cmunti"]
    unicode_txt = (ROOT / "src" / "cv_tools" / "templates" / "latex" / "unicode.txt").read_text(encoding="utf-8")
    printed = [int(line.split()[0], 16) for line in unicode_txt.splitlines() if line and not line.startswith("#")]
    for c in printed:
        if c in math and c not in covered and unicodedata.category(chr(c)) != "Cf":
            for name, face in faces.items():
                assert prints(c, face), f"{chr(c)} (U+{c:04X}) is missing from {name} and FONT_RANGES"


def test_equal_numbers_that_print_differently_do_not_share_a_cache_entry():
    a = api.render_html(model.from_data({"name": 0.0, "sections": []}, Path(".")), today=TODAY).html
    b = api.render_html(model.from_data({"name": -0.0, "sections": []}, Path(".")), today=TODAY).html
    c = api.render_html(model.from_data({"name": 0.0, "sections": []}, Path(".")), today=TODAY).html
    assert ">0.0</h1>" in a and ">-0.0</h1>" in b and a == c


# -- layout


def test_two_sided_lines_are_inline_text_with_a_filler():
    html = render(FIXTURES / "v2" / "long-lines.yaml").html
    line = re.search(r'<div class="cv-line"><span class="cv-head">.*?</div>', html).group()
    # The left part, the filler and the right part are inline; every space of
    # the line except the filler's is a non-stretching span.cv-sp.
    assert '</span><span class="cv-hfill"> </span><em class="cv-date cv-right"' in line
    text = re.sub(r"<[^>]+>", "", line.replace(html_render.SP, "_").replace(html_render.HFILL, "|"))
    assert " " not in text and text.count("|") == 1
    assert text.startswith("Department_of_Theoretical") and text.endswith("|Sep._2019_–_Aug._2024")
    pair = re.search(r'<div class="cv-pair cv-line".*?</div>', html).group()
    assert '<span class="cv-pair-title"><span class="cv-title"' in pair and html_render.HFILL in pair
    css = html_render.stylesheet()
    rule = re.search(r"\.cv-document \.cv-line \{([^}]*)\}", css).group(1)
    assert "text-align: justify" in rule and "text-align-last: justify" in rule and "flex" not in rule
    assert re.search(r"\.cv-sp \{[^}]*display: inline-block;[^}]*white-space: pre;", css)


def test_a_note_without_subtitle_has_no_filler():
    html = render(FIXTURES / "v2" / "long-lines.yaml").html
    assert ('<div class="cv-line"><span class="cv-note" data-path="sections.0.entries.2.note"'
            in html)


def test_wide_contact_lines_overflow_both_margins():
    css = html_render.stylesheet()
    contact = re.search(r"\.cv-document \.cv-contact \{([^}]*)\}", css).group(1)
    assert "margin: 0 -100%" in contact and "text-align: center" in contact and "nowrap" in contact
    page = re.search(r"\.cv-document \.cv-page \{([^}]*)\}", css).group(1)
    assert "overflow-x: clip" in page


# -- robustness


def test_a_value_under_an_alias_key_has_no_path():
    text = ("version: 2\nname: N\nsections:\n  - &t title: A\n    layout: text\n    entries: [x]\n"
            "  - *t : B\n    layout: text\n    entries: [y]\n")
    html = api.render_html(api.loads(text), today=TODAY).html
    assert '<h2 class="cv-section-title" data-via-alias="t">B</h2>' in html
    assert 'data-path="sections.1.title"' not in html


V1_DEEP = 'heading:\n  name: N\nsections:\n  - type: bullets\n    title: T\n    content:\n      - item: "{}"\n'


@pytest.mark.parametrize("depth", [40, 3000])
def test_deeply_nested_v1_latex_renders(depth):
    doc = api.loads(V1_DEEP.format("\\\\textbf{" * depth + "x \\\\href{https://u.org}{y}" + "}" * depth))
    html = api.render_html(doc, today=TODAY).html
    assert "x y" in re.sub(r"<[^>]*>", "", html) and "textbf" not in html and "href{" not in html


@pytest.mark.parametrize("value", [
    "*[" * 1000 + "x" + "](https://u.org)*" * 1000,
    "[" * 3000 + "x" + "](https://u.org)" * 3000,
    "**" * 1000 + "x" + "**" * 1000,
])
def test_deeply_nested_markup_renders(value):
    doc = api.loads(yaml.safe_dump({"version": 2, "name": "N", "sections": [
        {"title": "T", "layout": "text", "entries": [value]}]}, width=10**6))
    assert "x" in api.render_html(doc, today=TODAY).html
    assert "x" in api.render_tex(doc).tex


@pytest.mark.parametrize("latex, html", [
    ("by 30% through", "by 30"),
    ("a % note\n  b", "a b"),
    ("x\\\\[2pt]y", "x<br>y"),
    ("x\\\\*[1em] y", "x<br> y"),
    ("x\\\\ y", "x<br> y"),
    ("a\\~b", "ab̃"),
    ("a\\~{}b", "a˜b"),
    ("a\\%b", "a%b"),
])
def test_v1_preview_reads_comments_line_breaks_and_accents(latex, html):
    assert html_render.latex_text_html(latex) == html
