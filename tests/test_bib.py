"""BibTeX loading, name formatting and highlight matching."""

import pytest
from pybtex.database import Person

from cv_tools import bib
from cv_tools.bib import Author, Publication
from cv_tools.loader import CVError
from cv_tools.render.latex import citation


def write(tmp_path, text):
    path = tmp_path / "refs.bib"
    path.write_text(text, encoding="utf-8")
    return path


@pytest.mark.parametrize(
    "name, formatted",
    [
        ("John Doe", "John Doe"),
        ("Doe, John", "John Doe"),
        ("John Ronald Reuel Tolkien", "John Ronald Reuel Tolkien"),
        # v1 left out von and Jr. parts (a bug fix for v1 files too).
        ("Ludwig van Beethoven", "Ludwig van Beethoven"),
        ("van Beethoven, Ludwig", "Ludwig van Beethoven"),
        ("King, Jr., Martin Luther", "Martin Luther King Jr."),
        ("Doe, Jr., John", "John Doe Jr."),
        ("{\\'E}mile Zola", "{\\'E}mile Zola"),
        ("Antonín Dvořák", "Antonín Dvořák"),
        ("{Barnes and Noble}", "{Barnes and Noble}"),
    ],
)
def test_format_name(name, formatted):
    assert bib.format_name(Person(name)) == formatted


@pytest.mark.parametrize(
    "author, names, expected",
    [
        ("John Doe", ["John Doe"], True),
        ("Doe, John", ["John Doe"], True),
        ("John Doe", ["Doe, John"], True),
        ("JOHN DOE", ["john doe"], True),
        ("{John} Doe", ["John Doe"], True),
        ("John Doe", ["  John   Doe  "], True),
        # The full name, with its von and Jr. parts, must match.
        ("Ludwig van Beethoven", ["Ludwig van Beethoven"], True),
        ("Ludwig van Beethoven", ["van Beethoven, Ludwig"], True),
        ("van Beethoven, Ludwig", ["Ludwig van Beethoven"], True),
        ("Ludwig van Beethoven", ["Ludwig Beethoven"], False),
        ("Ludwig van Beethoven", ["Beethoven, Ludwig"], False),
        ("King, Jr., Martin Luther", ["Martin Luther King Jr."], True),
        ("King, Jr., Martin Luther", ["Martin Luther King, Jr."], True),
        ("King, Jr., Martin Luther", ["King, Jr., Martin Luther"], True),
        ("King, Jr., Martin Luther", ["King Jr., Martin Luther"], True),
        ("King, Jr., Martin Luther", ["Martin Luther King"], False),
        # LaTeX accents and Unicode compare equal, on either side.
        ("Jos{\\'e} Roe", ["José Roe"], True),
        ("José Roe", ["Jos\\'e Roe"], True),
        ("Roe, Jos\\'{e}", ["  roe ,  josé "], False),
        ("Roe, Jos\\'{e}", ["roe, josé"], True),
        ("{\\\"O}zt{\\\"u}rk, Ay{\\c{s}}e", ["Ayşe Öztürk"], True),
        ("Dvo{\\v{r}}{\\'a}k, Anton{\\'\\i}n", ["Antonín Dvořák"], True),
        ("J. Doe", ["John Doe"], False),
        ("John Doe", ["Jane Doe", "J. Doe"], False),
        ("John Doe", [""], False),
        ("John Doe", [], False),
    ],
)
def test_matches(author, names, expected):
    assert bib.matches(Person(author), names) is expected


def test_load_keeps_file_order_and_fields(tmp_path):
    path = write(
        tmp_path,
        """
        @string{j = "Journal of Strings"}
        @article{b, author = {Jane Roe and John Doe}, title = {{GPU} 'Title'}, journal = j, year = 2020,
                    url = {https://x.org/a_b}}
        @inproceedings{a, author = {Roe, Jane}, title = {Second}, booktitle = {Proc.}, year = {2019}}
        """,
    )
    pubs, warnings = bib.load(path, ["Jane Roe"])
    assert warnings == []
    assert [p.key for p in pubs] == ["b", "a"]
    assert pubs[0] == Publication(
        key="b",
        authors=(Author("Jane Roe", True), Author("John Doe", False)),
        title="{GPU} 'Title'",
        venue="Journal of Strings",
        year="2020",
        url="https://x.org/a_b",
        venue_field="journal",
    )
    assert (pubs[1].venue, pubs[1].venue_field) == ("Proc.", "booktitle")


def test_missing_fields_warn_and_are_left_out(tmp_path):
    path = write(
        tmp_path,
        """
        @misc{noauthor, title = {T}, year = {2020}}
        @misc{notitle, author = {A B}, journal = {J}, year = {2020}}
        @misc{noyear, author = {A B}, title = {T}}
        """,
    )
    pubs, warnings = bib.load(path, [])
    assert [w.split("warning: ")[1] for w in warnings] == [
        "entry 'noauthor' has no author; it is left out of the citation",
        "entry 'notitle' has no title; it is left out of the citation",
        "entry 'noyear' has no year; it is left out of the citation",
    ]
    assert [citation(p) for p in pubs] == [r"\emph{T}, 2020.", "A B, J, 2020.", r"A B, \emph{T}."]


def test_empty_fields_count_as_missing(tmp_path):
    path = write(
        tmp_path,
        """
        @article{a, author = {A B}, title = {T}, journal = {}, booktitle = {Proc}, year = {}}
        @article{b, author = {A B}, title = { }, journal = { J }, year = {2020}, url = {}}
        """,
    )
    pubs, warnings = bib.load(path, [])
    assert [w.split("warning: ")[1] for w in warnings] == [
        "entry 'a' has no year; it is left out of the citation",
        "entry 'b' has no title; it is left out of the citation",
    ]
    assert [citation(p) for p in pubs] == [r"A B, \emph{T}, Proc.", "A B, J, 2020."]


@pytest.mark.parametrize(
    "field, url",
    [
        ("https://x.org/a\\_b", "https://x.org/a_b"),
        ("https://x.org/50\\%25\\#sec", "https://x.org/50%25#sec"),
        ("https://x.org/\\~u?a=1\\&b=\\$2", "https://x.org/~u?a=1&b=$2"),
        ("https://x.org/{a}/{{b}}", "https://x.org/a/b"),
        ("https://x.org/\\~{}u", "https://x.org/~u"),
        (" https://x.org/%7Euser ", "https://x.org/%7Euser"),
        ("https://x.org/a\\{b", "https://x.org/a\\{b"),
    ],
)
def test_bib_url(field, url):
    assert bib.bib_url(field) == url


def test_missing_venue_does_not_print_empty_commas():
    pub = Publication("k", (Author("A B", False),), "T", None, "2020", None)
    assert citation(pub) == r"A B, \emph{T}, 2020."


def test_citation_prints_bibtex_fields_as_latex():
    # No CV markup, quote or spacing conversion: BibTeX fields are LaTeX.
    pub = Publication(
        "k",
        (Author("A B", True), Author("C D", False), Author("E F", False)),
        "{TOP*}: 'T' *x*  two",
        "V \\& W",
        "2020",
        "https://x.org/50%#a^b",
    )
    assert citation(pub) == (
        r"\textbf{A B}, C D and E F, \emph{{TOP*}: 'T' *x*  two}, V \& W, 2020 \href{https://x.org/50\%\#a\%5Eb}{[Link]}."
    )


def test_bib_errors(tmp_path):
    with pytest.raises(CVError, match="BibTeX file not found"):
        bib.load(tmp_path / "missing.bib", [])
    with pytest.raises(CVError, match="cannot read BibTeX file"):
        bib.load(write(tmp_path, "@article{a, title = {T}}\n@article{a, title = {U}}\n"), [])
