"""BibTeX loading, author names and highlight matching. Fields are LaTeX, printed as written."""

from __future__ import annotations

import codecs
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import latexcodec  # noqa: F401  (registers the "ulatex" codec; a pybtex dependency)

from pybtex.database import Person, parse_file
from pybtex.exceptions import PybtexError

from .loader import CVError


@dataclass(frozen=True)
class Author:
    name: str  # LaTeX, as written in the .bib file
    highlighted: bool


@dataclass(frozen=True)
class Publication:
    """One .bib entry. Text fields are LaTeX from the .bib file; None when missing."""

    key: str
    authors: tuple[Author, ...]
    title: str | None
    venue: str | None
    year: str | None
    url: str | None  # a plain URL, BibTeX escapes resolved
    venue_field: str | None = None  # "journal" or "booktitle", where the venue came from


def format_name(person: Person) -> str:
    """The full name with its von and Jr. parts, which cv-tools 1.x dropped."""
    parts = (
        person.first_names + person.middle_names + person.prelast_names + person.last_names + person.lineage_names
    )
    return " ".join(" ".join(parts).split())


def bib_url(url: str) -> str:
    """A BibTeX ``url`` field as a plain URL, escapes and braces resolved."""
    url = re.sub(r"\\([%#_&$~])", r"\1", url)
    return re.sub(r"(?<!\\)[{}]", "", url).strip()


def _decode(name: str) -> str:
    """LaTeX accents to Unicode, so ``Jos{\\'e}`` and ``José`` compare equal."""
    try:
        name = codecs.decode(name, "ulatex")
    except (ValueError, LookupError):  # pragma: no cover - latexcodec passes unknown input through
        pass
    return unicodedata.normalize("NFC", name)


def _normalize(name: str) -> str:
    name = _decode(name).replace("{", "").replace("}", "")
    return " ".join(name.split()).casefold()


def _join(*parts: str) -> str:
    return " ".join(p for p in parts if p)


def _name_forms(person: Person) -> set[str]:
    first = " ".join(person.first_names + person.middle_names)
    last = _join(*person.prelast_names, *person.last_names)
    jr = " ".join(person.lineage_names)
    forms = {format_name(person), _join(first, last) + (f", {jr}" if jr else "")}
    if first:
        forms.add(f"{last}, {jr}, {first}" if jr else f"{last}, {first}")
        if jr:
            forms.add(f"{last} {jr}, {first}")
    return {_normalize(f) for f in forms}


def matches(person: Person, names: list[str]) -> bool:
    """True if any of ``names`` is this author's full name, ignoring case, braces, spacing and accent spelling."""
    wanted = {_normalize(n) for n in names} - {""}
    return bool(wanted & _name_forms(person))


def _field(fields, name: str) -> str | None:
    value = fields.get(name)
    return value if value is not None and value.strip() else None


def load(path: Path, highlight: list[str]) -> tuple[list[Publication], list[str]]:
    """Entries of a .bib file in file order, and warnings about missing fields."""
    if not Path(path).is_file():
        raise CVError(f"BibTeX file not found: {path}")
    try:
        data = parse_file(str(path), bib_format="bibtex")
    except (PybtexError, UnicodeDecodeError) as e:
        raise CVError(f"cannot read BibTeX file {path}: {e}") from None

    publications, warnings = [], []
    for key, entry in data.entries.items():
        persons = entry.persons.get("author", [])
        authors = tuple(Author(format_name(p), matches(p, highlight)) for p in persons)
        fields = entry.fields
        title, year = _field(fields, "title"), _field(fields, "year")
        missing = [f for f, present in (("author", authors), ("title", title), ("year", year)) if not present]
        for name in missing:
            warnings.append(f"{path}: warning: entry '{key}' has no {name}; it is left out of the citation")
        publications.append(
            Publication(
                key=key,
                authors=authors,
                title=title,
                venue=_field(fields, "journal") or _field(fields, "booktitle"),
                venue_field="journal" if _field(fields, "journal") else "booktitle" if _field(fields, "booktitle") else None,
                year=year,
                url=bib_url(fields["url"]) if _field(fields, "url") else None,
            )
        )
    return publications, warnings
