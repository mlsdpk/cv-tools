"""Characters pdflatex cannot print are reported before compiling, with their place in the file."""

import io
import os
import re
import subprocess
import sys
import warnings
from contextlib import redirect_stderr

import pytest

from cv_tools import api, charset
from cv_tools.render.latex import TEMPLATE_DIR
from cv_tools.validate import ValidationError

from helpers import ROOT, compile_result, page_count

sys.path.insert(0, str(ROOT / "tools"))
import derive_unicode  # noqa: E402

# Greek letters (with the variants ϑ ϕ ϵ ϱ ς) and the math symbols resume.cls declares.
GREEK = "αβγδεζηθικλμνξοπρςστυφχψω" + "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ" + "ϑϕϖϱϵ"
SYMBOLS = "≤≥≠≈∼→←↔⇒∞∈∉⊂∑∏√∂∇°·×"


def message(c, name):
    return (f"the character '{c}' (U+{ord(c):04X} {name}) cannot be printed by pdflatex with the fonts "
            "of the cv-tools class; replace it or leave it out")


def errors(text, base_dir=None):
    with pytest.raises(ValidationError) as info:
        api.loads(text, "cv.yaml", base_dir)
    return [str(e) for e in info.value.errors]


def test_supported_set():
    chars = {chr(cp) for cp in charset.supported()}
    assert set(GREEK + SYMBOLS) <= chars
    assert set("éüßØłőŁČ—–“”‘’…€†•µ¡¿") <= chars
    for c in "😀漢字ąðĄÐ«»":
        assert c not in chars, c
    assert all(cp > 0x7F for cp in charset.supported())


def test_unicode_txt_is_generated():
    text = (TEMPLATE_DIR / "unicode.txt").read_text(encoding="utf-8")
    assert text.startswith(derive_unicode.HEADER)
    codes = [line.split()[0] for line in text.splitlines() if not line.startswith("#")]
    assert codes == sorted(codes, key=lambda c: int(c, 16))
    assert len(codes) == len(charset.supported()) > 300


@pytest.mark.parametrize(
    "line, col, c, name",
    [
        (7, 15, "😀", "GRINNING FACE"),
        (8, 15, "漢", "CJK UNIFIED IDEOGRAPH-6F22"),
        (9, 23, "ą", "LATIN SMALL LETTER A WITH OGONEK"),
        (10, 22, "ð", "LATIN SMALL LETTER ETH"),
    ],
)
def test_unsupported_characters_are_named_with_their_place(line, col, c, name):
    text = ("version: 2\nname: Jane Roe\nsections:\n  - title: T\n    layout: list\n    entries:\n"
            "      - Smile 😀 now\n      - Kanji 漢 here\n      - 'Name: Józef Mąka'\n      - {latex: Sigurðsson}\n")
    found = errors(text)
    assert f"cv.yaml:{line}:{col}: sections[0].entries[{line - 7}]: {message(c, name)}" in found
    assert len(found) == 4


def test_every_distinct_character_is_reported_once_per_field():
    text = "version: 2\nname: Jane Roe\ncontact:\n  - [ðð ą ð]\n"
    assert errors(text) == [
        f"cv.yaml:4:6: contact[0][0]: {message('ð', 'LATIN SMALL LETTER ETH')}",
        f"cv.yaml:4:9: contact[0][0]: {message('ą', 'LATIN SMALL LETTER A WITH OGONEK')}",
    ]


def test_an_escaped_character_points_at_the_value():
    # "\u0105" is not in the file as written, so the error points at the string.
    text = 'version: 2\nname: Jane Roe\ndate: "x \\u0105"\n'
    assert errors(text) == [f"cv.yaml:3:7: date: {message('ą', 'LATIN SMALL LETTER A WITH OGONEK')}"]


def test_urls_may_hold_any_character():
    # Link targets, url items and social links are percent-encoded or read by hyperref.
    text = ("version: 2\nname: Jane Roe\ncontact:\n  - [{url: 'https://例.com/ð'}, {github: 'https://ð.org'}]\n"
            "sections:\n  - title: T\n    layout: list\n    entries:\n      - '[ok](https://例.com/ð)'\n"
            "      - {latex: '\\href{https://ð.org}{ok} \\url{https://例.com}'}\n")
    api.loads(text)


def test_names_and_titles_are_checked_upper_cased():
    # \MakeUppercase turns ḍ into Ḍ, which LaTeX does not declare. In a bullet ḍ prints.
    upper = ("the character 'ḍ' (U+1E0D LATIN SMALL LETTER D WITH DOT BELOW) becomes 'Ḍ' in the upper-cased "
             "name or section title, which pdflatex cannot print with the fonts of the cv-tools class; "
             "leave it out of the name and titles")
    text = "version: 2\nname: Aḍa\nsections:\n  - title: Aḍb\n    layout: list\n    entries: [Aḍa]\n"
    assert errors(text) == [f"cv.yaml:2:8: name: {upper}", f"cv.yaml:4:13: sections[0].title: {upper}"]
    api.loads(text.replace("Aḍa\nsections", "Ada\nsections").replace("Aḍb", "Adb"))


def test_bib_fields_are_checked(tmp_path):
    (tmp_path / "p.bib").write_text(
        "@article{good, author = {Jane Roe and Ana Ψ}, title = {On α and ∞}, journal = {J}, year = {2020}}\n"
        "@inproceedings{bad, author = {Jón Sigurðsson}, title = {漢字}, booktitle = {Conf 😀}, year = {2021},\n"
        "  url = {https://ð.org}}\n",
        encoding="utf-8",
    )
    text = "version: 2\nname: Jane Roe\nsections:\n  - {title: P, layout: publications, bib: p.bib}\n"
    bib = tmp_path / "p.bib"
    assert errors(text, tmp_path) == [
        f"{bib}: entry 'bad', field 'author': {message('ð', 'LATIN SMALL LETTER ETH')}",
        f"{bib}: entry 'bad', field 'title': {message('漢', 'CJK UNIFIED IDEOGRAPH-6F22')}",
        f"{bib}: entry 'bad', field 'title': {message('字', 'CJK UNIFIED IDEOGRAPH-5B57')}",
        f"{bib}: entry 'bad', field 'booktitle': {message('😀', 'GRINNING FACE')}",
    ]


def test_v1_files_are_checked_at_the_v1_place(tmp_path):
    text = 'heading:\n  name: Jane Roe\nsections:\n  - type: bullets\n    title: T\n    content:\n      - item: "a ð"\n'
    with warnings.catch_warnings(), redirect_stderr(io.StringIO()), pytest.raises(ValidationError) as info:
        warnings.simplefilter("ignore")
        api.loads(text, "cv.yaml")
    assert [str(e) for e in info.value.errors] == [f"cv.yaml:7:18: {message('ð', 'LATIN SMALL LETTER ETH')}"]


def test_cli_reports_the_character(tmp_path):
    (tmp_path / "cv.yaml").write_text("version: 2\nname: Jane 😀 Roe\n", encoding="utf-8")
    r = subprocess.run([sys.executable, "-m", "cv_tools", "build", "cv.yaml", "--tex-only"], cwd=tmp_path,
                       capture_output=True, text=True, encoding="utf-8", env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    assert r.returncode == 1
    assert r.stderr.startswith("cv.yaml:2:12: error: name: the character '😀' (U+1F600 GRINNING FACE)")
    assert not (tmp_path / "cv.tex").exists()


@pytest.mark.tex
def test_every_supported_character_compiles(tmp_path):
    # Every character of unicode.txt, in a bullet, in bold, in italic, in a
    # dated cell and in a .bib title; Greek and symbols also in the section title.
    chars = "".join(chr(cp) for cp in sorted(charset.supported()))
    upper_safe = "".join(c for c in chars if all(charset.prints(u) for u in c.upper()))
    (tmp_path / "p.bib").write_text(f"@article{{a, author = {{Jane Roe}}, title = {{{chars}}}, year = {{2020}}}}\n",
                                    encoding="utf-8")
    import json

    q = json.dumps
    text = (f"version: 2\nname: {q(GREEK)}\nsections:\n"
            f"  - title: {q(upper_safe)}\n    layout: list\n    entries:\n"
            f"      - {q(chars)}\n      - {q('**' + chars + '**')}\n      - {q('*' + chars + '*')}\n"
            f"  - title: {q(GREEK + SYMBOLS)}\n    layout: dated\n    entries:\n      - {{date: 'α 2020', text: {q(chars)}}}\n"
            "  - {title: P, layout: publications, bib: p.bib}\n")
    pdf = compile_result(api.render_tex(api.loads(text, "cv.yaml", tmp_path)))
    assert page_count(pdf) >= 1


@pytest.mark.tex
def test_greek_and_symbols_print_as_math():
    text = f"version: 2\nname: x\nsections:\n  - title: T\n    layout: text\n    entries: ['{GREEK} {SYMBOLS}']\n"
    pdf = compile_result(api.render_tex(api.loads(text)))
    out = subprocess.run(["pdftotext", "-", "-"], input=pdf, capture_output=True).stdout.decode()
    assert "αβγδ" in out.replace(" ", "") and "≤" in out


@pytest.mark.tex
def test_class_declares_only_what_latex_leaves_out(tmp_path):
    # resume.cls must not change how a character LaTeX supports prints.
    latex, _ = derive_unicode.latex_declarations(tmp_path)
    ours = derive_unicode.declared(TEMPLATE_DIR / "resume.cls")
    assert {ord(c) for c in GREEK + SYMBOLS} - latex <= ours
    assert not ours & latex
    assert re.findall(r"DeclareUnicodeCharacter\{(\w+)\}", (TEMPLATE_DIR / "resume.cls").read_text(encoding="utf-8"))
