"""v1 detection and the v1 to v2 conversion, used for rendering and by ``cv-tools migrate``."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable

from .loader import Source, YamlPath, describe
from .markup import Latex, escape_url, to_latex, v1_decode
from .model import ContactItem
from .render import latex

DEPRECATION = (
    "cv-tools: {file} uses the v1 format, which is deprecated and will be removed "
    "in a future release. Run 'cv-tools migrate {file}' to convert it."
)

CV_DATE_ITEM = "Curriculum Vitae, {date}"
# v1 printed the address separator (\\ inside \address, "$|$\ ") before the
# date item only; "| " prints the same.
CV_DATE_AFTER_SEPARATOR = "| " + CV_DATE_ITEM

_SOCIALS = {"orcid_id": "orcid", "linkedin": "linkedin", "github": "github", "twitter": "twitter"}
_ICONS = set(_SOCIALS.values())  # attach to the previous item with a space

_KNOWN_KEYS = {
    "document": {"version", "heading", "subheading", "sections"},
    "heading": {"name"},
    "subheading-group": {"type", "content"},
    "links": {"name", "highlight", "show_below"},
    "socials": {"type", "url", "show_below"},
    "education": {"type", "content"},
    "education-entry": {
        "university", "location", "dates", "degree", "honors", "thesis_title", "supervisor", "bullets",
    },
    "experience": {"type", "content"},
    "experience-group": {"name", "entity"},
    "experience-entry": {
        "organization", "dates", "position", "supervisor", "department", "location", "responsibilities",
    },
    "bullets": {"type", "title", "description", "content"},
    "bullets-entry": {"item", "subitems"},
    "skills": {"type", "content"},
    "skills-entry": {"name", "data"},
    "talks": {"type", "title", "content"},
    "talks-entry": {"name", "month", "year"},
    "publications": {"type", "title", "bibfile"},
    "newpage": {"type"},
}


def version_of(value: Any) -> int | None:
    """1 or 2 for a numeric ``version`` value that names a format, else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value) if value in (1, 2) else None


def detect(src: Source) -> str:
    """Return ``"v1"`` or ``"v2"``, or raise :class:`CVError`."""
    data = src.data
    if not isinstance(data, dict):
        raise src.error("expected a mapping at the top level of the CV file")
    if "version" in data:
        value = data["version"]
        version = version_of(value)
        if version is not None:
            return f"v{version}"
        if isinstance(value, str) and version_of(_number(value)) is not None:
            raise src.error(f"unsupported version {value!r}: the version is a number; "
                            f"write 'version: {value.strip()}' without quotes", ("version",))
        raise src.error(f"unsupported version {value!r}: expected 'version: 2' "
                        "(or 'version: 1' for the deprecated v1 format)", ("version",))
    sections = data.get("sections")
    typed = isinstance(sections, list) and any(isinstance(s, dict) and "type" in s for s in sections)
    if "heading" in data or "subheading" in data or typed:
        return "v1"
    raise src.error(
        "cannot tell the CV format: expected 'version: 2' at the top of a v2 file "
        "(v1 files have 'heading', 'subheading' or sections with 'type')"
    )


def _number(text: str) -> float | None:
    try:
        return float(text)
    except ValueError:
        return None


def unescape(text: str) -> str:
    """Turn the simple v1 escapes (``\\% \\& \\# \\_ \\$``) into plain characters."""
    return re.sub(r"\\([%&#_$])", r"\1", text)


@dataclass
class Conversion:
    data: dict
    warnings: list[str] = field(default_factory=list)
    # v2 path -> v1 path, to carry comments over.
    origins: dict[YamlPath, YamlPath] = field(default_factory=dict)


def convert(src: Source, clean: bool = False) -> Conversion:
    return _Converter(src, clean).run()


class _Converter:
    def __init__(self, src: Source, clean: bool):
        self.src = src
        self.clean = clean
        self.out = Conversion({})
        self.warnings: list[tuple[tuple[int, int], str]] = []
        self.highlight: list[str] = []  # v1 bolds authors equal to the raw heading name

    def warn(self, path: YamlPath, message: str, key: bool = False) -> None:
        error = self.src.error(message, path, key)
        self.warnings.append(((error.line or 0, error.col or 0), error.format("warning")))

    def origin(self, v2: YamlPath, v1: YamlPath) -> None:
        self.out.origins[v2] = v1

    def mapping(self, value: Any, path: YamlPath, kind: str) -> dict:
        if not isinstance(value, dict):
            raise self.src.error(f"expected a mapping, got {describe(value)}", path)
        for key in value:
            if key not in _KNOWN_KEYS[kind]:
                self.warn(path + (key,), f"v1 ignores the field '{key}'; it is dropped", key=True)
        return value

    def items(self, value: Any, path: YamlPath) -> list[tuple[int, Any]]:
        # Missing and null mean empty, as in v1's Jinja loops.
        if value is None:
            return []
        if not isinstance(value, list):
            raise self.src.error(f"expected a list, got {describe(value)}", path)
        out = []
        for i, item in enumerate(value):
            if item is None:
                self.warn(path + (i,), "empty list item (null); it is dropped")
            else:
                out.append((i, item))
        return out

    def decode(self, value: Any, path: YamlPath) -> str:
        if isinstance(value, str):
            return v1_decode(value)
        if isinstance(value, (int, float)):  # includes bool, printed as True/False by Jinja
            return str(value)
        raise self.src.error(f"expected text, got {describe(value)}", path)

    def text(
        self,
        value: Any,
        path: YamlPath,
        wrap: tuple[str, str] = ("", ""),
        latex_wrap: tuple[str, str] = ("", ""),
        key: Callable[[Any], Any] = to_latex,
    ) -> Any:
        latex = latex_wrap[0] + self.decode(value, path) + latex_wrap[1]
        if self.clean:
            if isinstance(value, str):
                candidate: Any = wrap[0] + unescape(value) + wrap[1]
            elif wrap == ("", "") and not isinstance(value, bool):
                candidate = value
            else:
                candidate = wrap[0] + str(value) + wrap[1]
            if key(candidate) == key(Latex(latex)):
                return candidate
        return {"latex": latex}

    def raw(self, latex: str, candidate: Any, key: Callable[[Any], Any] = to_latex) -> Any:
        if self.clean and key(candidate) == key(Latex(latex)):
            return candidate
        return {"latex": latex}

    def url(self, value: Any, path: YamlPath) -> Any:
        latex = self.decode(value, path) if value is not None else ""
        candidate = value if isinstance(value, str) else latex
        if self.clean and escape_url(candidate) == latex:
            return candidate
        return {"latex": latex}

    def run(self) -> Conversion:
        data = self.mapping(self.src.data, (), "document")
        doc = self.out.data
        doc["version"] = 2

        heading = data.get("heading")
        raw_name = None
        if heading is not None:
            raw_name = self.mapping(heading, ("heading",), "heading").get("name")
        doc["name"] = self.text(raw_name, ("heading", "name")) if raw_name is not None else ""
        self.origin(("name",), ("heading", "name"))
        if isinstance(raw_name, str) and raw_name:
            self.highlight = [raw_name]  # compared before decoding, as v1 did

        if data.get("subheading"):
            doc["contact"] = self.contact(data["subheading"])
            self.origin(("contact",), ("subheading",))

        sections: list = []
        for i, section in self.items(data.get("sections"), ("sections",)):
            sections.extend(self.section(section, ("sections", i), len(sections)))
        doc["sections"] = sections
        self.origin(("sections",), ("sections",))
        self.out.warnings = [text for _, text in sorted(self.warnings, key=lambda w: w[0])]
        return self.out

    def contact(self, subheading: Any) -> list:
        lines: dict[bool, list[tuple[str, Any, str]]] = {False: [], True: []}
        for g, group in self.items(subheading, ("subheading",)):
            gpath = ("subheading", g)
            group = self.mapping(group, gpath, "subheading-group")
            gtype = group.get("type")
            for e, entity in self.items(group.get("content"), gpath + ("content",)):
                epath = gpath + ("content", e)
                if gtype not in ("links", "socials"):
                    self.warn(epath, f"v1 does not print subheading groups of type {gtype!r}; the item is dropped")
                    continue
                entity = self.mapping(entity, epath, gtype)
                below = entity.get("show_below")
                if not isinstance(below, bool):
                    self.warn(
                        epath,
                        "v1 does not print subheading items without show_below: true or false; the item is dropped",
                    )
                    continue
                item = self.contact_item(gtype, entity, epath)
                if item is not None:
                    lines[below].append(item)

        line1 = [{kind: value} if kind != "text" else value for kind, value, _ in lines[False]]
        if any(kind not in _ICONS for kind, _, _ in lines[False][1:]):
            line1 = {"items": line1, "separator": " "}  # v1 joins a line with spaces

        below = lines[True]
        line2: Any = [{kind: value} if kind != "text" else value for kind, value, _ in below]
        if any(kind not in _ICONS for kind, _, _ in below[1:]):
            # v1 joins these items with spaces and puts the address separator
            # only before the date item.
            line2 = {"items": line2 + [CV_DATE_AFTER_SEPARATOR], "separator": " "}
        else:
            # Without items before it, v1 starts the date line with a space,
            # which moves the centred line by half a space.
            line2.append(CV_DATE_ITEM if below else " " + CV_DATE_ITEM)
        return [line1, line2]

    def contact_item(self, gtype: str, entity: dict, path: YamlPath) -> tuple[str, Any, str] | None:
        if gtype == "links":
            name = entity.get("name")
            if entity.get("highlight") is True:
                kind, value = "url", self.url(name, path + ("name",))
            elif name is None:
                kind, value = "text", ""
            else:
                kind, value = "text", self.text(name, path + ("name",), key=_contact_key)
                if isinstance(value, str) and "\n" in value:
                    value = {"latex": self.decode(name, path + ("name",))}  # v2 contact text is single-line
        else:
            social = entity.get("type")
            if social not in _SOCIALS:
                self.warn(path + ("type",), f"v1 does not print socials of type {social!r}; the item is dropped")
                return None
            kind, value = _SOCIALS[social], self.url(entity.get("url"), path + ("url",))
        model_value = Latex(value["latex"]) if isinstance(value, dict) else value
        return (kind, value, latex.contact_item(ContactItem(kind, model_value), latex.AUTO_DATE))

    def section(self, section: Any, path: YamlPath, index: int) -> list:
        if not isinstance(section, dict):
            raise self.src.error(f"expected a section mapping, got {describe(section)}", path)
        stype = section.get("type")
        if stype not in _SECTION_TYPES:
            self.warn(path, f"v1 does not print sections of type {stype!r}; the section is dropped")
            return []
        self.mapping(section, path, stype)
        out = getattr(self, "section_" + stype)(section, path, index)
        if out and isinstance(out[0], dict):
            self.origin(("sections", index, "layout"), path + ("type",))
        return out

    def title(self, section: dict, path: YamlPath, v2: YamlPath) -> Any:
        self.origin(v2 + ("title",), path + ("title",))
        value = section.get("title")
        return self.text(value, path + ("title",)) if value is not None else ""

    def entries(self, section: dict, path: YamlPath, kind: str):
        for n, (i, entry) in enumerate(self.items(section.get("content"), path + ("content",))):
            epath = path + ("content", i)
            yield n, epath, self.mapping(entry, epath, kind)

    def field(self, entry: dict, name: str, path: YamlPath, out: dict, v2name: str, v2: YamlPath, **kw) -> None:
        if entry.get(name) is not None:
            out[v2name] = self.text(entry[name], path + (name,), **kw)
            self.origin(v2 + (v2name,), path + (name,))

    def bullets(self, value: Any, path: YamlPath) -> list:
        return [self.text(b, path + (i,)) for i, b in self.items(value, path)]

    def section_education(self, section: dict, path: YamlPath, index: int) -> list:
        v2 = ("sections", index)
        self.origin(v2, path)
        entries = []
        for i, epath, edu in self.entries(section, path, "education-entry"):
            e2 = v2 + ("entries", i)
            self.origin(e2, epath)
            entry = {"title": ""}
            self.field(edu, "university", epath, entry, "title", e2)
            # v1 always prints ", location", even when the location is missing.
            entry["location"] = ""
            self.field(edu, "location", epath, entry, "location", e2)
            self.field(edu, "dates", epath, entry, "date", e2)
            self.field(edu, "degree", epath, entry, "subtitle", e2)
            self.field(edu, "honors", epath, entry, "note", e2)
            details = []
            if edu.get("thesis_title"):
                details.append(
                    self.text(
                        edu["thesis_title"], epath + ("thesis_title",),
                        wrap=("Thesis Title: *", "*"), latex_wrap=("Thesis Title: \\textit{", "}"),
                    )
                )
            if edu.get("supervisor"):
                details.append(
                    self.text(
                        edu["supervisor"], epath + ("supervisor",),
                        wrap=("Supervisor: ", ""), latex_wrap=("Supervisor: ", ""),
                    )
                )
            if details:
                entry["details"] = details
            if edu.get("bullets"):
                entry["bullets"] = self.bullets(edu["bullets"], epath + ("bullets",))
                self.origin(e2 + ("bullets",), epath + ("bullets",))
            entries.append(entry)
        return [{"title": "Education", "layout": "entries-inline", "entries": entries}]

    def section_experience(self, section: dict, path: YamlPath, index: int) -> list:
        out = []
        for g, gpath, group in self.entries(section, path, "experience-group"):
            v2 = ("sections", index + g)
            self.origin(v2, gpath)
            title = self.text(group["name"], gpath + ("name",)) if group.get("name") is not None else ""
            self.origin(v2 + ("title",), gpath + ("name",))
            entries = []
            for n, (i, entity) in enumerate(self.items(group.get("entity"), gpath + ("entity",))):
                epath = gpath + ("entity", i)
                e2 = v2 + ("entries", n)
                self.origin(e2, epath)
                exp = self.mapping(entity, epath, "experience-entry")
                entry = {"title": ""}
                self.field(exp, "organization", epath, entry, "title", e2)
                self.field(exp, "dates", epath, entry, "date", e2)
                self.field(exp, "position", epath, entry, "subtitle", e2)
                if exp.get("supervisor"):
                    entry["note"] = self.text(
                        exp["supervisor"], epath + ("supervisor",),
                        wrap=("Supervisor: ", ""), latex_wrap=("Supervisor: ", ""),
                    )
                    self.origin(e2 + ("note",), epath + ("supervisor",))
                # v1 prints "department\\location" as the fifth rSubsection argument.
                details = []
                if exp.get("department"):
                    details.append(self.text(exp["department"], epath + ("department",)))
                location = exp.get("location")
                if location is not None and location != "":
                    details.append(self.text(location, epath + ("location",)))
                elif details:
                    details.append("")  # v1 leaves a trailing line break
                if details:
                    entry["details"] = details
                if exp.get("responsibilities"):
                    entry["bullets"] = self.bullets(exp["responsibilities"], epath + ("responsibilities",))
                    self.origin(e2 + ("bullets",), epath + ("responsibilities",))
                entries.append(entry)
            out.append({"title": title, "layout": "entries", "entries": entries})
        return out

    def section_bullets(self, section: dict, path: YamlPath, index: int) -> list:
        v2 = ("sections", index)
        self.origin(v2, path)
        out: dict = {"title": self.title(section, path, v2), "layout": "list"}
        if section.get("description"):
            out["description"] = self.text(section["description"], path + ("description",))
            self.origin(v2 + ("description",), path + ("description",))
        entries = []
        for i, epath, item in self.entries(section, path, "bullets-entry"):
            self.origin(v2 + ("entries", i), epath)
            text = self.text(item["item"], epath + ("item",)) if item.get("item") is not None else ""
            if item.get("subitems"):
                entries.append({"text": text, "bullets": self.bullets(item["subitems"], epath + ("subitems",))})
                self.origin(v2 + ("entries", i, "bullets"), epath + ("subitems",))
            else:
                entries.append(text)
        out["entries"] = entries
        return [out]

    def section_skills(self, section: dict, path: YamlPath, index: int) -> list:
        v2 = ("sections", index)
        self.origin(v2, path)
        entries = []
        for i, epath, skill in self.entries(section, path, "skills-entry"):
            e2 = v2 + ("entries", i)
            self.origin(e2, epath)
            entry = {"title": "", "text": ""}
            self.field(skill, "name", epath, entry, "title", e2)
            self.field(skill, "data", epath, entry, "text", e2)
            entries.append(entry)
        return [{"title": "Skills", "layout": "pairs", "entries": entries}]

    def section_talks(self, section: dict, path: YamlPath, index: int) -> list:
        v2 = ("sections", index)
        self.origin(v2, path)
        out = {"title": self.title(section, path, v2), "layout": "dated"}
        entries = []
        for i, epath, talk in self.entries(section, path, "talks-entry"):
            e2 = v2 + ("entries", i)
            self.origin(e2, epath)
            entry: dict = {}
            date = self.talk_date(talk, epath)
            if date is not None:
                entry["date"] = date
                self.origin(e2 + ("date",), epath + ("month",))
            entry["text"] = ""
            # v2 prints a line break in a dated cell as \newline, where v1 wrote \\.
            self.field(talk, "name", epath, entry, "text", e2, key=latex.dated_text)
            entries.append(entry)
        out["entries"] = entries
        return [out]

    def talk_date(self, talk: dict, path: YamlPath) -> Any:
        month, year = talk.get("month"), talk.get("year")
        if month is None and year is None:
            return None
        m = self.decode(month, path + ("month",)) if month is not None else ""
        y = self.decode(year, path + ("year",)) if year is not None else ""
        latex = f"{m} {y}"
        if _dated_date(Latex(latex)) != (m, y):
            latex = f"{m} {{{y}}}"  # keep the year in one column; braces print nothing
        if month is None:
            candidate = unescape(year) if isinstance(year, str) else str(year) if isinstance(year, bool) else year
        else:
            parts = [unescape(v) if isinstance(v, str) else str(v) for v in (month, "" if year is None else year)]
            candidate = " ".join(parts)
        return self.raw(latex, candidate, key=_dated_date)

    def section_publications(self, section: dict, path: YamlPath, index: int) -> list:
        v2 = ("sections", index)
        self.origin(v2, path)
        bibfile = section.get("bibfile")
        if not isinstance(bibfile, str):
            raise self.src.error(
                f"section '{section.get('title', 'Untitled')}' is missing a 'bibfile' entry", path
            )
        out = {"title": self.title(section, path, v2), "layout": "publications", "bib": bibfile}
        self.origin(v2 + ("bib",), path + ("bibfile",))
        name = self.out.data["name"]
        default = [name["latex"] if isinstance(name, dict) else str(name)]
        if not self.clean or _names(default) != _names(self.highlight):
            out["highlight"] = list(self.highlight)
        return [out]

    def section_newpage(self, section: dict, path: YamlPath, index: int) -> list:
        self.origin(("sections", index), path)
        return ["newpage"]


_SECTION_TYPES = {"education", "experience", "bullets", "skills", "talks", "publications", "newpage"}


def _dated_date(value: Any) -> tuple[str, str]:
    # talk_date has a local variable named latex.
    return latex.dated_date(value)


def _names(names: list[str]) -> list[str]:
    return [n for n in names if n]


def _contact_key(value: Any) -> str:
    # A contact text item replaces {date}; any marker works for the comparison.
    return to_latex(value, date="\x00date\x00")

