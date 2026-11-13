"""YAML loading: duplicate keys, positions, errors."""

import pytest

from cv_tools import api, v1
from cv_tools.loader import CVError, load_file, load_text, resolves_to_string
from cv_tools.markup import Latex
from cv_tools.migrate import migrate_text
from cv_tools.validate import validate

from helpers import FIXTURES


def test_positions_are_one_based():
    src = load_text("a: 1\nb:\n  - x\n  - {c: 2}\n", "f.yaml")
    assert src.position(("a",)) == (1, 4)
    assert src.position(("b", 1, "c")) == (4, 9)
    assert src.position(("b", 1, "c"), key=True) == (4, 6)
    # Unknown paths fall back to the closest known ancestor.
    assert src.position(("b", 1, "missing", 3)) == (4, 5)
    assert src.position(()) == (1, 1)


def test_duplicate_key_is_rejected_with_both_lines():
    text = "name: a\nsections:\n  - title: x\n    title: y\n"
    with pytest.raises(CVError) as info:
        load_text(text, "cv.yaml")
    e = info.value
    assert (e.file, e.line, e.col) == ("cv.yaml", 4, 5)
    assert e.message == "duplicate key 'title' (first defined on line 3)"
    assert str(e) == "cv.yaml:4:5: duplicate key 'title' (first defined on line 3)"


def test_duplicate_key_in_the_old_example():
    # The v1 example on master had `year` twice; v1 silently kept the last one.
    with pytest.raises(CVError) as info:
        load_file(FIXTURES / "invalid" / "duplicate-key-v1.yaml")
    assert info.value.line == 130
    assert "duplicate key 'year' (first defined on line 129)" in info.value.message


def test_merge_keys_are_not_duplicates():
    src = load_text("base: &b {x: 1}\nother:\n  <<: *b\n  y: 2\n")
    assert src.data["other"] == {"x": 1, "y": 2}


@pytest.mark.parametrize("version", ["", "version: 2\n"])
def test_two_merge_keys_in_one_mapping_are_duplicates(version):
    text = version + "a: &a {x: 1}\nb: &b {y: 2}\nc:\n  <<: *a\n  <<: *b\n"
    with pytest.raises(CVError) as info:
        load_text(text, "f.yaml")
    first = text.splitlines().index("  <<: *a") + 1
    assert info.value.message == f"duplicate key '<<' (first defined on line {first})"
    assert (info.value.line, info.value.col) == (first + 1, 3)


@pytest.mark.parametrize("text, position", [
    ("version: 2\nname: a\x01b\n", (2, 8)),
    ("name: x\r\nfoo: \x7f\n", (2, 6)),
])
def test_control_characters_are_errors_with_a_position(text, position):
    with pytest.raises(CVError) as info:
        api.loads(text, name="cv.yaml")
    assert (info.value.file, info.value.line, info.value.col) == ("cv.yaml", *position)
    assert "is not allowed in YAML" in info.value.message


def test_deep_nesting_is_an_error_with_a_position():
    for text in ("version: 2\nname: N\ncontact:\n  - " + "[" * 5000 + "x" + "]" * 5000 + "\n",
                 "x: " + "{a: " * 5000 + "x" + "}" * 5000 + "\n"):
        with pytest.raises(CVError) as info:
            load_text(text, "cv.yaml")
        assert "nested more than 100 levels" in info.value.message and info.value.line is not None


def test_timestamps_stay_strings():
    assert load_text("date: 2024-05-01\n").data == {"date": "2024-05-01"}
    assert load_text("version: 2\ndate: 2024-05-01\n").data == {"version": 2, "date": "2024-05-01"}


SCALARS = "[yes, No, on, OFF, y, 2:1, 10:30, 1:20:30, 017, 0o17, 0x1F, 0b101, 1_000, 1e3, .5, +12, true, FALSE, ~, null, .inf, .NaN]"


def test_v2_files_use_yaml_1_2_core_scalars():
    # Only true/false are booleans, no base-60 numbers, 017 is decimal.
    src = load_text(f"version: 2\nx: {SCALARS}\n")
    assert src.yaml_version == "1.2"
    x = src.data["x"]
    assert x[:-2] == [
        "yes", "No", "on", "OFF", "y", "2:1", "10:30", "1:20:30", 17, 15, 31, "0b101", "1_000", 1000.0, 0.5, 12,
        True, False, None, None,
    ]
    assert x[-2] == float("inf") and x[-1] != x[-1]


@pytest.mark.parametrize("scalar", ["-0", "+0", "-00"])
def test_signed_zeros_are_numbers(scalar):
    assert load_text(f"version: 2\nx: {scalar}\n").data["x"] == 0
    assert load_text(f"x: {scalar}\n").data["x"] == 0
    doc = api.loads(f"version: 2\nname: N\nsections:\n  - {{title: T, layout: pairs, entries: [{{title: A, text: {scalar}}}]}}\n")
    assert doc.sections[0].entries[0].text == 0


@pytest.mark.parametrize("scalar", ["1e400", "1.0e999", "-1.5E+400", "1e-400"])
def test_floats_out_of_range_load_as_strings(scalar):
    assert load_text(f"version: 2\nx: {scalar}\n").data["x"] == scalar
    doc = api.loads(f"version: 2\nname: {scalar}\nsections: []\n")
    assert scalar in api.render_tex(doc).tex


def test_v1_floats_out_of_range_load_as_strings():
    assert load_text("x: [1.0e+999, -2.5e-400, 1.5e+3, 0.0e+5]\n").data["x"] == ["1.0e+999", "-2.5e-400", 1500.0, 0.0]
    assert load_text("version: 2\nx: [.inf, 1e3, 0e-999]\n").data["x"] == [float("inf"), 1000.0, 0.0]


def test_v1_files_keep_yaml_1_1_scalars():
    # v1 rendered what PyYAML loaded, so the v1 path keeps YAML 1.1.
    src = load_text(f"heading: {{name: x}}\nx: {SCALARS}\n")
    assert src.yaml_version == "1.1"
    x = src.data["x"]
    assert x[:-2] == [
        True, False, True, False, "y", 121, 630, 4830, 15, "0o17", 31, 5, 1000, "1e3", 0.5, 12, True, False, None, None,
    ]


def test_yaml_version_can_be_chosen():
    assert load_text("x: yes\n", yaml_version="1.2").data == {"x": "yes"}
    assert load_text("version: 2\nx: yes\n", yaml_version="1.1").data == {"version": 2, "x": True}


def test_a_v2_syntax_error_is_reported_from_the_v2_reading():
    with pytest.raises(CVError) as info:
        load_text("version: 2\nname: [x\n", "cv.yaml")
    assert info.value.line == 3


@pytest.mark.parametrize(
    "value, plain",
    [
        ("Jane Roe", True), ("2:1", False), ("yes", False), ("on", False), ("2024-05-01", False), ("1e3", False),
        ("017", False), ("1_000", False), ("null", False), ("", False), ("=", False), ("<<", False), ("y", True),
        ("10:30 am", True),
    ],
)
def test_resolves_to_string_under_both_versions(value, plain):
    assert resolves_to_string(value) is plain


def test_syntax_error_has_position():
    with pytest.raises(CVError) as info:
        load_text("a: [1, 2\nb: 3\n", "bad.yaml")
    assert info.value.file == "bad.yaml"
    assert info.value.line == 2


def test_empty_document():
    assert load_text("").data is None


def test_unreadable_files(tmp_path):
    with pytest.raises(CVError, match="cannot read file"):
        load_file(tmp_path / "missing.yaml")
    bad = tmp_path / "latin1.yaml"
    bad.write_bytes(b"name: Jos\xe9\n")
    with pytest.raises(CVError, match="not valid UTF-8"):
        load_file(bad)


def test_error_format():
    assert CVError("m", "f", 1, 2).format("warning") == "f:1:2: warning: m"
    assert CVError("m").format() == "error: m"


# JSON Schema's "const": 2 accepts any number equal to 2, but no string or boolean.
@pytest.mark.parametrize(
    "text, fmt, yaml_version",
    [
        ("version: 2\n", "v2", "1.2"),
        ("version: 2.0\n", "v2", "1.2"),
        ("version: 0x2\n", "v2", "1.2"),
        ("base: &b {version: 2}\n<<: *b\n", "v2", "1.2"),  # set through a merge key
        ("version: 1\n", "v1", "1.1"),
        ("version: 1.0\n", "v1", "1.1"),
    ],
)
def test_version_values(text, fmt, yaml_version):
    src = load_text(text + "name: x\n")
    assert (v1.detect(src), src.yaml_version) == (fmt, yaml_version)
    if fmt == "v2":
        version_errors = [e for e in validate(src) if e.message.startswith("version")]
        assert version_errors == []  # the schema agrees


@pytest.mark.parametrize(
    "text, message",
    [
        ('version: "2"\n', "unsupported version '2': the version is a number; write 'version: 2' without quotes"),
        ("version: '1'\n", "unsupported version '1': the version is a number; write 'version: 1' without quotes"),
        ("version: true\n", "unsupported version True: expected 'version: 2'"),
        ("version: 2.5\n", "unsupported version 2.5: expected 'version: 2'"),
    ],
)
def test_rejected_version_values(text, message):
    src = load_text(text + "name: x\n")
    with pytest.raises(CVError) as info:
        v1.detect(src)
    assert info.value.message.startswith(message)
    assert (info.value.line, info.value.col) == (1, 10)
    # The schema rejects them too, so an editor shows the same problem.
    assert any(e.message.startswith("version: ") for e in validate(src))


def test_version_1_is_the_v1_format(capsys):
    # YAML 1.1 typing, the deprecation notice, and no warning about the version key.
    text = "version: 1\nheading: {name: Jane Roe}\nsections:\n  - {type: bullets, title: T, content: [{item: yes}]}\n"
    with pytest.warns(DeprecationWarning):
        doc = api.loads(text, "cv.yaml")
    assert doc.source_format == "v1"
    assert doc.warnings == []
    assert doc.sections[0].entries[0].text == Latex("True")  # v1 printed YAML 1.1's yes as True
    assert "uses the v1 format, which is deprecated" in capsys.readouterr().err
    out = migrate_text(text, "cv.yaml")
    assert out.warnings == []
    assert load_text(out.text).data["version"] == 2


# -- aliases and merges

ALIASES = FIXTURES / "aliases" / "cv.yaml"


def test_paths_through_aliases_and_merge_keys_are_recorded():
    src = load_file(ALIASES)
    # A scalar alias (name: &nm, then *nm in a contact line).
    assert src.anchors[("name",)] == "nm"
    assert src.aliases[("contact", 1, "items", 1)] == "nm"
    assert ("contact", 1, "items", 0) not in src.aliases
    # A whole entry as an alias, and an entry that merges it and overrides the date.
    assert src.anchors[("sections", 0, "entries", 0)] == "base"
    assert src.anchors[("sections", 0, "entries", 0, "title")] == "base"
    assert src.aliases[("sections", 0, "entries", 2)] == "base"
    assert src.aliases[("sections", 0, "entries", 2, "title")] == "base"
    assert src.aliases[("sections", 0, "entries", 1, "title")] == "base"
    assert ("sections", 0, "entries", 1) not in src.aliases  # the mapping itself is written in place
    assert ("sections", 0, "entries", 1, "date") not in src.aliases  # the override
    # A list alias; copies of a nested anchor name the innermost anchor.
    assert src.anchors[("sections", 0, "entries", 0, "bullets", 1)] == "bl"
    for entry in (1, 2, 3):
        assert src.aliases[("sections", 0, "entries", entry, "bullets", 0)] == "bl"
    # A section alias, down to the string of a {latex: ...} value.
    assert src.anchors[("sections", 2)] == "sec"
    assert src.aliases[("sections", 4)] == "sec"
    assert src.aliases[("sections", 4, "entries", 2, "text", "latex")] == "sec"
    assert src.anchors[("sections", 2, "entries", 2, "text", "latex")] == "sec"
    # An anchor that nothing uses marks nothing.
    assert ("contact", 1, "separator") not in src.anchors
    # Positions inside an alias are those of the anchored original.
    assert src.position(("sections", 4, "title")) == src.position(("sections", 2, "title"))


def test_merge_precedence_matches_pyyaml():
    text = "a: &a {x: 1, y: 1}\nb: &b {x: 2, z: 2}\nc:\n  <<: [*a, *b]\n  y: 3\n"
    src = load_text(text)
    assert src.data["c"] == {"x": 1, "y": 3, "z": 2}
    assert src.aliases[("c", "x")] == "a" and src.aliases[("c", "z")] == "b"
    assert ("c", "y") not in src.aliases


def alias_bomb(levels: int) -> str:
    """Ten aliases per level, so the entries expand to 10**levels strings."""
    lines = ["version: 2", "name: Bomb", "sections:", "  - title: T", "    layout: list",
             '    description: &a0 ["lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol"]']
    for i in range(1, levels):
        lines.append(f"    x{i}: &a{i} [" + ", ".join([f"*a{i - 1}"] * 10) + "]")
    lines.append(f"    entries: *a{levels - 1}")
    return "\n".join(lines) + "\n"


@pytest.mark.parametrize("levels", [5, 9])
def test_alias_bomb_fails_fast_with_a_position(levels):
    import time

    start = time.perf_counter()
    with pytest.raises(CVError) as info:
        api.loads(alias_bomb(levels), name="cv.yaml")
    assert time.perf_counter() - start < 1
    e = info.value
    assert "aliases expand to more than 10000 nodes" in e.message
    # The outermost alias on the path, in x3, where the budget runs out.
    assert (e.file, e.line) == ("cv.yaml", 9)
    assert alias_bomb(levels).splitlines()[8][e.col - 1 :].startswith("*a2")


def merge_bomb(levels: int, fan: int = 9) -> str:
    """Each mapping merges ``fan`` copies of the one before."""
    lines = ["version: 2", "name: Bomb", "contact:", "  - - &a0 {k: v}"]
    for i in range(1, levels):
        lines.append(f"    - &a{i} {{<<: [" + ", ".join([f"*a{i - 1}"] * fan) + "]}")
    lines.append(f"    - {{<<: *a{levels - 1}}}")
    return "\n".join(lines) + "\n"


@pytest.mark.parametrize("levels", [6, 11])
def test_merge_bomb_fails_fast_with_a_position(levels):
    import time

    start = time.perf_counter()
    with pytest.raises(CVError) as info:
        load_text(merge_bomb(levels), "cv.yaml")
    assert time.perf_counter() - start < 1
    e = info.value
    assert "aliases expand to more than 10000 nodes" in e.message
    assert (e.line, e.col) == (9, 17) and merge_bomb(levels).splitlines()[8][16:].startswith("*a4")


def test_reasonable_aliasing_loads():
    # A section repeated through an alias many times stays far below the budget.
    section = "  - &s {title: T, layout: list, entries: [" + ", ".join(f"item {i}" for i in range(40)) + "]}\n"
    text = "version: 2\nname: X\nsections:\n" + section + "  - *s\n" * 50
    doc = api.loads(text)
    assert len(doc.sections) == 51


@pytest.mark.parametrize(
    "text, message",
    [
        ("a: &a [*a]\n", "alias *a refers to a node that contains it"),
        ("a: &a {<<: *a}\n", "a merge key refers to a mapping that contains it"),
    ],
)
def test_recursive_aliases_are_errors(text, message):
    with pytest.raises(CVError) as info:
        load_text(text, "f.yaml")
    assert info.value.message == message and info.value.line == 1


# -- huge numbers

HUGE = "9" * 5000


@pytest.mark.parametrize(
    "scalar", [HUGE, "-" + HUGE, "0x" + "f" * 4000, "0o" + "7" * 5000],
)
def test_integers_python_cannot_print_load_as_strings(scalar):
    # Python refuses int <-> str conversions of more than 4300 digits.
    for text in (f"version: 2\nx: {scalar}\n", f"x: {scalar}\n"):
        assert load_text(text).data["x"] == scalar


def test_long_integers_below_the_limit_stay_numbers():
    assert load_text("version: 2\nx: " + "9" * 4300 + "\n").data["x"] == int("9" * 4300)
    assert load_text("version: 2\nx: 0x" + "f" * 100 + "\n").data["x"] == int("f" * 100, 16)
    assert load_text("version: 2\nx: 00" + "1" * 4300 + "\n").data["x"] == int("1" * 4300)
    assert load_text("x: 0b" + "1" * 100 + "\n").data["x"] == 2**100 - 1


def test_huge_number_as_a_name_renders():
    doc = api.loads(f"version: 2\nname: {HUGE}\nsections: []\n")
    assert doc.name == HUGE
    assert HUGE in api.render_html(doc).html
    assert HUGE in api.render_tex(doc).tex
