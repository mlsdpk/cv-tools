"""JSON Schema validation of v2 files with line-numbered, friendly errors."""

from __future__ import annotations

import difflib
import json
import re
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources

import jsonschema

from .loader import CVError, Source, YamlPath, describe

# Slips that difflib would not suggest; the first valid one wins.
_ALIASES = {
    "content": ("entries", "bullets"),
    "items": ("entries", "bullets"),
    "entity": ("entries",),
    "subitems": ("bullets", "entries"),
    "responsibilities": ("bullets", "entries"),
    "dates": ("date",),
    "month": ("date",),
    "year": ("date",),
    "heading": ("name",),
    "subheading": ("contact",),
    "type": ("layout",),
    "bibfile": ("bib",),
    "name": ("title", "text"),  # text where an entry has no title (dated, list, text)
    "organization": ("title",),
    "university": ("title",),
    "data": ("text",),
    "item": ("text",),
    "position": ("subtitle",),
    "degree": ("subtitle",),
    "honors": ("note",),
}

# Keys only v1 files use; the first one also says how to convert the file.
_V1_ONLY = {
    "type", "heading", "subheading", "content", "entity", "subitems", "responsibilities",
    "bibfile", "thesis_title", "show_below",
}
V1_HINT = "This looks like a v1 file; run 'cv-tools migrate' to convert it"

_TYPE_NAMES = {
    "string": "a string",
    "number": "a number",
    "integer": "an integer",
    "object": "a mapping",
    "array": "a list",
    "boolean": "a boolean",
    "null": "null",
}


class ValidationError(CVError):
    """One or more schema errors. ``errors`` holds one :class:`CVError` each."""

    def __init__(self, errors: list[CVError]):
        super().__init__("\n".join(str(e) for e in errors), errors[0].file)
        self.errors = errors

    def __str__(self) -> str:
        return self.message


@lru_cache(maxsize=1)
def schema() -> dict:
    text = (resources.files("cv_tools") / "schema" / "cv-v2.schema.json").read_text(encoding="utf-8")
    return json.loads(text)


def format_path(path: YamlPath) -> str:
    out = ""
    for part in path:
        out += f"[{part}]" if isinstance(part, int) else (f".{part}" if out else str(part))
    return out


def suggest(word: str, choices: list[str]) -> str | None:
    for alias in _ALIASES.get(word, ()):
        if alias in choices:
            return alias
    close = difflib.get_close_matches(word, choices, n=1, cutoff=0.7)
    return close[0] if close else None


@dataclass(frozen=True)
class _Problem:
    path: YamlPath
    message: str
    at_key: bool = False  # report at the mapping key rather than the value
    missing: str | None = None  # the key a "required" error is about
    hint: str | None = None  # the key an unknown key probably meant


def _problems(error: jsonschema.ValidationError) -> list[_Problem]:
    path = tuple(error.absolute_path)
    v, value, sch = error.validator, error.instance, error.schema
    expected = sch.get("x-expected")
    if v == "not" and "x-message" in sch:
        return [_Problem(path, sch["x-message"])]
    if v == "type" and value is None and path and isinstance(path[-1], int):
        return [_Problem(path, "empty list item (null); remove the '-' line or give the item a value")]
    if v == "additionalProperties":
        allowed = sorted(sch.get("properties", {}))
        out = []
        for key in value:
            if key in allowed:
                continue
            hint = suggest(str(key), allowed)
            detail = f"; did you mean '{hint}'?" if hint else f" (expected one of: {', '.join(allowed)})"
            out.append(_Problem(path + (key,), f"unknown key '{key}'{detail}", at_key=True, hint=hint))
        return out
    if v == "required":
        missing = [k for k in error.validator_value if k not in value]
        out = []
        for k in missing:
            message = f"missing required key '{k}'"
            if k == "layout" and "type" in value:
                message += f" (v1 sections had 'type'). {V1_HINT}"
            out.append(_Problem(path, message, missing=k))
        return out
    if v == "type":
        if expected is None:
            types = error.validator_value if isinstance(error.validator_value, list) else [error.validator_value]
            expected = " or ".join(_TYPE_NAMES.get(t, t) for t in types)
        return [_Problem(path, f"expected {expected}, got {describe(value)}")]
    if v == "enum":
        hint = suggest(str(value), [str(c) for c in error.validator_value])
        detail = f"; did you mean '{hint}'?" if hint else f" (expected one of: {', '.join(map(str, error.validator_value))})"
        return [_Problem(path, f"unknown value {value!r}{detail}")]
    if v == "const":
        return [_Problem(path, f"expected {expected or repr(error.validator_value)}, got {value!r}")]
    if v in ("minProperties", "maxProperties") and expected:
        return [_Problem(path, f"expected {expected}")]
    if v == "maxItems":
        return [_Problem(path, f"at most {error.validator_value} items allowed, got {len(value)}")]
    return [_Problem(path, error.message)]


def validate(src: Source) -> list[CVError]:
    """Schema errors in a v2 document, sorted by position."""
    validator = jsonschema.Draft202012Validator(schema())
    problems = [p for error in validator.iter_errors(src.data) for p in _problems(error)]
    # "unknown key 'titel'; did you mean 'title'?" already explains a missing title.
    hinted = {(p.path[:-1], p.hint) for p in problems if p.hint}
    found: dict[tuple, CVError] = {}
    for p in problems:
        if p.missing is not None and (p.path, p.missing) in hinted:
            continue
        where = format_path(p.path)
        err = src.error(f"{where}: {p.message}" if where else p.message, p.path, key=p.at_key)
        found.setdefault((err.line or 0, err.col or 0, err.message), err)
    errors = [found[k] for k in sorted(found)]
    for err in errors:
        key = re.match(r"unknown key '([^']*)'", err.message.split(": ", 1)[-1])
        if V1_HINT in err.message:
            break
        if key and key.group(1) in _V1_ONLY:
            err.message += (" " if err.message.endswith("?") else ". ") + V1_HINT
            break
    return errors
