"""The HTML preview in Chromium against the PDF, line by line at 96 dpi.

``python tests/test_fidelity.py FILE.yaml...`` writes overlays to tests/_artifacts/fidelity/.
"""

from __future__ import annotations

import base64
import datetime
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest
from PIL import Image, ImageChops

sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpers import ARTIFACTS, FIXTURES, ROOT, SOURCE_DATE_EPOCH, compile_result, tex_font  # noqa: E402

from cv_tools import api  # noqa: E402
from cv_tools.render.html import FONT_FILES, font_face_css  # noqa: E402

REQUIRE_BROWSER = os.environ.get("CV_TOOLS_REQUIRE_BROWSER", "") not in ("", "0")
TODAY = datetime.datetime.fromtimestamp(SOURCE_DATE_EPOCH, datetime.timezone.utc).date()
TOLERANCE = 2  # px at 96 dpi, for the vertical position of a line
H_TOLERANCE = 4  # px, for where the ink of a line starts, and ends at the right margin
MARGIN = round(0.55 * 96)  # the right margin, px
FLUSH = 14  # px; a line whose ink ends this close to the margin ends at the margin (dates end a space before it)
RAGGED = 0.1  # how much shorter than the PDF's a flush line may be, as a share of its width
# Bounds of the median width ratio (preview / PDF) of the lines that end
# before the margin. Narrower interword spaces put it a little below 1.
WIDTH_RATIO = (0.965, 1.015)
CASES = [ROOT / "examples" / "cv.yaml", FIXTURES / "v2" / "long-lines.yaml", FIXTURES / "v2" / "entries.yaml"]


def _skip_or_fail(reason: str):
    if REQUIRE_BROWSER:
        pytest.fail(f"{reason}, and CV_TOOLS_REQUIRE_BROWSER=1 requires it", pytrace=False)
    pytest.skip(f"{reason} (pip install -e '.[test,fidelity]' and python -m playwright install chromium; "
                "CV_TOOLS_REQUIRE_BROWSER=1 makes this a failure)")


@pytest.fixture(scope="module")
def browser():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        _skip_or_fail("Playwright for Python is not installed")
    fonts = {name: tex_font(name) for *_, name in FONT_FILES}
    if not all(fonts.values()):
        _skip_or_fail(f"the fonts {[n for n, p in fonts.items() if not p]} are not in TeX Live")
    if shutil.which("pdftoppm") is None:
        _skip_or_fail("pdftoppm is not installed")
    with sync_playwright() as p:
        try:
            chromium = p.chromium.launch()
        except Exception as e:  # browsers not downloaded
            _skip_or_fail(f"Chromium for Playwright is not available ({str(e).splitlines()[0]})")
        yield chromium, fonts
        chromium.close()


def font_css(fonts: dict[str, Path]) -> str:
    css = font_face_css("fonts/", "otf")
    for name, path in fonts.items():
        data = base64.b64encode(path.read_bytes()).decode()
        css = css.replace(f'"fonts/{name}.otf"', f'"data:font/otf;base64,{data}"')
    return css


def html_pages(chromium, fonts: dict[str, Path], doc: api.Document, extra_css: str = "") -> list[Image.Image]:
    result = api.render_html(doc, today=TODAY)
    page = chromium.new_page(viewport={"width": 1000, "height": 1200}, device_scale_factor=1)
    try:
        html = result.standalone().replace("<style>\n", "<style>\n" + font_css(fonts), 1)
        html = html.replace("</style>", extra_css + "</style>", 1)
        page.set_content(html)
        page.evaluate("document.fonts.ready")
        images = []
        with tempfile.TemporaryDirectory() as tmp:
            for i, box in enumerate(page.query_selector_all(".cv-page")):
                path = Path(tmp) / f"{i}.png"
                box.screenshot(path=str(path))
                images.append(Image.open(path).convert("L"))
        return images
    finally:
        page.close()


def pdf_pages(doc: api.Document) -> list[Image.Image]:
    pdf = compile_result(api.render_tex(doc))
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "cv.pdf").write_bytes(pdf)
        subprocess.run(["pdftoppm", "-r", "96", "-png", "cv.pdf", "page"], cwd=tmp, check=True, capture_output=True)
        pages = sorted(Path(tmp).glob("page-*.png"), key=lambda p: int(p.stem.split("-")[-1]))
        return [Image.open(p).convert("L") for p in pages]


def bands(image: Image.Image) -> list[tuple[int, int]]:
    """(first, last) row ranges of ink; a gap of 2 rows or less joins them (i dots, accents)."""
    width, height = image.size
    dark = image.point(lambda v: 255 if v < 140 else 0)
    rows = [dark.crop((0, y, width, y + 1)).getbbox() is not None for y in range(height)]
    out: list[tuple[int, int]] = []
    y = 0
    while y < height:
        if rows[y]:
            start = y
            while y < height and rows[y]:
                y += 1
            if out and start - out[-1][1] <= 3:
                out[-1] = (out[-1][0], y - 1)
            else:
                out.append((start, y - 1))
        y += 1
    return out


def extent(image: Image.Image, band: tuple[int, int]) -> tuple[int, int]:
    box = image.crop((0, band[0], image.width, band[1] + 1)).point(lambda v: 255 if v < 140 else 0).getbbox()
    return (box[0], box[2] - 1) if box else (0, 0)


def compare(pdf: list[Image.Image], html: list[Image.Image]) -> tuple[list[str], list[list[tuple[int, int, int]]]]:
    """The problems, and per band the offsets (preview minus PDF) of its bottom row and first and last ink column."""
    problems: list[str] = []
    offsets: list[list[tuple[int, int, int]]] = []
    ratios: list[float] = []
    if len(pdf) != len(html):
        problems.append(f"{len(html)} preview pages, {len(pdf)} PDF pages")
    for n, (a, b) in enumerate(zip(pdf, html), 1):
        pa, pb = bands(a), bands(b)
        if len(pa) != len(pb):
            problems.append(f"page {n}: {len(pb)} lines in the preview, {len(pa)} in the PDF")
        page_offsets = []
        for i, (ba, bb) in enumerate(zip(pa, pb)):
            (la, ra), (lb, rb) = extent(a, ba), extent(b, bb)
            d = (bb[1] - ba[1], lb - la, rb - ra)
            page_offsets.append(d)
            where = f"page {n}, line {i + 1} (PDF rows {ba[0]}-{ba[1]})"
            if abs(d[0]) > TOLERANCE:
                problems.append(f"{where}: {d[0]:+d} px")
            # A ragged line may end earlier than in the PDF (narrower spaces), but
            # a line that reaches the margin in either output must end near it in both.
            flush = max(ra, rb) >= a.width - MARGIN - FLUSH
            if abs(d[1]) > H_TOLERANCE or (flush and abs(d[2]) > H_TOLERANCE + RAGGED * (ra - la)):
                problems.append(f"{where}: ink from x={lb} to {rb}, in the PDF from {la} to {ra}")
            elif not flush and ra - la >= 60:
                ratios.append((rb - lb) / (ra - la))
        offsets.append(page_offsets)
    # Left-aligned lines start at the margin whatever the font size, so a
    # uniform size change shows only in their widths.
    if len(ratios) >= 3 and not WIDTH_RATIO[0] <= statistics.median(ratios) <= WIDTH_RATIO[1]:
        problems.append(f"lines are {statistics.median(ratios):.3f} times as wide as in the PDF (median)")
    return problems, offsets


def overlay(pdf: Image.Image, html: Image.Image) -> Image.Image:
    w, h = max(pdf.width, html.width), max(pdf.height, html.height)
    a, b = Image.new("L", (w, h), 255), Image.new("L", (w, h), 255)
    a.paste(pdf, (0, 0))
    b.paste(html, (0, 0))
    return Image.merge("RGB", (b, ImageChops.multiply(a, b), a))


@pytest.mark.tex
@pytest.mark.parametrize("path", CASES, ids=lambda p: p.stem)
def test_lines_match_the_pdf(browser, path):
    chromium, fonts = browser
    doc = api.load(path)
    problems, _ = compare(pdf_pages(doc), html_pages(chromium, fonts, doc))
    assert not problems, f"{path.name}: " + "; ".join(problems)


@pytest.mark.tex
@pytest.mark.parametrize("size", ["10.5pt", "11.4pt"])
def test_a_uniform_font_size_change_is_caught(browser, size):
    chromium, fonts = browser
    doc = api.load(FIXTURES / "v2" / "entries.yaml")
    css = f".cv-document .cv-page {{ font-size: {size}; }}\n"
    problems, _ = compare(pdf_pages(doc), html_pages(chromium, fonts, doc, css))
    assert problems


def main(paths: list[str]) -> None:
    from playwright.sync_api import sync_playwright

    fonts = {name: tex_font(name) for *_, name in FONT_FILES}
    out = ARTIFACTS / "fidelity"
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        chromium = p.chromium.launch()
        for arg in paths:
            path = Path(arg)
            doc = api.load(path)
            pdf, html = pdf_pages(doc), html_pages(chromium, fonts, doc)
            for n, (a, b) in enumerate(zip(pdf, html), 1):
                a.save(out / f"{path.stem}-pdf-{n}.png")
                b.save(out / f"{path.stem}-html-{n}.png")
                overlay(a, b).save(out / f"{path.stem}-overlay-{n}.png")
            problems, offsets = compare(pdf, html)
            worst = [max((abs(d[k]) for page in offsets for d in page), default=0) for k in range(3)]
            lines = sum(len(page) for page in offsets)
            print(f"{path.name}: {lines} lines; max |dy| {worst[0]} px, |dx| start {worst[1]} px, end {worst[2]} px")
            for problem in problems:
                print("  ", problem)
        chromium.close()


if __name__ == "__main__":
    main(sys.argv[1:])
