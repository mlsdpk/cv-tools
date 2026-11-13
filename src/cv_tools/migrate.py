"""v1 YAML text -> v2 YAML text, keeping comments where they have a place."""

from __future__ import annotations

import copy
import io
import math
import re
from dataclasses import dataclass, field
from typing import Any

import yaml as pyyaml
from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq
from ruamel.yaml.scalarstring import DoubleQuotedScalarString, SingleQuotedScalarString
from ruamel.yaml.error import YAMLError

from . import v1
from .loader import CVError, YamlPath, load_text, resolves_to_string

SCHEMA_URL = "https://cv-tools.phonethk.com/schema/v2.json"
HEADER = f"# yaml-language-server: $schema={SCHEMA_URL}\n"


@dataclass
class Migration:
    text: str
    warnings: list[str] = field(default_factory=list)


def migrate_text(text: str, name: str = "<string>") -> Migration:
    """Convert v1 YAML text to v2 YAML text that renders the same PDF."""
    src = load_text(text, name)
    if v1.detect(src) != "v1":
        raise CVError("the file already uses the v2 format", name)
    conversion = v1.convert(src, clean=True)
    doc = _commented(conversion.data)
    _carry_comments(text, doc, conversion.origins)
    out = _dump(doc)
    _check(out, conversion.data, name)
    return Migration(out, conversion.warnings)


class MigrationError(CVError):
    """The migrated text does not load back as the converted data (a bug in cv-tools)."""


def _check(text: str, data: dict, name: str) -> None:
    try:
        reloaded = load_text(text, "<migrated>", yaml_version="1.2").data
    except CVError as e:
        problem = str(e)
    else:
        problem = _difference(reloaded, data, ())
        if problem is None:
            return
    raise MigrationError(
        f"internal error: the migrated file does not read back as the converted data ({problem}). "
        "Please report this bug at https://github.com/mlsdpk/cv-tools/issues with the v1 file.",
        name,
    )


def _difference(got: Any, want: Any, path: YamlPath) -> str | None:
    where = "".join(f"[{p!r}]" for p in path) or "the document"
    if isinstance(want, dict):
        if not isinstance(got, dict) or list(got) != list(want):
            return f"{where}: expected keys {list(want)}, got {got!r}"
        for key in want:
            found = _difference(got[key], want[key], path + (key,))
            if found:
                return found
        return None
    if isinstance(want, list):
        if not isinstance(got, list) or len(got) != len(want):
            return f"{where}: expected a list of {len(want)}, got {got!r}"
        for i, (g, w) in enumerate(zip(got, want)):
            found = _difference(g, w, path + (i,))
            if found:
                return found
        return None
    same = type(got) is type(want) and (got == want or (isinstance(want, float) and math.isnan(want) and math.isnan(got)))
    return None if same else f"{where}: expected {want!r}, got {got!r}"


def _commented(value: Any) -> Any:
    # Strings that YAML 1.1 reads as something else (yes, 2:1) are quoted too.
    if isinstance(value, dict):
        out = CommentedMap((k, _commented(v)) for k, v in value.items())
        if list(value) == ["latex"]:
            out.fa.set_flow_style()
            if _awkward(value["latex"]):
                out["latex"] = DoubleQuotedScalarString(value["latex"])
            elif "\n" not in value["latex"]:
                # ruamel writes some plain scalars in flow style that PyYAML
                # cannot read (such as "$?"); quoted LaTeX also reads better.
                out["latex"] = SingleQuotedScalarString(value["latex"])
        return out
    if isinstance(value, list):
        return CommentedSeq(_commented(v) for v in value)
    if isinstance(value, str) and (_awkward(value) or ("\n" not in value and not resolves_to_string(value))):
        return DoubleQuotedScalarString(value)
    return value


_AWKWARD = re.compile("[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\ufeff]")


def _awkward(text: str) -> bool:
    # Only a double-quoted scalar keeps these (YAML folds U+0085 and U+2028).
    return bool(_AWKWARD.search(text))


def _node(root: Any, path: YamlPath) -> Any:
    for part in path:
        try:
            root = root[part]
        except (KeyError, IndexError, TypeError):
            return None
    return root


def _carry_comments(text: str, doc: CommentedMap, origins: dict[YamlPath, YamlPath]) -> None:
    try:
        old = YAML().load(text)
    except YAMLError:
        return  # PyYAML read it; comments are a nicety
    if not isinstance(old, CommentedMap):
        return
    if old.ca.comment:
        doc.ca.comment = copy.deepcopy(old.ca.comment)
    for new_path, old_path in origins.items():
        if not new_path or not old_path:
            continue
        new_parent, old_parent = _node(doc, new_path[:-1]), _node(old, old_path[:-1])
        same_kind = (isinstance(new_parent, CommentedMap) and isinstance(old_parent, CommentedMap)) or (
            isinstance(new_parent, CommentedSeq) and isinstance(old_parent, CommentedSeq)
        )
        if same_kind and old_path[-1] in old_parent.ca.items and new_path[-1] not in new_parent.ca.items:
            new_parent.ca.items[new_path[-1]] = copy.deepcopy(old_parent.ca.items[old_path[-1]])
        new_node, old_node = _node(doc, new_path), _node(old, old_path)
        if (
            isinstance(new_node, (CommentedMap, CommentedSeq))
            and type(new_node) is type(old_node)
            and old_node.ca.comment
            and not new_node.ca.comment
        ):
            new_node.ca.comment = copy.deepcopy(old_node.ca.comment)


# Keeps ruamel.yaml from folding long scalars.
_UNLIMITED_WIDTH = 1 << 62


def _dump(doc: CommentedMap) -> str:
    yaml = YAML()
    yaml.width = _UNLIMITED_WIDTH
    yaml.indent(mapping=2, sequence=4, offset=2)
    buf = io.StringIO()
    yaml.dump(doc, buf)
    text = buf.getvalue()
    try:
        root = pyyaml.compose(text, Loader=pyyaml.SafeLoader)
    except pyyaml.YAMLError:
        return HEADER + text  # the self-check reports it
    lines = text.splitlines(keepends=True)
    _tidy_contact(lines, root)
    return HEADER + _blank_lines(lines, root)


def _top_level(root: Any, key: str) -> tuple[Any, Any]:
    for key_node, value_node in getattr(root, "value", None) or []:
        if isinstance(key_node, pyyaml.ScalarNode) and key_node.value == key:
            return key_node, value_node
    return None, None


def _blank_lines(lines: list[str], root: Any) -> str:
    """A blank line before ``contact``, ``sections`` and each section, placed from the parsed nodes."""
    starts = set()
    for key in ("contact", "sections"):
        key_node, _ = _top_level(root, key)
        if key_node is not None:
            starts.add(key_node.start_mark.line)
    _, sections = _top_level(root, "sections")
    if isinstance(sections, pyyaml.SequenceNode):
        starts.update(item.start_mark.line for item in sections.value)
    out = []
    for i, line in enumerate(lines):
        previous = lines[i - 1].strip() if i else ""
        if i in starts and previous and not previous.endswith(":") and not previous.startswith("#"):
            out.append("\n")
        out.append(line)
    return "".join(out)


def _last_line(node: Any) -> int:
    # A block collection's end mark is the next token, so use its last child.
    if isinstance(node, pyyaml.ScalarNode) or node.flow_style or not node.value:
        return node.end_mark.line
    last = node.value[-1]
    return _last_line(last[1] if isinstance(node, pyyaml.MappingNode) else last)


def _tidy_contact(lines: list[str], root: Any) -> None:
    """Write a contact line as ``- - item`` instead of ruamel's ``-   - item``."""
    _, contact = _top_level(root, "contact")
    if not isinstance(contact, pyyaml.SequenceNode):
        return
    for line_node in contact.value:
        items = line_node.value if isinstance(line_node, pyyaml.SequenceNode) and not line_node.flow_style else []
        if not items:
            continue
        first = items[0].start_mark.line
        rows = [first + k for k in range(len(items))]
        if any(item.start_mark.line != row or _last_line(item) != row for item, row in zip(items, rows)):
            continue
        if not lines[first].startswith("  -   - ") or not all(lines[r].startswith("      - ") for r in rows[1:]):
            continue
        lines[first] = "  - - " + lines[first][8:]
        for r in rows[1:]:
            lines[r] = "    - " + lines[r][8:]
