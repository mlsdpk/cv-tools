"""The HTML live preview of the web app, styled to look like the PDF.

All input is untrusted: text is escaped and only http, https and mailto links are emitted.
"""

from __future__ import annotations

import codecs
import datetime as _dt
import functools
import re
import unicodedata
from dataclasses import dataclass
from importlib import resources
from typing import Any, Optional, Union

import jinja2
from markupsafe import Markup, escape

from ..bib import Publication
from ..loader import YamlPath
from ..markup import (
    MAX_NESTING, Latex, Text, _last_split_space, _split_link, escape_html, latex_html, safe_url, split_date_html,
    tex_ligatures_text, to_html,
)
from ..model import ICON_KINDS, ContactItem, ContactLine, Document, Entry, Section

TEMPLATE_DIR = resources.files("cv_tools") / "templates" / "html"

# (CSS family, weight, style, file name) of the fonts the web app self-hosts.
FONT_FILES = (
    ("CMU Serif", "normal", "normal", "cmunrm"),
    ("CMU Serif", "bold", "normal", "cmunbx"),
    ("CMU Serif", "normal", "italic", "cmunti"),
    ("CMU Serif", "bold", "italic", "cmunbi"),
    ("CMU Typewriter Text", "normal", "normal", "cmuntt"),
    ("Latin Modern Math", "normal", "normal", "latinmodern-math"),
)

# Characters pdflatex prints that some CMU face lacks and cannot compose,
# taken from Latin Modern Math (downloaded only when a document uses one).
FONT_RANGES = {
    "latinmodern-math": "U+03D5-03D6, U+03F1, U+2015, U+2194, U+21D2, U+2202, U+2207-2209, U+220F, U+2211, U+221E, "
                        "U+223C, U+2248, U+2264-2265, U+2282, U+25EF, U+27E8-27E9",
}

# The icons are the paths of orcid.pdf and the FontAwesome 4 glyphs of resume.cls
# (SIL OFL 1.1), with the glyph's advance width by one em as view box.
ICON_LABELS = {"orcid": "ORCID iD", "linkedin": "LinkedIn", "github": "GitHub", "twitter": "Twitter"}

_MONTHS = ("January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December")

_env: Optional[jinja2.Environment] = None
_css: Optional[str] = None

# The app renders on every keystroke. Equal values can print differently
# (0.0 and -0.0), so the key also has the type and repr.
@functools.lru_cache(maxsize=4096)
def _to_html_cached(kind: type, key: str, value: Text, date: Optional[str]) -> str:
    return to_html(value, date=date)


def _to_html(value: Text, date: Optional[str] = None) -> str:
    return _to_html_cached(type(value), repr(value), value, date)


def clear_caches() -> None:
    """Empty the conversion caches."""
    _to_html_cached.cache_clear()
    _rigid.cache_clear()
    latex_text_html.cache_clear()
    citation_html.cache_clear()


_to_html.cache_clear = clear_caches  # type: ignore[attr-defined]


@dataclass
class HtmlResult:
    """The rendered preview; ``editable`` is True for a v2 file, whose elements carry ``data-path``."""

    html: str
    css: str
    pages: int
    editable: bool

    def standalone(self, title: str = "CV preview", font_url: Optional[str] = None) -> str:
        """A complete HTML page with the stylesheet inlined, and the fonts from ``font_url`` if given."""
        fonts = font_face_css(font_url) if font_url is not None else ""
        return (
            '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f"<title>{escape(title)}</title>\n<style>\n{fonts}{self.css}"
            "body { margin: 0; padding: 0.25in 0; background: #d9d9d9; }\n"
            f"</style>\n</head>\n<body>\n{self.html}\n</body>\n</html>\n"
        )


def font_face_css(font_url: str, extension: str = "woff2") -> str:
    """``@font-face`` rules for :data:`FONT_FILES`, served from the directory or URL prefix ``font_url``."""
    base = font_url if font_url.endswith("/") or not font_url else font_url + "/"
    formats = {"woff2": "woff2", "woff": "woff", "otf": "opentype", "ttf": "truetype"}
    out = []
    for family, weight, style, name in FONT_FILES:
        url = str(escape(f"{base}{name}.{extension}"))
        unicode_range = f" unicode-range: {FONT_RANGES[name]};" if name in FONT_RANGES else ""
        out.append(
            f'@font-face {{ font-family: "{family}"; font-weight: {weight}; font-style: {style}; '
            f'font-display: swap; src: url("{url}") format("{formats.get(extension, extension)}");{unicode_range} }}\n'
        )
    return "".join(out)


def stylesheet() -> str:
    """The preview stylesheet."""
    global _css
    if _css is None:
        _css = (TEMPLATE_DIR / "cv.css").read_text(encoding="utf-8")
    return _css


def _environment() -> jinja2.Environment:
    global _env
    if _env is None:
        _env = jinja2.Environment(
            loader=jinja2.PackageLoader("cv_tools", "templates/html"),
            autoescape=True,
            undefined=jinja2.StrictUndefined,
            trim_blocks=True,
            lstrip_blocks=True,
        )
        _env.globals.update(ICON_LABELS=ICON_LABELS, field=_field_html, SP=Markup(SP), HFILL=HFILL)
    return _env


def render(doc: Document, today: Optional[_dt.date] = None) -> HtmlResult:
    """Render the preview. ``today`` is the date printed for ``date: auto``."""
    view = _View(doc, today or _dt.date.today())
    pages = view.pages()
    html = _environment().get_template("cv.html.jinja").render(
        source_format=doc.source_format,
        editable=view.editable,
        name=view.field(doc.name, doc.paths.get("name")),
        contact=[view.contact_line(line) for line in doc.contact],
        pages=pages,
    )
    return HtmlResult(html, stylesheet(), len(pages), view.editable)


def auto_date_html(day: _dt.date) -> str:
    """``\\customdate\\today`` of resume.cls: "14<sup>th</sup> November 2023"."""
    n = day.day
    suffix = "th" if 11 <= n % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}<sup>{suffix}</sup> {_MONTHS[day.month - 1]} {day.year}"


def dotted(path: Optional[YamlPath]) -> Optional[str]:
    """``("sections", 2, "title")`` -> ``"sections.2.title"``."""
    return None if path is None else ".".join(str(p) for p in path)


def split_path(path: str) -> tuple[Union[str, int], ...]:
    """``"sections.2.title"`` -> ``("sections", 2, "title")``; v2 keys are words, so digits are an index."""
    return tuple(int(p) if p.isdigit() else p for p in path.split(".")) if path else ()


def _field_html(tag: str, cls: str, v: Optional[dict]) -> Markup:
    if v is None:
        return Markup("")
    return Markup(f'<{tag} class="{escape(cls)}"{v["attrs"]}>{v["html"]}</{tag}>')


# A two-sided line ("left \hfill right") is justified text whose only
# stretchable space is span.cv-hfill; every other space is a rigid span.cv-sp.

SP = '<span class="cv-sp"> </span>'
HFILL = Markup('<span class="cv-hfill"> </span>')
_TEXT_SPACES = re.compile(r'(<code class="cv-latex">[^<]*</code>|<[^>]*>)')


@functools.lru_cache(maxsize=4096)
def _rigid(html: str) -> str:
    if " " not in html:
        return html
    parts = _TEXT_SPACES.split(html)
    for i in range(0, len(parts), 2):
        if " " in parts[i]:
            parts[i] = parts[i].replace(" ", SP)
    return "".join(parts)


def _value_attrs(path: Optional[str], raw: Optional[Markup], latex: bool,
                 via: Optional[str], anchor: Optional[str]) -> Markup:
    # Setting a value by path through an alias would change the anchored
    # original, so such a value gets data-via-alias instead (web-spec 4.3).
    if via is not None:
        return Markup(f' data-via-alias="{escape(via)}"')
    if path is None:
        return Markup("")
    out = f' data-path="{escape(path)}" data-raw="{raw}"' + (" data-latex" if latex else "")
    if anchor is not None:
        out += f' data-anchor="{escape(anchor)}"'
    return Markup(out)


def _raw(value: Text) -> str:
    return value.latex if isinstance(value, Latex) else str(value)


def _attr(text: str) -> Markup:
    # HTML reads a raw carriage return in an attribute back as a line feed.
    return Markup(str(escape(text)).replace("\r", "&#13;"))


class _View:

    def __init__(self, doc: Document, today: _dt.date):
        self.doc = doc
        self.editable = doc.source_format == "v2"
        self.decode = doc.source_format == "v1"
        self.date_html = self._date(doc, today)

    def html(self, value: Text, date: Optional[str] = None) -> str:
        if self.decode and isinstance(value, Latex):
            return latex_text_html(value.latex)
        return _to_html(value, date=date)

    def field(self, value: Optional[Text], path: Optional[YamlPath], date: Optional[str] = None,
              rigid: bool = False) -> Optional[dict]:
        if value is None:
            return None
        html = self.html(value, date=date)
        if rigid:
            html = _rigid(html)
        latex = isinstance(value, Latex) and not self.decode
        out: dict[str, Any] = {"html": Markup(html), "path": None, "latex": latex, "attrs": Markup("")}
        if self.editable and path is not None:
            source = path + ("latex",) if latex else path
            via = self.doc.aliases.get(source)
            if via is None:
                out["path"] = dotted(source)
            out["attrs"] = _value_attrs(out["path"], _attr(_raw(value)), latex, via, self.doc.anchors.get(source))
        return out

    def where(self, name: str, path: Optional[YamlPath]) -> Markup:
        # An item that is an alias (- *x) can be moved, so it keeps its path;
        # an item inside aliased content has none of its own.
        if not self.editable or path is None:
            return Markup("")
        aliases = self.doc.aliases
        if path[:-1] in aliases:
            return Markup(f' data-via-alias="{escape(aliases[path[:-1]])}"')
        out = f' {name}="{escape(dotted(path))}"'
        if path in aliases:
            out += f' data-via-alias="{escape(aliases[path])}"'
        elif path in self.doc.anchors:
            out += f' data-anchor="{escape(self.doc.anchors[path])}"'
        return Markup(out)

    def _date(self, doc: Document, today: _dt.date) -> str:
        if doc.date == "auto":
            inner = auto_date_html(today)
        else:
            inner = self.html(doc.date)
        v = self.field(doc.date, doc.paths.get("date")) if doc.date != "auto" or "date" in doc.paths else None
        return f'<span class="cv-date-value"{v["attrs"] if v else ""}>{inner}</span>'

    def contact_line(self, line: ContactLine) -> dict:
        items = []
        for i, item in enumerate(line.items):
            joiner = None
            if i:
                if item.kind in ICON_KINDS:
                    joiner = "space"
                else:
                    joiner = self.field(line.separator, line.separator_path) or {}
            items.append({"joiner": joiner, **self.contact_item(item)})
        return {"where": self.where("data-contact", line.path), "items": items}

    def contact_item(self, item: ContactItem) -> dict:
        if item.kind == "text":
            return {"kind": "text", "field": self.field(item.value, item.path, date=self.date_html)}
        value = item.value
        href = None
        address: Optional[str] = None
        if not isinstance(value, Latex):
            address = str(value)
        elif self.decode:
            address = latex_url(value.latex)
        if address is not None:
            href = safe_url("https://orcid.org/" + address if item.kind == "orcid" else address)
        field = self.field(value, item.path)
        if item.kind == "url" and address is not None:
            field["html"] = Markup(escape(address))
        return {"kind": item.kind, "field": field, "href": href}

    def pages(self) -> list[dict]:
        # TeX ignores \newpage on an empty page.
        pages: list[dict] = [{"where": Markup(""), "sections": []}]
        for section in self.doc.sections:
            if section.layout == "newpage":
                if len(pages) == 1 or pages[-1]["sections"]:
                    pages.append({"where": self.where("data-newpage", section.path), "sections": []})
                continue
            pages[-1]["sections"].append(self.section(section))
        if len(pages) > 1 and not pages[-1]["sections"]:
            pages.pop()
        return pages

    def section(self, section: Section) -> dict:
        entries = [self.entry(section.layout, e) for e in section.entries]
        return {
            "layout": section.layout,
            "title_class": "cv-section-title" + _title_depth(section.title),
            "where": self.where("data-section", section.path),
            "title": self.field(section.title or "", section.paths.get("title")),
            "description": self.field(section.description, section.paths.get("description")),
            "entries": entries,
            "citations": [citation_html(p) for p in section.publications],
        }

    def entry(self, layout: str, e: Entry) -> dict:
        def f(name: str, rigid: bool = False) -> Optional[dict]:
            return self.field(getattr(e, name), e.path_of(name), rigid=rigid)

        out: dict[str, Any] = {"where": self.where("data-entry", e.path)}
        if layout in ("entries", "entries-inline"):
            out.update(
                title=f("title", True), location=f("location", True), date=f("date", True),
                subtitle=f("subtitle", True), note=f("note", True),
                details=[self.field(d, e.path_of("details", i)) for i, d in enumerate(e.details)],
                bullets=[self.field(b, e.path_of("bullets", i)) for i, b in enumerate(e.bullets)],
            )
            # Without a subtitle TeX drops the \hfill at the line start, so the note is on the left.
            has_subtitle = bool(out["subtitle"] and str(out["subtitle"]["html"]).strip())
            out["note_left"] = not has_subtitle
            out["show_details"] = layout == "entries-inline" or not (
                len(e.details) == 0 or (len(e.details) == 1 and _raw(e.details[0]) == "")
            )
        elif layout == "list":
            out.update(text=f("text"), bullets=[self.field(b, e.path_of("bullets", i)) for i, b in enumerate(e.bullets)])
        elif layout == "pairs":
            out.update(title=f("title", True), text=f("text", True))
        elif layout == "dated":
            out.update(text=f("text"), date=f("date"))
            if out["date"] is not None:
                if self.decode and isinstance(e.date, Latex):
                    month, year = _latex_split_html(e.date.latex)
                else:
                    month, year = split_date_html(e.date)
                out["date"]["month"], out["date"]["year"] = Markup(month), Markup(year)
        else:  # text
            out.update(text=f("text"))
        return out


# Characters whose depth moves the rule under an upper-case title down.
_DEPTH_2 = frozenset("/()[]{}|\\")
_DEPTH_1 = frozenset(",;Q")


def _title_depth(title: Optional[Text]) -> str:
    if title is None or isinstance(title, Latex):
        return ""
    chars = set(str(title).upper())
    if chars & _DEPTH_2:
        return " cv-depth-2"
    if chars & _DEPTH_1:
        return " cv-depth-1"
    return ""


_LATEX_SYNTAX = re.compile(r"[\\{}~$]")
_STYLE_COMMANDS = re.compile(r"\\(?:emph|textit|textbf|textsc|textrm|textsf|texttt|textup|textmd|mbox|text)\s*(?=\{)")
# Text commands latexcodec leaves alone; a private-use placeholder keeps a backslash from later steps.
_BACKSLASH = "\ue000"
_TEXT_COMMANDS = {
    "textbackslash": _BACKSLASH, "textless": "<", "textgreater": ">", "textbar": "|",
    "textasciicircum": "ˆ", "textasciitilde": "˜", "LaTeX": "LaTeX", "TeX": "TeX",
}
_TEXT_COMMAND = re.compile(r"\\ensuremath\s*\{\\sim\}|\\(" + "|".join(_TEXT_COMMANDS) + r")(?![a-zA-Z])\s*(?:\{\})?")


def _text_command(m: re.Match) -> str:
    return "∼" if m.group(1) is None else _TEXT_COMMANDS[m.group(1)]


# Accents latexcodec leaves alone (it knows only precomposed characters).
_ACCENTS = {
    "~": ("\u0303", "˜"), "^": ("\u0302", "ˆ"), "'": ("\u0301", "´"), "`": ("\u0300", "`"),
    '"': ("\u0308", "¨"), "=": ("\u0304", "¯"), ".": ("\u0307", "˙"), "u": ("\u0306", "˘"),
    "v": ("\u030c", "ˇ"), "H": ("\u030b", "˝"), "c": ("\u0327", "¸"), "d": ("\u0323", "."),
    "b": ("\u0331", "ˍ"), "r": ("\u030a", "˚"), "k": ("\u0328", "˛"),
}
_ACCENT = re.compile(r"""(?<!\\)\\(?:([~^'`"=.])\s*(?:\{([^{}\\]?)\}|([^\s{}\\]))|([uvHcdbrk])\s*\{([^{}\\]?)\})""")


def _accent(m: re.Match) -> str:
    accent = m.group(1) or m.group(4)
    base = m.group(2) if m.group(2) is not None else m.group(3) if m.group(3) is not None else m.group(5)
    mark, alone = _ACCENTS[accent]
    return unicodedata.normalize("NFC", base + mark) if base else alone


def bib_text(latex: str) -> str:
    """A BibTeX field as the plain text pdflatex prints, roughly."""
    if not _LATEX_SYNTAX.search(latex):
        return latex
    text = _TEXT_COMMAND.sub(_text_command, latex)
    try:
        text = codecs.decode(text, "ulatex")
    except Exception:  # pragma: no cover - latexcodec passes unknown input through
        pass
    text = _ACCENT.sub(_accent, text)
    text = _STYLE_COMMANDS.sub("", text)
    text = re.sub(r"(?<!\\)[{}]", "", text)
    return re.sub(r"\\([{}%&#$_])", r"\1", text).replace(_BACKSLASH, "\\")


def _bib_html(latex: str) -> str:
    return escape_html(tex_ligatures_text(bib_text(latex)), quote=False)


# v1 values are LaTeX. Bold, italic, links, line breaks and \quad keep their
# structure; the rest is decoded like a BibTeX field.
_V1_COMMAND = re.compile(r"\\(?:(textbf|textit|emph|href|url|quad|newline)(?![a-zA-Z])\s*|(\\)|( ))")
_V1_FALLBACK = re.compile(r"\\(?:textbf|textit|emph|url)(?![a-zA-Z])|\\href\s*\{(?:[^{}\\]|\\.)*\}")
_URL_ESCAPE = re.compile(r"\\([%#&_$~{}])")
_COMMENT = re.compile(r"%[^\n]*(?:\n[ \t]*)?")


@functools.lru_cache(maxsize=4096)
def latex_text_html(latex: str) -> str:
    """LaTeX (a v1 text value) as the HTML of the text it prints."""
    return _latex_text_html(latex, 0)


def _latex_text_html(latex: str, depth: int) -> str:
    if depth > MAX_NESTING:
        return _bib_html(_V1_FALLBACK.sub("", latex))
    out: list[str] = []
    text: list[str] = []

    def flush() -> None:
        if text:
            out.append(_bib_html("".join(text)))
            text.clear()

    i, n = 0, len(latex)
    while i < n:
        if latex[i] == "%":
            i = _COMMENT.match(latex, i).end()  # type: ignore[union-attr]
            continue
        m = _V1_COMMAND.match(latex, i) if latex[i] == "\\" else None
        if m is None:
            if latex[i] == "\\":  # another command: decoded with the text
                text.append(latex[i : i + 2])
                i += 2
            else:
                text.append(latex[i])
                i += 1
            continue
        name = m.group(1)
        if m.group(2) or name == "newline":
            flush()
            out.append("<br>")
            i = _line_break_args(latex, m.end()) if m.group(2) else m.end()
            continue
        if m.group(3):
            text.append(" ")
            i = m.end()
            continue
        if name == "quad":
            flush()
            out.append('<span class="cv-quad"></span>')
            i = m.end()
            continue
        args, end = _latex_args(latex, m.end(), 2 if name == "href" else 1)
        if args is None:  # no braced argument: print the command as text
            text.append(latex[i : m.end()])
            i = m.end()
            continue
        flush()
        if name == "textbf":
            out.append("<strong>" + _latex_text_html(args[0], depth + 1) + "</strong>")
        elif name in ("textit", "emph"):
            out.append("<em>" + _latex_text_html(args[0], depth + 1) + "</em>")
        else:
            target = _URL_ESCAPE.sub(r"\1", args[0])
            inner = _latex_text_html(args[1], depth + 1) if name == "href" else escape_html(target, quote=False)
            href = safe_url(target)
            if href is None:
                out.append('<span class="cv-link">' + inner + "</span>")
            else:
                out.append(_split_link('<a class="cv-link" href="' + escape_html(href) + '">', inner))
        i = end
    flush()
    return "".join(out)


def _line_break_args(latex: str, i: int) -> int:
    # \\ also reads a star and an optional argument.
    j = i
    while j < len(latex) and latex[j] == " ":
        j += 1
    if j < len(latex) and latex[j] == "*":
        i = j = j + 1
        while j < len(latex) and latex[j] == " ":
            j += 1
    if j < len(latex) and latex[j] == "[":
        close = latex.find("]", j)
        if close != -1:
            return close + 1
    return i


def latex_url(latex: str) -> str:
    """A URL in v1 LaTeX, without its escapes."""
    return _URL_ESCAPE.sub(r"\1", latex)


def _latex_args(latex: str, i: int, count: int) -> tuple[Optional[list[str]], int]:
    args = []
    for _ in range(count):
        while i < len(latex) and latex[i] == " ":
            i += 1
        if i >= len(latex) or latex[i] != "{":
            return None, i
        depth, j = 0, i
        while j < len(latex):
            c = latex[j]
            if c == "\\":
                j += 2
                continue
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        if j >= len(latex):
            return None, i
        args.append(latex[i + 1 : j])
        i = j + 1
    return args, i


def _latex_split_html(latex: str) -> tuple[str, str]:
    cut = _last_split_space(latex)
    if cut == -1:
        return ("", latex_text_html(latex))
    return (latex_text_html(latex[:cut]), latex_text_html(latex[cut + 1 :]))


@functools.lru_cache(maxsize=1024)
def citation_html(pub: Publication) -> Markup:
    """One publication, laid out as :func:`cv_tools.render.latex.citation` does."""
    names = [f"<strong>{_bib_html(a.name)}</strong>" if a.highlighted else _bib_html(a.name) for a in pub.authors]
    authors = ", ".join(names[:-1]) + " and " + names[-1] if len(names) > 1 else "".join(names)
    parts = [
        authors,
        f"<em>{_bib_html(pub.title)}</em>" if pub.title is not None else "",
        _bib_html(pub.venue) if pub.venue else "",
        _bib_html(pub.year) if pub.year else "",
    ]
    text = ", ".join(p for p in parts if p)
    if pub.url:
        href = safe_url(pub.url)
        if href is not None:
            text += f' <a class="cv-link" href="{escape(href)}">[Link]</a>'
        else:
            text += ' <span class="cv-link">[Link]</span>'
    return Markup(text + ".")


__all__ = [
    "FONT_FILES", "FONT_RANGES", "HtmlResult", "auto_date_html", "bib_text", "citation_html", "dotted", "font_face_css",
    "latex_html", "latex_text_html", "render", "split_path", "stylesheet",
]
