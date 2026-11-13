"""YAML loading with duplicate-key rejection and source positions."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Union

import yaml
from yaml.events import AliasEvent
from yaml.nodes import MappingNode, Node, ScalarNode, SequenceNode

YamlPath = tuple[Union[str, int], ...]

_TIMESTAMP = "tag:yaml.org,2002:timestamp"
_MERGE = "tag:yaml.org,2002:merge"
_MERGE_KEY = object()

# Stops alias bombs ("billion laughs"); far more than any CV repeats.
MAX_ALIAS_NODES = 10_000

# Deeper YAML would exhaust Python's recursion limit while it is read.
MAX_DEPTH = 100

# sys.get_int_max_str_digits: longer integers load as the string written.
_MAX_INT_DIGITS = 4300
_INT_LIMIT = 10**_MAX_INT_DIGITS


class CVError(Exception):
    """An error in a CV file, printed as ``file:line:col: message``."""

    def __init__(self, message: str, file: str | None = None, line: int | None = None, col: int | None = None):
        super().__init__(message)
        self.message = message
        self.file = file
        self.line = line
        self.col = col

    def __str__(self) -> str:
        return f"{self.location}: {self.message}" if self.location else self.message

    @property
    def location(self) -> str:
        return ":".join(str(p) for p in (self.file, self.line, self.col) if p is not None)

    def format(self, severity: str = "error") -> str:
        return f"{self.location}: {severity}: {self.message}" if self.location else f"{severity}: {self.message}"


@dataclass
class Source:
    """A parsed YAML document and the position of every node in it."""

    data: Any
    name: str
    text: str
    base_dir: Path
    positions: dict[YamlPath, tuple[int, int]] = field(default_factory=dict)
    key_positions: dict[YamlPath, tuple[int, int]] = field(default_factory=dict)
    yaml_version: str = "1.1"  # "1.2" for a v2 file
    # Paths reached through an alias or merge key, and paths inside a used
    # anchor, each with its anchor name (web-spec section 4.3).
    aliases: dict[YamlPath, str] = field(default_factory=dict)
    anchors: dict[YamlPath, str] = field(default_factory=dict)

    def position(self, path: YamlPath, key: bool = False) -> tuple[int, int] | None:
        """1-based (line, column) of ``path`` or its closest ancestor; ``key`` prefers the key's position."""
        path = tuple(path)
        if key and path in self.key_positions:
            return self.key_positions[path]
        while path not in self.positions and path:
            path = path[:-1]
        return self.positions.get(path)

    def error(self, message: str, path: YamlPath = (), key: bool = False) -> CVError:
        pos = self.position(path, key)
        return CVError(message, self.name, *(pos or (None, None)))


class _Loader(yaml.SafeLoader):
    """YAML 1.1 as v1 read it, but with duplicate keys rejected and timestamps kept as strings."""

    yaml_implicit_resolvers = {
        first: [r for r in resolvers if r[0] != _TIMESTAMP]
        for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
    }

    def __init__(self, stream):
        super().__init__(stream)
        self.anchor_of: dict[int, str] = {}
        self.aliased: set[int] = set()
        # (id(parent), index or id(key node)) -> (anchor, mark)
        self.alias_slots: dict[tuple[int, Any], tuple[str, Any]] = {}
        # (id(mapping), index of the pair) -> (anchor, mark), for aliases used as keys
        self.alias_keys: dict[tuple[int, int], tuple[str, Any]] = {}
        self.depth = 0

    def compose_node(self, parent, index):
        event = self.peek_event()
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise yaml.composer.ComposerError(
                None, None, f"the YAML is nested more than {MAX_DEPTH} levels deep", event.start_mark)
        try:
            node = super().compose_node(parent, index)
        finally:
            self.depth -= 1
        if isinstance(event, AliasEvent):
            self.aliased.add(id(node))
            if parent is not None and index is not None:
                slot = id(index) if isinstance(index, Node) else index
                self.alias_slots[(id(parent), slot)] = (event.anchor, event.start_mark)
            elif isinstance(parent, MappingNode):
                self.alias_keys[(id(parent), len(parent.value))] = (event.anchor, event.start_mark)
        elif event.anchor is not None:
            self.anchor_of[id(node)] = event.anchor
        return node

    def construct_yaml_int(self, node):
        value = self.construct_scalar(node)
        try:
            number = super().construct_yaml_int(node)
        except ValueError:
            return value
        return value if abs(number) >= _INT_LIMIT else number

    def construct_yaml_float(self, node):
        return _float_or_text(self.construct_scalar(node), super().construct_yaml_float(node))

    def construct_mapping(self, node, deep=False):
        if isinstance(node, MappingNode):
            seen: dict[Any, Any] = {}
            for key_node, _ in node.value:
                merge = key_node.tag == _MERGE
                key = _MERGE_KEY if merge else self.construct_object(key_node, deep=True)
                try:
                    first = seen.get(key)
                except TypeError:
                    continue  # unhashable; the base class reports it
                if first is not None:
                    raise yaml.constructor.ConstructorError(
                        None,
                        None,
                        f"duplicate key '{'<<' if merge else key}' (first defined on line {first.line + 1})",
                        key_node.start_mark,
                    )
                seen[key] = key_node.start_mark
        return super().construct_mapping(node, deep)


_Loader.add_constructor("tag:yaml.org,2002:int", _Loader.construct_yaml_int)
_Loader.add_constructor("tag:yaml.org,2002:float", _Loader.construct_yaml_float)


def _float_or_text(text: str, number: float) -> Union[float, str]:
    # Out of range: keep the text written, as for huge integers.
    if math.isinf(number) and "inf" not in text.lower():
        return text
    if number == 0 and re.search("[1-9]", text.lower().partition("e")[0]):
        return text
    return number


# YAML 1.2 core schema, as JSON Schema and JavaScript YAML libraries read it.
_CORE_RESOLVERS = [
    ("tag:yaml.org,2002:bool", r"^(?:true|True|TRUE|false|False|FALSE)$", "tTfF"),
    ("tag:yaml.org,2002:int", r"^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$", "-+0123456789"),
    (
        "tag:yaml.org,2002:float",
        r"^(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?"
        r"|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$",
        "-+.0123456789",
    ),
    ("tag:yaml.org,2002:null", r"^(?:~|null|Null|NULL|)$", ["~", "n", "N", ""]),
    ("tag:yaml.org,2002:merge", r"^(?:<<)$", "<"),
]


class _CoreLoader(_Loader):
    """YAML 1.2 core schema scalars, for v2 files (``yes`` and ``10:30`` stay strings)."""

    yaml_implicit_resolvers: dict = {}


for _tag, _pattern, _first in _CORE_RESOLVERS:
    _CoreLoader.add_implicit_resolver(_tag, re.compile(_pattern), list(_first))


def _core_int(loader: _CoreLoader, node: ScalarNode) -> Union[int, str]:
    value = loader.construct_scalar(node)
    if value.startswith("0o"):
        number = int(value[2:], 8)
    elif value.startswith("0x"):
        number = int(value[2:], 16)
    else:
        digits = value.lstrip("+-").lstrip("0")
        if len(digits) > _MAX_INT_DIGITS:
            return value
        number = int((value[0] if value[0] in "+-" else "") + (digits or "0"), 10)
    return value if abs(number) >= _INT_LIMIT else number


def _core_float(loader: _CoreLoader, node: ScalarNode) -> Union[float, str]:
    text = loader.construct_scalar(node)
    value = text.lower()
    sign = -1.0 if value.startswith("-") else 1.0
    if value.lstrip("+-") == ".inf":
        return sign * float("inf")
    if value == ".nan":
        return float("nan")
    return _float_or_text(text, float(value))


_CoreLoader.add_constructor("tag:yaml.org,2002:int", _core_int)
_CoreLoader.add_constructor("tag:yaml.org,2002:float", _core_float)

_LOADERS = {"1.1": _Loader, "1.2": _CoreLoader}


def describe(value: Any) -> str:
    """The type of a YAML value as error messages name it."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "a boolean"
    if isinstance(value, (int, float)):
        return "a number"
    if isinstance(value, str):
        return "a string"
    if isinstance(value, list):
        return "a list"
    if isinstance(value, dict):
        return "a mapping"
    return type(value).__name__


def _mark(m) -> tuple[int, int]:
    return (m.line + 1, m.column + 1)


class _Walk:
    """Records positions, aliases and anchors, and enforces the alias budget."""

    def __init__(self, loader: _Loader, src: Source):
        self.loader = loader
        self.src = src
        self.stack: set[int] = set()
        self.expanded = 0
        self.anchor_around: dict[int, str] = {}

    def alias(self, parent: Node, index: Any) -> Optional[tuple[str, Any]]:
        slot = id(index) if isinstance(index, Node) else index
        return self.loader.alias_slots.get((id(parent), slot))

    def members(self, node: MappingNode, outer: Optional[tuple[str, Any]]) -> list[tuple]:
        """``(owner, key node, value node, via, outermost via)`` per key, merges resolved as PyYAML does."""
        out: list[tuple] = []
        seen: set[Any] = set()

        def add(mapping: MappingNode, via: Optional[tuple[str, Any]], top: Optional[tuple[str, Any]],
                depth: int) -> None:
            if depth:
                if id(mapping) in self.stack or depth > 64:
                    raise self._error("a merge key refers to a mapping that contains it", via, mapping)
                # Each merged mapping counts, or a merge bomb would walk forever.
                self.count(outer or top, mapping)
            merges = []
            for i, (key_node, value_node) in enumerate(mapping.value):
                if key_node.tag == _MERGE:
                    merges.append((key_node, value_node))
                    continue
                if not isinstance(key_node, ScalarNode):
                    continue
                key = self.loader.construct_object(key_node)
                if key not in seen:
                    seen.add(key)
                    # A value under an alias key has no path that setIn can reach.
                    key_alias = self.loader.alias_keys.get((id(mapping), i))
                    out.append((mapping, key_node, value_node, via or key_alias, top or key_alias))
            for key_node, value_node in merges:
                alias = self.alias(mapping, key_node)
                if isinstance(value_node, MappingNode):
                    sources = [(value_node, alias)]
                elif isinstance(value_node, SequenceNode):
                    sources = [(m, self.alias(value_node, i)) for i, m in enumerate(value_node.value)]
                else:
                    continue  # not a mapping; the constructor reports it
                for source, source_alias in sources:
                    if not isinstance(source, MappingNode):
                        continue
                    name = source_alias or (self.loader.anchor_of.get(id(source), "<<"), source.start_mark)
                    add(source, name, top or name, depth + 1)

        add(node, None, None, 0)
        return out

    def count(self, outer: Optional[tuple[str, Any]], node: Node) -> None:
        self.expanded += 1
        if self.expanded > MAX_ALIAS_NODES:
            raise self._error(
                f"aliases expand to more than {MAX_ALIAS_NODES} nodes; "
                "write the repeated values out or use fewer aliases", outer, node)

    def _error(self, message: str, via: Optional[tuple[str, Any]], node: Node) -> CVError:
        mark = via[1] if via else node.start_mark
        return CVError(message, self.src.name, *_mark(mark))

    def record(self, node: Node, path: YamlPath, via: Optional[str], anchor: Optional[str],
               alias: Optional[tuple[str, Any]] = None, outer: Optional[tuple[str, Any]] = None) -> None:
        """Record ``node`` and everything below it. ``via`` is the last alias on
        the path, ``outer`` the first one (where a budget error points)."""
        src = self.src
        src.positions.setdefault(path, _mark(node.start_mark))
        if alias is not None:
            if id(node) in self.stack:
                raise self._error(f"alias *{alias[0]} refers to a node that contains it", alias, node)
            via, outer = alias[0], outer or alias
        if via is not None:
            self.count(outer, node)
            # The anchor around the original, so it matches that place's data-anchor.
            src.aliases[path] = self.anchor_around.get(id(node), via)
        else:
            if id(node) in self.loader.aliased and id(node) in self.loader.anchor_of:
                anchor = self.loader.anchor_of[id(node)]
            if anchor is not None:
                src.anchors[path] = anchor
                self.anchor_around.setdefault(id(node), anchor)
        if not isinstance(node, (MappingNode, SequenceNode)):
            return
        self.stack.add(id(node))
        if isinstance(node, MappingNode):
            for owner, key_node, value_node, merged, top in self.members(node, outer):
                child = path + (self.loader.construct_object(key_node),)
                src.key_positions.setdefault(child, _mark(key_node.start_mark))
                child_via, child_outer = (merged[0], outer or top) if merged else (via, outer)
                self.record(value_node, child, child_via, anchor, self.alias(owner, key_node), child_outer)
        else:
            for i, item in enumerate(node.value):
                self.record(item, path + (i,), via, anchor, self.alias(node, i), outer)
        self.stack.discard(id(node))


def _record(loader: _Loader, node: Node, src: Source) -> None:
    _Walk(loader, src).record(node, (), None, None)


def load_text(text: str, name: str = "<string>", base_dir: Path | None = None, yaml_version: str = "auto") -> Source:
    """Parse YAML text, raising :class:`CVError` with a position on any error.

    ``"auto"`` reads YAML 1.2 when the file has a ``version`` other than 1, else YAML 1.1.
    """
    if yaml_version != "auto":
        return _parse(text, name, base_dir, _LOADERS[yaml_version])
    try:
        src = _parse(text, name, base_dir, _CoreLoader)
    except CVError as e:
        try:
            src = _parse(text, name, base_dir, _Loader)
        except CVError:
            raise e from None
        if isinstance(src.data, dict) and "version" in src.data:
            raise e from None
        return src
    if isinstance(src.data, dict) and "version" in src.data and not _is_v1(src.data["version"]):
        return src
    return _parse(text, name, base_dir, _Loader)


def _is_v1(version: Any) -> bool:
    return not isinstance(version, bool) and isinstance(version, (int, float)) and version == 1


def _parse(text: str, name: str, base_dir: Path | None, loader_class: type) -> Source:
    src = Source(None, name, text, base_dir or Path.cwd())
    src.yaml_version = "1.2" if loader_class is _CoreLoader else "1.1"
    loader = None
    try:
        loader = loader_class(text)
        node = loader.get_single_node()
        if node is not None:
            _record(loader, node, src)
            src.data = loader.construct_document(node)
    except yaml.reader.ReaderError as e:
        raise CVError(f"character U+{e.character:04X} is not allowed in YAML", name,
                      *_text_position(text, e.position)) from None
    except yaml.MarkedYAMLError as e:
        mark = e.problem_mark or e.context_mark
        problem = e.problem or e.context or "invalid YAML"
        raise CVError(problem, name, *(_mark(mark) if mark else (None, None))) from None
    except yaml.YAMLError as e:
        raise CVError(f"invalid YAML: {e}", name) from None
    finally:
        if loader is not None:
            loader.dispose()
    return src


def _text_position(text: str, index: int) -> tuple[int, int]:
    before = re.sub("\r\n", "\n", text[:index])
    lines = re.split("[\n\r\x85\u2028\u2029]", before)
    return len(lines), len(lines[-1]) + 1


def resolves_to_string(value: str) -> bool:
    """True if ``value`` as a plain scalar is a string in YAML 1.1 and 1.2."""
    for resolver in (yaml.SafeLoader, _CoreLoader):
        tag = resolver.resolve(resolver, ScalarNode, value, (True, False))  # type: ignore[arg-type]
        if tag != "tag:yaml.org,2002:str":
            return False
    return True


def load_file(path: str | Path) -> Source:
    path = Path(path)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        raise CVError(f"cannot read file: {e.strerror}", str(path)) from None
    except UnicodeDecodeError:
        raise CVError("file is not valid UTF-8", str(path)) from None
    return load_text(text, str(path), path.resolve().parent)
