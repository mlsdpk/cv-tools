"""The normalized v2 model that every renderer takes."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from . import bib
from .loader import CVError, YamlPath
from .markup import Latex, Text

ICON_KINDS = ("orcid", "linkedin", "github", "twitter")
LINK_KINDS = ("url",) + ICON_KINDS
DEFAULT_SEPARATOR = " | "

# The path fields locate each value in a v2 file, for the preview; v1 input has none.


def _paths() -> Any:
    return field(default_factory=dict, compare=False, repr=False)


def _path() -> Any:
    return field(default=None, compare=False, repr=False)


@dataclass
class ContactItem:
    kind: str  # "text" or one of LINK_KINDS
    value: Text  # a URL or ORCID iD (str or Latex) for link kinds
    path: Optional[YamlPath] = _path()  # the source of ``value``


@dataclass
class ContactLine:
    items: list[ContactItem]
    separator: Text = DEFAULT_SEPARATOR
    path: Optional[YamlPath] = _path()  # the line
    separator_path: Optional[YamlPath] = _path()  # only when the line sets ``separator``


@dataclass
class Entry:
    title: Optional[Text] = None
    date: Optional[Text] = None
    subtitle: Optional[Text] = None
    note: Optional[Text] = None
    location: Optional[Text] = None
    text: Optional[Text] = None
    details: list[Text] = field(default_factory=list)
    bullets: list[Text] = field(default_factory=list)
    path: Optional[YamlPath] = _path()  # the entry
    paths: dict[str, YamlPath] = _paths()

    def path_of(self, name: str, index: Optional[int] = None) -> Optional[YamlPath]:
        """The source of a field, or of item ``index`` of a list field."""
        base = self.paths.get(name)
        if base is None or index is None:
            return base
        return base + (index,)


@dataclass
class Section:
    layout: str  # a v2 layout, or "newpage"
    title: Optional[Text] = None
    description: Optional[Text] = None
    entries: list[Entry] = field(default_factory=list)
    bib: Optional[Path] = None
    highlight: list[str] = field(default_factory=list)
    publications: list[bib.Publication] = field(default_factory=list)
    path: Optional[YamlPath] = _path()  # the section item (also for newpage)
    paths: dict[str, YamlPath] = _paths()  # "title" and "description"


@dataclass
class Document:
    name: Text
    date: Text = "auto"  # "auto" prints the compile date
    contact: list[ContactLine] = field(default_factory=list)
    sections: list[Section] = field(default_factory=list)
    source_format: str = "v2"
    path: Optional[Path] = None
    warnings: list[str] = field(default_factory=list)
    paths: dict[str, YamlPath] = _paths()  # "name", and "date" when the file sets it
    # Source.aliases and Source.anchors of a v2 file.
    aliases: dict[YamlPath, str] = _paths()
    anchors: dict[YamlPath, str] = _paths()


class ModelError(CVError):
    """An error found while building the model, at a v2 data path."""

    def __init__(self, message: str, path: YamlPath):
        super().__init__(message)
        self.path = path


def _text(value: Any) -> Optional[Text]:
    if value is None:
        return None
    if isinstance(value, dict):
        return Latex(value["latex"])
    return value


def _texts(values: Optional[list]) -> list[Text]:
    return [_text(v) for v in values or []]


_ENTRY_FIELDS = ("title", "date", "subtitle", "note", "location", "text", "details", "bullets")


def _entry(data: Any, at: Optional[YamlPath] = None) -> Entry:
    # A plain text value is shorthand for {text: ...}.
    if not isinstance(data, dict) or "latex" in data:
        return Entry(text=_text(data), path=at, paths={} if at is None else {"text": at})
    return Entry(
        title=_text(data.get("title")),
        date=_text(data.get("date")),
        subtitle=_text(data.get("subtitle")),
        note=_text(data.get("note")),
        location=_text(data.get("location")),
        text=_text(data.get("text")),
        details=_texts(data.get("details")),
        bullets=_texts(data.get("bullets")),
        path=at,
        paths={} if at is None else {k: at + (k,) for k in _ENTRY_FIELDS if k in data},
    )


def _contact_line(data: Any, at: Optional[YamlPath] = None) -> ContactLine:
    items_at: Optional[YamlPath] = at
    separator_at: Optional[YamlPath] = None
    if isinstance(data, dict):
        items, separator = data["items"], _text(data.get("separator", DEFAULT_SEPARATOR))
        if at is not None:
            items_at = at + ("items",)
            separator_at = at + ("separator",) if "separator" in data else None
    else:
        items, separator = data, DEFAULT_SEPARATOR
    out = []
    for j, item in enumerate(items):
        item_at = None if items_at is None else items_at + (j,)
        if isinstance(item, dict) and "latex" not in item:
            (kind, value), = item.items()
            out.append(ContactItem(kind, _text(value), None if item_at is None else item_at + (kind,)))
        else:
            out.append(ContactItem("text", _text(item), item_at))
    return ContactLine(out, separator, at, separator_at)


def from_data(data: dict, base_dir: Path, source_format: str = "v2", path: Optional[Path] = None) -> Document:
    """Build the model from schema-valid v2 data and load the .bib files."""
    def at(*parts) -> Optional[YamlPath]:
        return tuple(parts) if source_format == "v2" else None

    name = _text(data["name"])
    default_highlight = [name.latex if isinstance(name, Latex) else str(name)]
    doc = Document(
        name=name,
        date=_text(data.get("date", "auto")),
        contact=[_contact_line(line, at("contact", j)) for j, line in enumerate(data.get("contact", []))],
        source_format=source_format,
        path=path,
    )
    if source_format == "v2":
        doc.paths = {k: (k,) for k in ("name", "date") if k in data}
    for i, section in enumerate(data.get("sections", [])):
        if section == "newpage":
            doc.sections.append(Section("newpage", path=at("sections", i)))
            continue
        s = Section(
            layout=section["layout"],
            title=_text(section["title"]),
            description=_text(section.get("description")),
            entries=[_entry(e, at("sections", i, "entries", j)) for j, e in enumerate(section.get("entries", []))],
            path=at("sections", i),
        )
        if source_format == "v2":
            s.paths = {k: ("sections", i, k) for k in ("title", "description") if k in section}
        if s.layout == "publications":
            s.bib = (base_dir / section["bib"]).resolve()
            s.highlight = list(section.get("highlight", default_highlight))
            try:
                s.publications, warnings = bib.load(s.bib, s.highlight)
            except CVError as e:
                raise ModelError(e.message, ("sections", i, "bib")) from None
            doc.warnings.extend(warnings)
        doc.sections.append(s)
    return doc
