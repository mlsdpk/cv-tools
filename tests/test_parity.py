"""Parity A: a v1 file and its migration render the same PDF. Parity B: so do v1 (tests/legacy) and v2.

Fixtures under fixtures/v1-bugfix compare against v1 with that bug fixed by hand, or have tests in test_bugfixes.py.
"""

import io
import shutil
import subprocess
import re
import warnings
from contextlib import redirect_stderr

import pytest

from cv_tools import api
from cv_tools.migrate import migrate_text

from helpers import (
    ROOT,
    compare_pdfs,
    compile_result,
    fixture_dirs,
    legacy_result,
    legacy_tex,
    normalize_tex,
)

pytestmark = pytest.mark.tex

V1 = fixture_dirs("v1")
BUGFIX = fixture_dirs("v1-bugfix")


def _replace(*pairs):

    def fix(tex):
        for old, new in pairs:
            assert tex.count(old) == 1, f"the v1 output no longer contains {old!r} exactly once"
            tex = tex.replace(old, new)
        return tex

    return fix


def fix_url_padding(tex):
    """v1 wrote ``\\url{ x }``, with the spaces in the link target; v2 writes ``\\url{x}``."""
    return re.sub(r"\\url\{ ([^{}\s]*) \}", r"\\url{\1}", tex)


# Fixtures that hit a fixed v1 bug: the hand-made fix applied to v1's .tex.
LEGACY_FIXES = {
    # v1 printed ", , " for an entry without journal or booktitle.
    "master-example": _replace(("Comprehensive Guide}, , 2021", "Comprehensive Guide}, 2021")),
    # v1 printed "None" for null values; v2 treats null as absent.
    "null-values": _replace(
        (r"{\textbf{Uni}, None}", r"{\textbf{Uni}, }"),
        (r"\hfill None\medskip", r"\hfill \medskip"),
        ("{ None }", "{  }"),
        (r"{None}\item", r"{}\item"),
        ("& None &", "&  &"),
    ),
    # v1 bolded only exact name matches.
    "highlight-matching": _replace(
        (r"\item {John} Doe and", r"\item \textbf{{John} Doe} and"),
        (r"\item JOHN DOE and", r"\item \textbf{JOHN DOE} and"),
    ),
    # v1 applied its markdown conversion to BibTeX fields.
    "markdown-everywhere": _replace(
        (
            r"\emph{A ``Quoted'' Title with \textit{Stars}}, Journal of \textbf{Strong} Results",
            r"\emph{A 'Quoted' Title with *Stars*}, Journal of **Strong** Results",
        ),
    ),
    # v1 left out "von" parts and converted BibTeX fields.
    "publications-multi": _replace(
        (
            r"\item Ludwig Beethoven, \textbf{Wolfgang Amadeus Mozart} and Jr. Martin Luther King, "
            r"\emph{On the {Moonlight} Sonata and ``Other'' Works}",
            r"\item Ludwig van Beethoven, \textbf{Wolfgang Amadeus Mozart} and Jr. Martin Luther King, "
            r"\emph{On the {Moonlight} Sonata and 'Other' Works}",
        ),
        (r"\item Ludwig Beethoven, \emph{Symphonies", r"\item Ludwig van Beethoven, \emph{Symphonies"),
        (r"\item Ludwig Beethoven, \emph{A Single-Author", r"\item Ludwig van Beethoven, \emph{A Single-Author"),
        ("Workshop on \\textbf{Bold} Ideas", "Workshop on **Bold** Ideas"),
    ),
}

# Fixtures without a Parity B test. test_bugfixes.py asserts their new output.
NO_PARITY_B = {
    "missing-bib-fields": "v1 raised KeyError for an entry without author, title or year",
    "unknown-social": "v1 left an empty line inside \\address, a TeX error",
    "empty-bullets-section": "v1 wrote an itemize without items, a LaTeX error",
    "null-list-items": "v1 printed 'None' or an empty item for null list items; v2 drops them",
    "bib-latex": "v1 converted BibTeX fields, mangled URLs and printed empty fields",
    "von-heading": "v1 left out 'von' and 'Jr.' parts, so a heading name with 'van' never matched",
}


def load_quietly(path):
    with warnings.catch_warnings(), redirect_stderr(io.StringIO()):
        warnings.simplefilter("ignore", DeprecationWarning)
        return api.load(path)


def test_fixture_lists_are_consistent():
    bugfix = {d.name for d in BUGFIX}
    assert set(LEGACY_FIXES) <= bugfix | {"master-example"}
    assert set(NO_PARITY_B) <= bugfix
    assert bugfix == (set(LEGACY_FIXES) - {"master-example"}) | set(NO_PARITY_B)
    assert not set(LEGACY_FIXES) & set(NO_PARITY_B)


@pytest.mark.parametrize("fixture", V1 + BUGFIX, ids=lambda d: d.name)
def test_parity_a(fixture):
    config = fixture / "cv.yaml"
    v1_result = api.render_tex(load_quietly(config))

    migrated = migrate_text(config.read_text(encoding="utf-8"), str(config))
    doc = api.loads(migrated.text, "<migrated>", fixture)
    assert doc.source_format == "v2"
    v2_result = api.render_tex(doc)

    assert normalize_tex(v2_result.tex) == normalize_tex(v1_result.tex)
    diff = compare_pdfs(compile_result(v1_result), compile_result(v2_result), f"parity-a/{fixture.name}")
    assert not diff, diff.message


PARITY_B = [d for d in V1 + BUGFIX if d.name not in NO_PARITY_B]


@pytest.mark.parametrize("fixture", PARITY_B, ids=lambda d: d.name)
def test_parity_b(fixture):
    config = fixture / "cv.yaml"
    tex = fix_url_padding(legacy_tex(config))
    tex = LEGACY_FIXES.get(fixture.name, lambda t: t)(tex)
    expected = compile_result(legacy_result(tex))
    actual = compile_result(api.render_tex(load_quietly(config)))
    # No mask: the ORCID logo from orcid.pdf is pixel-identical to the TikZ drawing.
    diff = compare_pdfs(expected, actual, f"parity-b/{fixture.name}")
    assert not diff, diff.message


@pytest.mark.parametrize("name", sorted(LEGACY_FIXES))
def test_legacy_fixes_change_something(name):
    config = next(d for d in V1 + BUGFIX if d.name == name) / "cv.yaml"
    tex = legacy_tex(config)
    assert LEGACY_FIXES[name](tex) != tex


def test_url_padding_fix_is_exact():
    tex = "\\address{\n\\url{ https://x.org/a_b }  \n \\url{https://y.org} }\n\\url{ two words }"
    assert fix_url_padding(tex) == "\\address{\n\\url{https://x.org/a_b}  \n \\url{https://y.org} }\n\\url{ two words }"


def test_v2_example_renders_like_the_v1_example():
    v1_doc = load_quietly(ROOT / "examples" / "v1" / "cv.yaml")
    v2_doc = api.load(ROOT / "examples" / "cv.yaml")
    assert api.render_tex(v2_doc).tex == api.render_tex(v1_doc).tex


def test_normalize_tex_keeps_paragraph_breaks():
    assert normalize_tex("a  b\n  c\n\n\n  d % x\n% comment\ne") == "a b c\n\nd e"
    assert normalize_tex("a\n\nb") != normalize_tex("a b")
    assert normalize_tex(r"50\% off") == r"50\% off"


ORCID_PROBE = r"""\documentclass{resume}
\begin{document}
\setbox0\hbox{\orcidicon{0}}\typeout{ORCID normalsize \the\wd0\space\the\ht0\space\the\dp0}
""" + "".join(
    rf"{{\{size}\setbox0\hbox{{\orcidicon{{0}}}}\typeout{{ORCID {size} \the\wd0\space\the\ht0\space\the\dp0}}}}" + "\n"
    for size in ("tiny", "small", "large", "Large", "Huge")
) + "x\n\\end{document}\n"


def _orcid_boxes(tmp_path, cls_dir):
    for name in ("resume.cls", "orcid.pdf"):
        if (cls_dir / name).exists():
            shutil.copy(cls_dir / name, tmp_path / name)
    (tmp_path / "t.tex").write_text(ORCID_PROBE)
    subprocess.run(["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "t.tex"], cwd=tmp_path,
                   check=True, capture_output=True)
    return re.findall(r"^ORCID .*$", (tmp_path / "t.log").read_text(encoding="utf-8"), re.M)


def test_orcid_box_is_the_tikz_box(tmp_path):
    # The box decides where the next contact item goes, so it must equal the
    # one \scalerel* gave the TikZ drawing.
    (tmp_path / "legacy").mkdir()
    (tmp_path / "new").mkdir()
    legacy = _orcid_boxes(tmp_path / "legacy", ROOT / "tests" / "legacy" / "template")
    new = _orcid_boxes(tmp_path / "new", ROOT / "src" / "cv_tools" / "templates" / "latex")
    assert len(legacy) == 6
    assert new == legacy
