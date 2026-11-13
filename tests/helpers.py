"""Shared test helpers: deterministic compiles, the legacy generator, pixel and link comparison."""

from __future__ import annotations

import functools
import hashlib
import io
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageChops
from pypdf import PdfReader

from cv_tools import api, engine
from cv_tools.render.latex import RenderResult

TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent
FIXTURES = TESTS / "fixtures"
ARTIFACTS = TESTS / "_artifacts"
LEGACY = TESTS / "legacy"

# 14 November 2023, so \today is fixed in every PDF test.
SOURCE_DATE_EPOCH = 1700000000

HAVE_PDFLATEX = engine.find_pdflatex() is not None
HAVE_PDFTOPPM = shutil.which("pdftoppm") is not None
# CV_TOOLS_REQUIRE_TEX=1 turns a missing pdflatex or pdftoppm into a failure (CI sets it).
REQUIRE_TEX = os.environ.get("CV_TOOLS_REQUIRE_TEX", "") not in ("", "0")


def env() -> dict[str, str]:
    return engine.compile_env(SOURCE_DATE_EPOCH)


@functools.lru_cache(maxsize=None)
def _compile_cached(tex: str, files: tuple[tuple[str, bytes], ...]) -> bytes:
    # Always the local pdflatex: "auto" could fall back to Docker, and a test
    # would then compare PDFs of two TeX installations.
    return engine.compile_pdf(RenderResult(tex, dict(files)), engine="pdflatex", source_date_epoch=SOURCE_DATE_EPOCH)


def compile_result(result: RenderResult) -> bytes:
    return _compile_cached(result.tex, tuple(sorted(result.files.items())))


def render_v1_in_memory(path: Path) -> RenderResult:
    return api.render_tex(api.load(path))


def page_count(pdf: bytes) -> int:
    return len(PdfReader(io.BytesIO(pdf)).pages)


def tex_font(name: str) -> Path | None:
    if shutil.which("kpsewhich") is None:
        return None
    out = subprocess.run(["kpsewhich", f"{name}.otf"], capture_output=True, text=True).stdout.strip()
    return Path(out) if out else None


def font_cmap(path: Path) -> set[int]:
    """The code points an OpenType font maps to a glyph (cmap formats 4 and 12)."""
    data = path.read_bytes()
    tables = {data[12 + 16 * i : 16 + 16 * i]: struct.unpack_from(">I", data, 20 + 16 * i)[0]
              for i in range(struct.unpack_from(">H", data, 4)[0])}
    cmap = tables[b"cmap"]
    chars: set[int] = set()
    for i in range(struct.unpack_from(">H", data, cmap + 2)[0]):
        platform, encoding, offset = struct.unpack_from(">HHI", data, cmap + 4 + 8 * i)
        if (platform, encoding) not in ((3, 1), (3, 10), (0, 3), (0, 4)):
            continue
        t = cmap + offset
        fmt = struct.unpack_from(">H", data, t)[0]
        if fmt == 12:
            for g in range(struct.unpack_from(">I", data, t + 12)[0]):
                start, end, _ = struct.unpack_from(">III", data, t + 16 + 12 * g)
                chars.update(range(start, end + 1))
        elif fmt == 4:
            segs = struct.unpack_from(">H", data, t + 6)[0] // 2
            ends = struct.unpack_from(f">{segs}H", data, t + 14)
            starts = struct.unpack_from(f">{segs}H", data, t + 16 + 2 * segs)
            deltas = struct.unpack_from(f">{segs}h", data, t + 16 + 4 * segs)
            range_at = t + 16 + 6 * segs
            offsets = struct.unpack_from(f">{segs}H", data, range_at)
            for k in range(segs):
                for c in range(starts[k], ends[k] + 1):
                    if c == 0xFFFF:
                        continue
                    if offsets[k] == 0:
                        glyph = (c + deltas[k]) & 0xFFFF
                    else:
                        at = range_at + 2 * k + offsets[k] + 2 * (c - starts[k])
                        glyph = struct.unpack_from(">H", data, at)[0]
                        glyph = (glyph + deltas[k]) & 0xFFFF if glyph else 0
                    if glyph:
                        chars.add(c)
    chars.discard(0)
    return chars


def link_targets(pdf: bytes) -> list[list[str]]:
    pages = []
    for page in PdfReader(io.BytesIO(pdf)).pages:
        uris = []
        for annot in page.get("/Annots") or []:
            action = annot.get_object().get("/A")
            if action is not None and action.get("/S") == "/URI":
                uri = action["/URI"]
                uris.append(uri.decode("latin-1") if isinstance(uri, bytes) else str(uri))
        pages.append(uris)
    return pages


def legacy_tex(config: Path) -> str:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "output.tex"
        subprocess.run(
            [sys.executable, str(LEGACY / "generate_latex.py"), str(config),
             str(LEGACY / "template" / "template.tex.jinja"), str(out)],
            check=True, capture_output=True,
        )
        return out.read_text(encoding="utf-8")


def legacy_result(tex: str) -> RenderResult:
    return RenderResult(tex, {"resume.cls": (LEGACY / "template" / "resume.cls").read_bytes()})


def normalize_tex(tex: str) -> str:
    """Collapse whitespace and comments the way TeX reads them."""
    tex = re.sub(r"(?<!\\)%[^\n]*(\n[ \t]*)?", "", tex)
    tex = re.sub(r"[ \t]*\n[ \t]*(\n[ \t]*)+", "\n\n", tex)
    tex = re.sub(r"[ \t]*\n[ \t]*", " ", tex.replace("\n\n", "\x00"))
    tex = re.sub(r"[ \t]+", " ", tex)
    return re.sub(r"\x00+", "\n\n", tex).strip()


def rasterize(pdf: bytes) -> list[Image.Image]:
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.pdf"
        src.write_bytes(pdf)
        subprocess.run(["pdftoppm", "-r", "150", "-png", str(src), str(Path(tmp) / "page")],
                       check=True, capture_output=True)
        pages = sorted(Path(tmp).glob("page-*.png"), key=lambda p: int(p.stem.split("-")[-1]))
        return [Image.open(p).convert("RGB") for p in pages]


@dataclass
class PixelDiff:
    message: str
    artifacts: list[Path]

    def __bool__(self) -> bool:
        return bool(self.message)


def compare_pdfs(a: bytes, b: bytes, name: str) -> PixelDiff:
    """Empty when the PDFs match in pages, links and pixels; else the difference, with images in tests/_artifacts/<name>/."""
    assert page_count(a) >= 1, f"{name}: the expected PDF has no pages"
    assert page_count(b) >= 1, f"{name}: the actual PDF has no pages"
    out_dir = ARTIFACTS / name
    links_a, links_b = link_targets(a), link_targets(b)
    if links_a != links_b:
        return _fail(out_dir, a, b, f"link targets differ: {links_a} != {links_b}", [])
    if hashlib.sha256(a).digest() == hashlib.sha256(b).digest():
        return PixelDiff("", [])
    pages_a, pages_b = rasterize(a), rasterize(b)
    assert pages_a and pages_b, f"{name}: pdftoppm produced no pages"
    if len(pages_a) != len(pages_b):
        return _fail(out_dir, a, b, f"page count differs: {len(pages_a)} != {len(pages_b)}", [])
    problems, images = [], []
    for i, (pa, pb) in enumerate(zip(pages_a, pages_b), start=1):
        if pa.size != pb.size:
            problems.append(f"page {i}: size {pa.size} != {pb.size}")
            continue
        diff = ImageChops.difference(pa, pb)
        bbox = diff.getbbox()
        if bbox is None:
            continue
        count = sum(1 for px in diff.getdata() if px != (0, 0, 0))
        problems.append(f"page {i}: {count} pixels differ in bbox {bbox} (x0, y0, x1, y1 at 150 dpi)")
        images.append((i, pa, pb, diff))
    if not problems:
        return PixelDiff("", [])
    return _fail(out_dir, a, b, "; ".join(problems), images)


def _fail(out_dir: Path, a: bytes, b: bytes, message: str, images) -> PixelDiff:
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True)
    (out_dir / "expected.pdf").write_bytes(a)
    (out_dir / "actual.pdf").write_bytes(b)
    written = [out_dir / "expected.pdf", out_dir / "actual.pdf"]
    for i, pa, pb, diff in images:
        mask = diff.convert("L").point(lambda v: 255 if v else 0)
        overlay = Image.blend(pa, Image.new("RGB", pa.size, "white"), 0.7)
        overlay.paste(Image.new("RGB", pa.size, (255, 0, 0)), mask=mask)
        path = out_dir / f"diff-page{i}.png"
        overlay.save(path)
        written.append(path)
    return PixelDiff(f"{message}; see {out_dir}", written)


def fixture_dirs(kind: str) -> list[Path]:
    return sorted(p for p in (FIXTURES / kind).iterdir() if (p / "cv.yaml").exists())

