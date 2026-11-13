"""v1 bugs that v2 fixes for v1 input too. Each test shows the old and the new behaviour."""

import io
import re
import subprocess
import warnings
from contextlib import redirect_stderr

import pytest

from cv_tools import api, model
from cv_tools.engine import EngineError
from cv_tools.markup import Latex, to_latex
from cv_tools.render import latex

from helpers import FIXTURES, compile_result, legacy_result, legacy_tex, link_targets

BUGFIX = FIXTURES / "v1-bugfix"


def load_v1(path):
    with warnings.catch_warnings(), redirect_stderr(io.StringIO()):
        warnings.simplefilter("ignore", DeprecationWarning)
        return api.load(path)


def load(name):
    return load_v1(BUGFIX / name / "cv.yaml")


def items(tex):
    return [line.strip()[len(r"\item ") :] for line in tex.splitlines() if line.strip().startswith(r"\item ")]


def test_missing_bib_fields_are_left_out():
    doc = load("missing-bib-fields")
    assert items(api.render_tex(doc).tex) == [
        r"\textbf{Jane Roe}, \emph{A Book Without a Venue}, 2020.",
        r"\textbf{Jane Roe}, \emph{An Empty Journal Field}, 2021.",
        r"\emph{No Author}, Journal, 2022.",
        r"\textbf{Jane Roe} and John Doe, Journal, 2023 \href{https://example.com/notitle}{[Link]}.",
        r"\textbf{Jane Roe}, \emph{No Year}, Proceedings.",
        ".",
    ]
    bib = BUGFIX / "missing-bib-fields" / "pubs.bib"
    assert [w.replace(str(bib.resolve()), "pubs.bib") for w in doc.warnings] == [
        "pubs.bib: warning: entry 'noauthor' has no author; it is left out of the citation",
        "pubs.bib: warning: entry 'notitle' has no title; it is left out of the citation",
        "pubs.bib: warning: entry 'noyear' has no year; it is left out of the citation",
        "pubs.bib: warning: entry 'nothing' has no author; it is left out of the citation",
        "pubs.bib: warning: entry 'nothing' has no title; it is left out of the citation",
        "pubs.bib: warning: entry 'nothing' has no year; it is left out of the citation",
    ]


def test_missing_bib_fields_crashed_v1():
    with pytest.raises(Exception):
        legacy_tex(BUGFIX / "missing-bib-fields" / "cv.yaml")


def test_unknown_contact_types_are_dropped_with_a_warning():
    doc = load("unknown-social")
    config = BUGFIX / "unknown-social" / "cv.yaml"
    assert doc.warnings == [
        f"{config}:11:15: warning: v1 does not print socials of type 'mastodon'; the item is dropped",
        f"{config}:19:9: warning: v1 does not print subheading groups of type 'profiles'; the item is dropped",
    ]
    tex = api.render_tex(doc).tex
    assert r"\address{\href{https://github.com/janeroe}{\colorfaGithub}}" in tex
    assert r"\address{jane@roe.dev \\ Curriculum Vitae, \customdate\today{}}" in tex


@pytest.mark.tex
def test_unknown_contact_types_compile_now_but_failed_in_v1():
    compile_result(api.render_tex(load("unknown-social")))
    with pytest.raises(EngineError, match="Paragraph ended before .address was complete"):
        compile_result(legacy_result(legacy_tex(BUGFIX / "unknown-social" / "cv.yaml")))


@pytest.mark.tex
def test_empty_list_sections_compile_now_but_failed_in_v1():
    tex = api.render_tex(load("empty-bullets-section")).tex
    assert tex.count(r"\begin{itemize}") == 1
    compile_result(api.render_tex(load("empty-bullets-section")))
    with pytest.raises(EngineError, match="missing .item"):
        compile_result(legacy_result(legacy_tex(BUGFIX / "empty-bullets-section" / "cv.yaml")))


BOLD = re.compile(r"\\textbf\{((?:[^{}]|\{[^{}]*\})*)\}")


def test_highlight_matches_name_forms():
    # test_parity checks the rest of the PDF against v1 with the extra bold added.
    tex = api.render_tex(load("highlight-matching")).tex
    assert BOLD.findall(tex) == ["John Doe", "John Doe", "{John} Doe", "JOHN DOE"]
    # v1 compared the formatted name with the heading name character for character.
    legacy = legacy_tex(BUGFIX / "highlight-matching" / "cv.yaml")
    assert BOLD.findall(legacy) == ["John Doe", "John Doe"]


def test_null_values_are_absent():
    # v1 printed "None"; test_parity checks the rest of the PDF against v1 with that removed.
    assert "None" in legacy_tex(BUGFIX / "null-values" / "cv.yaml")
    assert "None" not in api.render_tex(load("null-values")).tex


def citations(tex):
    return [line.strip()[len(r"\item ") :] for line in tex.splitlines() if r"\emph{" in line and r"\item " in line]


def test_null_list_items_are_dropped_with_a_warning():
    # v1 printed "\item None" or an empty \item; the first v2 version refused the file.
    config = BUGFIX / "null-list-items" / "cv.yaml"
    doc = load("null-list-items")
    assert [w.replace(str(config), "cv.yaml") for w in doc.warnings] == [
        f"cv.yaml:{line}: warning: empty list item (null); it is dropped"
        for line in ("11:12", "13:8", "22:16", "27:13", "32:8")
    ]
    tex = api.render_tex(doc).tex
    assert "None" not in tex
    assert "None" in legacy_tex(config)
    bullets, experience, education, skills = doc.sections
    assert [to_latex(e.text) for e in bullets.entries] == ["a", ""]  # "item:" with no value stays an empty item
    assert bullets.entries[0].bullets == [Latex("s1")]
    assert experience.entries[0].bullets == [Latex("r1")]
    assert education.entries[0].bullets == []
    assert len(skills.entries) == 1


@pytest.mark.tex
def test_null_list_items_compile():
    compile_result(api.render_tex(load("null-list-items")))


def test_bib_fields_are_latex_and_urls_are_unescaped():
    # v1 ran its markdown conversion over BibTeX fields, printed ", , " for empty
    # fields and kept \_ and {} in URLs.
    doc = load("bib-latex")
    assert citations(api.render_tex(doc).tex) == [
        r"{Barnes and Noble, Inc.}, John Doe Jr., \textbf{Jane Roe} and others, "
        r"\emph{{TOP*}: Faster Sorting with 50\% Fewer Comparisons, 'quoted' and two spaces}, "
        r"Proc. of A \& B, 2020 \href{https://x.org/a_b/50\%25\#sec~x?q=1&r=2}{[Link]}.",
        r"\textbf{Jane Roe}, \emph{{BEST*} and {NEXT*}: *Batch* Sorted Lists}, J. Algo. "
        r"\href{https://x.org/a/c}{[Link]}.",
        r"\textbf{Jane Roe}, \emph{Empty Journal, Booktitle Present}, Proc. Conf., 2021 "
        r"\href{https://x.org/\%7Euser\#sec}{[Link]}.",
        r"\textbf{Jane Roe}, \emph{A URL with a Tilde and an Underscore}, J, 2023 \href{https://x.org/~a_b/c}{[Link]}.",
    ]
    assert [w.split("warning: ")[1] for w in doc.warnings] == [
        "entry 'best' has no year; it is left out of the citation"
    ]
    legacy = citations(legacy_tex(BUGFIX / "bib-latex" / "cv.yaml"))
    assert r"\emph{{BEST\textit{} and {NEXT}}: \textit{Batch} Sorted Lists}, J. Algo.,  \href" in legacy[1]
    assert r"Empty Journal, Booktitle Present}, , 2021" in legacy[2]


@pytest.mark.tex
def test_bib_urls_are_the_link_targets():
    pdf = compile_result(api.render_tex(load("bib-latex")))
    assert link_targets(pdf) == [
        ["https://x.org/a_b/50%25#sec~x?q=1&r=2", "https://x.org/a/c", "https://x.org/%7Euser#sec", "https://x.org/~a_b/c"]
    ]
    legacy = link_targets(compile_result(legacy_result(legacy_tex(BUGFIX / "bib-latex" / "cv.yaml"))))
    assert legacy[0][1] == "https://x.org/a/{c}"


def test_names_keep_von_and_jr_parts():
    # v1 printed "Ludwig Beethoven" and so never bolded a heading name with "van".
    tex = api.render_tex(load("von-heading")).tex
    assert citations(tex) == [
        r"\textbf{Ludwig van Beethoven}, \textbf{Ludwig van Beethoven}, Ludwig Beethoven Jr. and John Doe Jr., "
        r"\emph{T}, J, 2020."
    ]
    legacy = citations(legacy_tex(BUGFIX / "von-heading" / "cv.yaml"))
    assert legacy == [r"Ludwig Beethoven, Ludwig Beethoven, Ludwig Beethoven and John Doe, \emph{T}, J, 2020."]


def test_bib_markdown_is_printed_as_written():
    tex = api.render_tex(load("markdown-everywhere")).tex
    assert r"\emph{A 'Quoted' Title with *Stars*}, Journal of **Strong** Results, 2024." in tex
    tex = api.render_tex(load("publications-multi")).tex
    assert r"\item Ludwig van Beethoven, \emph{A Single-Author Paper}" in tex
    assert "Workshop on **Bold** Ideas" in tex


@pytest.mark.tex
def test_contact_urls_are_not_padded():
    # v1 wrote \url{ x }, so the link target started and ended with a space.
    config = FIXTURES / "v1" / "socials-all" / "cv.yaml"
    legacy = link_targets(compile_result(legacy_result(legacy_tex(config))))[0]
    new = link_targets(compile_result(api.render_tex(load_v1(config))))[0]
    assert " https://janeroe.dev " in legacy
    assert "https://janeroe.dev" in new
    assert [u.strip() for u in legacy] == new


REMOVED = "is not available. cv-tools 2.0 no longer loads TikZ and scalerel. Remove it from the CV file or replace it with text."


@pytest.mark.tex
@pytest.mark.parametrize(
    "latex, command",
    [
        (r"dot \\tikz\\fill (0,0) circle (2pt); here", r"\tikz"),
        (r"\\scalerel*{X}{|} scaled", r"\scalerel"),
        (r"\\begin{tikzpicture}\\end{tikzpicture}", "the tikzpicture environment"),
        (r"\\usetikzlibrary{calc}", r"\usetikzlibrary"),
        (r"\\scaleto{X}{5pt}", r"\scaleto"),
    ],
)
def test_tikz_and_scalerel_are_no_longer_available(tmp_path, latex, command):
    # A documented breaking change: v1 loaded TikZ for the ORCID icon, so raw \tikz compiled.
    config = tmp_path / "cv.yaml"
    config.write_text(f'heading:\n  name: "Jane Roe"\nsections:\n  - type: bullets\n    title: T\n'
                      f'    content:\n      - item: "{latex}"\n', encoding="utf-8")
    compile_result(legacy_result(legacy_tex(config)))
    with pytest.raises(EngineError) as info:
        compile_result(api.render_tex(load_v1(config)))
    assert info.value.message.splitlines()[0] == f"pdflatex failed: {command} {REMOVED}"


@pytest.mark.tex
@pytest.mark.parametrize("where", ["name", "title", "contact", "pairs", "dated"])
def test_removed_commands_are_named_in_every_context(where):
    tikz = {"latex": r"\tikz"}
    data = {"version": 2, "name": "x", "sections": [{"title": "T", "layout": "list", "entries": ["a"]}]}
    if where == "name":
        data["name"] = tikz
    elif where == "title":
        data["sections"][0]["title"] = tikz  # printed with \MakeUppercase
    elif where == "contact":
        data["contact"] = [[tikz]]
    elif where == "pairs":
        data["sections"] = [{"title": "T", "layout": "pairs", "entries": [{"title": tikz, "text": "b"}]}]
    else:
        data["sections"] = [{"title": "T", "layout": "dated", "entries": [{"text": {"latex": r"a \tikz b"}}]}]
    with pytest.raises(EngineError) as info:
        compile_result(latex.render(model.from_data(data, FIXTURES)))
    assert info.value.message.splitlines()[0] == rf"pdflatex failed: \tikz {REMOVED}"


@pytest.mark.tex
def test_a_command_the_cv_defines_itself_still_works():
    # cv-tools defines none of the removed names, so a CV may define them.
    text = r"\newcommand{\scaleto}[2]{#1}\scaleto{A}{5pt} \def\tikz{T}\tikz"
    data = {"version": 2, "name": "x", "sections": [{"title": "T", "layout": "text", "entries": [{"latex": text}]}]}
    assert compile_result(latex.render(model.from_data(data, FIXTURES)))[:4] == b"%PDF"


@pytest.mark.tex
def test_other_undefined_commands_keep_the_plain_error():
    data = {"version": 2, "name": "x", "sections": [{"title": "T", "layout": "text", "entries": [{"latex": r"\tikzx"}]}]}
    with pytest.raises(EngineError) as info:
        compile_result(latex.render(model.from_data(data, FIXTURES)))
    assert info.value.message.splitlines()[:2] == ["pdflatex failed:", "! Undefined control sequence."]


@pytest.mark.tex
def test_links_in_the_name_and_titles_keep_their_target(tmp_path):
    # 1.x upper-cased link targets in the name and section titles; the link text still is.
    config = tmp_path / "cv.yaml"
    config.write_text('heading:\n  name: "[Jane](https://x.org/Jane)"\nsections:\n  - type: bullets\n'
                      '    title: "See [docs](https://x.org/Ab_c)"\n    content:\n      - item: x\n', encoding="utf-8")
    legacy = compile_result(legacy_result(legacy_tex(config)))
    assert link_targets(legacy) == [["HTTPS://X.ORG/JANE", "HTTPS://X.ORG/AB_C"]]
    pdf = compile_result(api.render_tex(load_v1(config)))
    assert link_targets(pdf) == [["https://x.org/Jane", "https://x.org/Ab_c"]]
    text = subprocess.run(["pdftotext", "-", "-"], input=pdf, capture_output=True, check=True).stdout.decode()
    assert "JANE" in text and "SEE DOCS" in text
