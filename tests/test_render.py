"""v2 rendering details that need a compiled PDF or the exact LaTeX of one layout."""

import re
import subprocess
import tempfile
from pathlib import Path

import pytest

from cv_tools import api
from cv_tools.loader import load_text
from cv_tools.migrate import migrate_text
from cv_tools.render import latex

from helpers import compile_result, link_targets


def words(pdf: bytes) -> list[tuple[str, float, float]]:
    """``(word, xMin, yMin)`` for every word on the first page, from ``pdftotext -bbox``."""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "in.pdf"
        path.write_bytes(pdf)
        html = subprocess.run(["pdftotext", "-bbox", "-f", "1", "-l", "1", str(path), "-"],
                              check=True, capture_output=True, text=True).stdout
    return [(w, float(x), float(y)) for x, y, w in
            re.findall(r'<word xMin="([\d.]+)" yMin="([\d.]+)"[^>]*>([^<]*)</word>', html)]


DATED = """\
version: 2
name: Jane Roe
sections:
  - title: Talks
    layout: dated
    entries:
      - date: Nov. 2023
        text: "Alpha first\\nBravo second"
      - date: "Early\\nDec. 2024"
        text: Charlie third
"""


def test_dated_line_breaks_do_not_end_the_row():
    tex = api.render_tex(api.loads(DATED)).tex
    assert r"Nov. & 2023 & Alpha first\newline{}Bravo second \\" in tex
    assert r"Early\newline{}Dec. & 2024 & Charlie third \\" in tex
    # Other layouts keep \\.
    listed = "version: 2\nname: J\nsections:\n  - {title: T, layout: list, entries: [\"Alpha\\nBravo\"]}\n"
    assert r"Alpha\\Bravo" in api.render_tex(api.loads(listed)).tex


@pytest.mark.tex
def test_dated_line_breaks_stay_in_their_column():
    found = {w: (x, y) for w, x, y in words(compile_result(api.render_tex(api.loads(DATED))))}
    # Both lines of the text start in the text column, one below the other.
    assert found["Bravo"][0] == pytest.approx(found["Alpha"][0], abs=0.5)
    assert found["Bravo"][1] > found["Alpha"][1]
    # The next row still has its year in the year column and its text in the text column.
    assert found["Charlie"][0] == pytest.approx(found["Alpha"][0], abs=0.5)
    assert found["2024"][0] == pytest.approx(found["2023"][0], abs=0.5)
    assert found["Charlie"][1] > found["Bravo"][1]


def test_v1_talks_with_line_breaks_keep_v1_latex():
    # v1 wrote \\ in a talk, and the v1 path keeps v1's LaTeX exactly, so the
    # migrator writes such a name as raw LaTeX instead of v2 text.
    v1_text = ('heading: {name: J}\nsections:\n  - type: talks\n    title: T\n    content:\n'
               '      - {name: "a\\nb", month: Nov., year: 2023}\n')
    entry = load_text(migrate_text(v1_text, "cv.yaml").text).data["sections"][0]["entries"][0]
    assert entry["text"] == {"latex": "a\\\\b"}
    assert latex.dated_text("a\nb") == r"a\newline{}b"


@pytest.mark.tex
def test_a_second_hash_does_not_cut_the_link(tmp_path):
    # \href ends its target at a second #, so 1.x and the first 2.0 builds linked
    # to https://x.org/#a. Later # signs are percent-encoded.
    (tmp_path / "p.bib").write_text("@misc{k, author = {A B}, title = {T}, year = {2020},\n"
                                    "  url = {https://b.org/#x\\#y}}\n", encoding="utf-8")
    text = ("version: 2\nname: J\ncontact:\n  - [{github: 'https://x.org/#a#b'}, {url: 'https://u.org/#c#d'}]\n"
            "sections:\n  - {title: T, layout: list, entries: ['[l](https://l.org/#e#f)']}\n"
            "  - {title: P, layout: publications, bib: p.bib}\n")
    pdf = compile_result(api.render_tex(api.loads(text, "cv.yaml", tmp_path)))
    assert link_targets(pdf) == [["https://x.org/#a%23b", "https://u.org/#c%23d", "https://l.org/#e%23f",
                                  "https://b.org/#x%23y"]]
