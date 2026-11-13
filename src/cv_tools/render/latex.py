"""LaTeX renderer: turns the normalized v2 model into a .tex file."""

from __future__ import annotations

from dataclasses import dataclass, field
from importlib import resources
from typing import Optional

import jinja2

from .. import __version__
from ..bib import Publication
from ..markup import CELL_NEWLINE, Text, escape_url, split_date, to_latex
from ..model import DEFAULT_SEPARATOR, ICON_KINDS, ContactItem, ContactLine, Document, Section

TEMPLATE_DIR = resources.files("cv_tools") / "templates" / "latex"
SUPPORT_FILES = ("resume.cls", "orcid.pdf")
AUTO_DATE = r"\customdate\today"  # the {date} insertion appends {} (see markup.to_latex)

_ICON_MACROS = {
    "linkedin": r"\colorfaLinkedinSquare",
    "github": r"\colorfaGithub",
    "twitter": r"\colorfaTwitter",
}


@dataclass
class RenderResult:
    tex: str
    files: dict[str, bytes] = field(default_factory=dict)  # support files next to the .tex


def _environment() -> jinja2.Environment:
    return jinja2.Environment(
        loader=jinja2.PackageLoader("cv_tools", "templates/latex"),
        autoescape=False,
        undefined=jinja2.StrictUndefined,
    )


def render(doc: Document) -> RenderResult:
    date = date_latex(doc.date)
    tex = _environment().get_template("cv.tex.jinja").render(
        version=__version__,
        name=to_latex(doc.name),
        addresses=_address_order([contact_line(line, date) for line in doc.contact]),
        sections=[_section(s) for s in doc.sections],
    )
    files = {name: (TEMPLATE_DIR / name).read_bytes() for name in SUPPORT_FILES}
    return RenderResult(tex, files)


def date_latex(date: Text) -> str:
    return AUTO_DATE if date == "auto" else to_latex(date)


def _address_order(lines: list[str]) -> list[str]:
    # resume.cls prints a third \address line first; emit it last so the
    # lines appear in the order they were written.
    if len(lines) == 3:
        return [lines[1], lines[2], lines[0]]
    return lines


def contact_line(line: ContactLine, date: str) -> str:
    """One contact line; icons attach to the previous item with a space."""
    if line.separator == DEFAULT_SEPARATOR:
        separator = r" \\ "  # \\ prints the class address separator inside \address
    else:
        separator = to_latex(line.separator)
    out = ""
    for i, item in enumerate(line.items):
        if i:
            out += " " if item.kind in ICON_KINDS else separator
        out += contact_item(item, date)
    return out


def contact_item(item: ContactItem, date: str) -> str:
    if item.kind == "text":
        return to_latex(item.value, date=date)
    url = _url(item.value)
    if item.kind == "url":
        return rf"\url{{{url}}}"
    if item.kind == "orcid":
        return rf"\orcidicon{{{url}}}"
    return rf"\href{{{url}}}{{{_ICON_MACROS[item.kind]}}}"


def _url(value: Text) -> str:
    return to_latex(value) if not isinstance(value, str) else escape_url(value)


def _opt(value: Optional[Text]) -> Optional[str]:
    return None if value is None else to_latex(value)


def _req(value: Optional[Text]) -> str:
    return "" if value is None else to_latex(value)


def _section(section: Section) -> dict:
    if section.layout == "newpage":
        return {"layout": "newpage"}
    title = _req(section.title)
    view = {
        "layout": section.layout,
        "title": title,
        "comment": " ".join(title.split()),  # a comment must stay on one line
        "description": _opt(section.description),
        "entries": [],
    }
    for e in section.entries:
        entry = {
            "title": _req(e.title),
            "date": _req(e.date),
            "subtitle": _req(e.subtitle),
            "note": _req(e.note),
            "location": _opt(e.location),
            "text": _req(e.text),
            "details": [to_latex(d) for d in e.details],
            "bullets": [to_latex(b) for b in e.bullets],
        }
        if section.layout == "dated":
            entry["month"], entry["year"] = dated_date(e.date)
            entry["text"] = dated_text(e.text)
        view["entries"].append(entry)
    if section.layout == "publications":
        view["citations"] = [citation(p) for p in section.publications]
    return view


def dated_date(value: Optional[Text]) -> tuple[str, str]:
    return split_date(value, newline=CELL_NEWLINE)


def dated_text(value: Optional[Text]) -> str:
    return "" if value is None else to_latex(value, newline=CELL_NEWLINE)


def citation(pub: Publication) -> str:
    """One publication in the v1 layout, its BibTeX fields inserted as written."""
    names = [rf"\textbf{{{a.name}}}" if a.highlighted else a.name for a in pub.authors]
    authors = ", ".join(names[:-1]) + " and " + names[-1] if len(names) > 1 else "".join(names)
    parts = [
        authors,
        rf"\emph{{{pub.title}}}" if pub.title is not None else "",
        pub.venue or "",
        pub.year or "",
    ]
    text = ", ".join(p for p in parts if p)
    if pub.url:
        text += rf" \href{{{escape_url(pub.url)}}}{{[Link]}}"
    return text + "."
