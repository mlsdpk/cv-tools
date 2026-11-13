"""Checks that pdflatex can print every character (``templates/latex/unicode.txt``) before it runs."""

from __future__ import annotations

import re
import unicodedata
from functools import lru_cache
from importlib import resources
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

from .loader import CVError, Source, YamlPath
from .markup import Latex, to_latex

# Keys whose values are never printed as text.
_NOT_TEXT = frozenset({"version", "layout", "bib", "highlight", "url", "orcid", "linkedin", "github", "twitter"})

# hyperref reads URL arguments with other catcodes, so any character works there.
_URL_COMMAND = re.compile(r"\\(?:href|url)\s*\{")

_YAML_LINE_BREAK = re.compile("\r\n|[\n\r\x85\u2028\u2029]")


@lru_cache(maxsize=1)
def supported() -> frozenset[int]:
    """Code points above ASCII that print in every font of the class."""
    text = (resources.files("cv_tools") / "templates" / "latex" / "unicode.txt").read_text(encoding="utf-8")
    return frozenset(int(line.split()[0], 16) for line in text.splitlines() if line and not line.startswith("#"))


def prints(c: str) -> bool:
    return ord(c) < 0x80 or ord(c) in supported()


def _without_urls(latex: str) -> str:
    out, i = [], 0
    for match in _URL_COMMAND.finditer(latex):
        if match.start() < i:
            continue
        depth, j = 1, match.end()
        while j < len(latex) and depth:
            if latex[j] == "\\":
                j += 2
                continue
            depth += {"{": 1, "}": -1}.get(latex[j], 0)
            j += 1
        out.append(latex[i : match.end()])
        i = j - 1 if depth == 0 else len(latex)
    out.append(latex[i:])
    return "".join(out)


def problems(latex: str, uppercased: bool = False) -> list[tuple[str, Optional[str]]]:
    """``(character, upper-case form)`` for each character of ``latex`` that pdflatex cannot print."""
    # The upper-case form is set when only it fails (titles are upper-cased).
    found: dict[str, Optional[str]] = {}
    for c in _without_urls(latex):
        if c in found:
            continue
        if not prints(c):
            found[c] = None
        elif uppercased and not all(prints(u) for u in c.upper()):
            found[c] = c.upper()
    return list(found.items())


def describe(c: str, upper: Optional[str] = None) -> str:
    name = unicodedata.name(c, "")
    shown = repr(c) if unicodedata.category(c)[0] != "C" else "a control character"
    what = f"the character {shown} (U+{ord(c):04X}{' ' + name if name else ''})"
    if upper is not None:
        return (f"{what} becomes {upper!r} in the upper-cased name or section title, which pdflatex cannot "
                "print with the fonts of the cv-tools class; leave it out of the name and titles")
    return (f"{what} cannot be printed by pdflatex with the fonts of the cv-tools class; "
            "replace it or leave it out")


def _texts(value: Any, path: YamlPath) -> Iterator[tuple[YamlPath, str]]:
    if isinstance(value, dict):
        if list(value) == ["latex"] and isinstance(value["latex"], str):
            yield path, value["latex"]
            return
        for key, child in value.items():
            if key not in _NOT_TEXT:
                yield from _texts(child, path + (key,))
    elif isinstance(value, list):
        for i, child in enumerate(value):
            yield from _texts(child, path + (i,))
    elif isinstance(value, str):
        yield path, to_latex(value)  # URLs in links come out escaped


def _uppercased(path: YamlPath) -> bool:
    return path == ("name",) or (len(path) == 3 and path[0] == "sections" and path[2] == "title")


def _offset(text: str, line: int, col: int) -> int:
    start = 0
    for _ in range(line - 1):
        match = _YAML_LINE_BREAK.search(text, start)
        if match is None:
            return len(text)
        start = match.end()
    return start + col - 1


def _position(text: str, start: int) -> tuple[int, int]:
    breaks = list(_YAML_LINE_BREAK.finditer(text, 0, start))
    line_start = breaks[-1].end() if breaks else 0
    return len(breaks) + 1, start - line_start + 1


def check_data(src: Source, data: dict, source_path: Callable[[YamlPath], YamlPath],
               show_path: bool = True) -> list[CVError]:
    """An error for each character of a text field that pdflatex cannot print."""
    from .validate import format_path

    errors = []
    for path, latex in _texts(data, ()):
        found = problems(latex, _uppercased(path))
        if not found:
            continue
        where = src.position(source_path(path))
        start = _offset(src.text, *where) if where else 0
        for c, upper in found:
            index = src.text.find(c, start)
            line, col = _position(src.text, index) if index != -1 else (where or (None, None))
            prefix = f"{format_path(path)}: " if show_path else ""
            errors.append(CVError(prefix + describe(c, upper), src.name, line, col))
    return sorted(errors, key=lambda e: (e.line or 0, e.col or 0))


def check_publications(bib_path: Path, publications) -> list[CVError]:
    """An error for each character of a used .bib field that pdflatex cannot print."""
    errors = []
    for pub in publications:
        fields = [("author", a.name) for a in pub.authors]
        fields += [("title", pub.title), (pub.venue_field, pub.venue), ("year", pub.year)]
        for field, value in fields:
            for c, _ in problems(value or ""):
                errors.append(CVError(f"entry '{pub.key}', field '{field}': {describe(c)}", str(bib_path)))
    return errors
