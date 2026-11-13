#!/usr/bin/env python3
"""Regenerate the README images in docs/img/ from tools/screenshots/ and examples/cv.yaml.

Needs pdflatex, pdftoppm and ImageMagick 7.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from cv_tools import api, engine  # noqa: E402

FIXTURES = ROOT / "tools" / "screenshots"
OUT = ROOT / "docs" / "img"
COVER_SOURCE = ROOT / "examples" / "cv.yaml"

EPOCH = 1773532800  # 2026-03-15 00:00 UTC, the date printed by {date}
SECTION_DPI = 240
COVER_DPI = 140
NEWPAGE_DPI = 100
PAD_X, PAD_Y = 120, 40
NEWPAGE_MARGIN = 60
FRAME = "#d0d7de"
PAGE_FRAME = "#404040"

# Without time chunks and metadata, a rerun writes the same bytes.
PNG_OPTIONS = [
    "-strip",
    "+set", "date:create", "+set", "date:modify", "+set", "date:timestamp",
    "-define", "png:exclude-chunks=date,time",
]

# The rule under a section heading spans the text block.
REFERENCE = """\
version: 2
name: ""
sections:
  - title: Reference
    layout: text
    entries: [x]
"""


def run(cmd: list[str]) -> str:
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def build(cv: Path, tmp: Path) -> Path:
    doc = api.load(cv)
    pdf = engine.compile_pdf(api.render_tex(doc), engine="pdflatex", source_date_epoch=EPOCH)
    path = tmp / f"{cv.stem}.pdf"
    path.write_bytes(pdf)
    return path


def rasterise(pdf: Path, dpi: int) -> list[Path]:
    prefix = pdf.with_suffix("")
    run(["pdftoppm", "-r", str(dpi), "-png", str(pdf), str(prefix)])
    return sorted(pdf.parent.glob(f"{prefix.name}-*.png"))


def bbox(png: Path) -> tuple[int, int, int, int]:
    w, rest = run(["magick", str(png), "-format", "%@", "info:"]).strip().split("x", 1)
    h, x, y = rest.split("+")
    x0, y0 = int(x), int(y)
    return x0, y0, x0 + int(w), y0 + int(h)


def section_image(cv: Path, out: Path, block: tuple[int, int], tmp: Path) -> None:
    page = rasterise(build(cv, tmp), SECTION_DPI)[0]
    x0, y0, x1, y1 = bbox(page)
    left, right = min(x0, block[0]) - PAD_X, max(x1, block[1]) + PAD_X
    top, bottom = y0 - PAD_Y, y1 + PAD_Y
    run(["magick", str(page), "-crop", f"{right - left}x{bottom - top}+{left}+{top}", "+repage",
         "-bordercolor", FRAME, "-border", "1", *PNG_OPTIONS, str(out)])


def pages_image(pages: list[Path], out: Path, height: int | None = None) -> None:
    crop = ["-crop", f"x{height}+0+0", "+repage"] if height else []
    run(["magick", *map(str, pages), *crop, "-bordercolor", PAGE_FRAME, "-border", "2", "+append",
         *PNG_OPTIONS, str(out)])


def cover(out: Path, tmp: Path) -> None:
    pages_image(rasterise(build(COVER_SOURCE, tmp), COVER_DPI), out)


def newpage(cv: Path, out: Path, tmp: Path) -> None:
    pages = rasterise(build(cv, tmp), NEWPAGE_DPI)
    if len(pages) != 2:
        raise SystemExit(f"{cv}: expected 2 pages, got {len(pages)}")
    height = max(bbox(p)[3] for p in pages) + NEWPAGE_MARGIN
    pages_image(pages, out, height)


def text_block(tmp: Path) -> tuple[int, int]:
    cv = tmp / "reference.yaml"
    cv.write_text(REFERENCE, encoding="utf-8")
    x0, _, x1, _ = bbox(rasterise(build(cv, tmp), SECTION_DPI)[0])
    return x0, x1


def main() -> int:
    names = ["cover"] + sorted(p.stem for p in FIXTURES.glob("*.yaml"))
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("images", nargs="*", choices=names, metavar="IMAGE",
                        help=f"images to regenerate (default: all): {', '.join(names)}")
    args = parser.parse_args()
    for tool in ("pdflatex", "pdftoppm", "magick"):
        if shutil.which(tool) is None:
            print(f"make_screenshots: {tool} not found", file=sys.stderr)
            return 1

    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="cv-tools-screenshots-") as name:
        tmp = Path(name)
        block = text_block(tmp)
        for image in args.images or names:
            out = OUT / f"{image}.png"
            work = tmp / image
            work.mkdir()
            if image == "cover":
                cover(out, work)
            elif image == "layout-newpage":
                newpage(FIXTURES / f"{image}.yaml", out, work)
            else:
                section_image(FIXTURES / f"{image}.yaml", out, block, work)
            print(f"wrote {out.relative_to(ROOT)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
