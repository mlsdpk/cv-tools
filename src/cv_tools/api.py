"""The public API: load a CV, then render it to LaTeX, HTML or PDF."""

from __future__ import annotations

import datetime
import sys
import warnings
from pathlib import Path
from typing import Optional, Union

from . import engine as _engine
from . import charset, model, v1
from .loader import CVError, Source, YamlPath, load_file, load_text
from .migrate import migrate_text as _migrate
from .model import Document
from .render import html, latex
from .render.html import HtmlResult
from .render.latex import RenderResult
from .validate import ValidationError, validate

__all__ = [
    "CVError", "Document", "HtmlResult", "RenderResult", "ValidationError",
    "build_pdf", "load", "load_with_v1_warnings", "loads", "migrate_text", "render_html", "render_tex",
    "split_path",
]


def load(path: Union[str, Path]) -> Document:
    """Load a v1 or v2 CV file into the v2 model (a v1 file also warns on stderr)."""
    return _document(load_file(path))[0]


def load_with_v1_warnings(path: Union[str, Path]) -> tuple[Document, list[str]]:
    """Like :func:`load`, and also return the v1 conversion warnings on their own."""
    return _document(load_file(path))


def loads(text: str, name: str = "<string>", base_dir: Optional[Path] = None) -> Document:
    """Like :func:`load`, for YAML text. Relative .bib paths resolve against ``base_dir``."""
    return _document(load_text(text, name, base_dir))[0]


def _document(src: Source) -> tuple[Document, list[str]]:
    path = Path(src.name) if src.name != "<string>" else None
    if v1.detect(src) == "v2":
        errors = validate(src)
        if errors:
            raise ValidationError(errors)
        doc = _checked(src, src.data, "v2", path, lambda p: p)
        doc.aliases, doc.anchors = src.aliases, src.anchors
        return doc, []

    message = v1.DEPRECATION.format(file=src.name)
    print(message, file=sys.stderr)
    warnings.warn(message, DeprecationWarning, stacklevel=3)
    conversion = v1.convert(src)
    doc = _checked(src, conversion.data, "v1", path, lambda p: _v1_path(conversion.origins, p))
    doc.warnings[:0] = conversion.warnings
    return doc, list(conversion.warnings)


def _checked(src: Source, data: dict, fmt: str, path: Optional[Path], source_path) -> Document:
    # pdflatex must be able to print every character of the text and .bib fields.
    errors = charset.check_data(src, data, source_path, show_path=fmt == "v2")
    if errors:
        raise ValidationError(errors)
    doc = _from_data(src, data, fmt, path, source_path)
    errors = [e for s in doc.sections if s.bib is not None for e in charset.check_publications(s.bib, s.publications)]
    if errors:
        raise ValidationError(errors)
    return doc


def _v1_path(origins: dict[YamlPath, YamlPath], path: YamlPath) -> YamlPath:
    while path and path not in origins:
        path = path[:-1]
    return origins.get(path, ())


def _from_data(src: Source, data: dict, fmt: str, path: Optional[Path], source_path) -> Document:
    try:
        return model.from_data(data, src.base_dir, fmt, path)
    except model.ModelError as e:
        raise src.error(e.message, source_path(e.path)) from None


def render_tex(doc: Document) -> RenderResult:
    """Render the LaTeX source and the support files it needs."""
    return latex.render(doc)


def render_html(doc: Document, today: Optional[datetime.date] = None) -> HtmlResult:
    """Render the HTML live preview. ``today`` is the date printed for ``date: auto``."""
    return html.render(doc, today=today)


def split_path(path: str) -> tuple[Union[str, int], ...]:
    """A ``data-path`` value as a YAML path."""
    return html.split_path(path)


def build_pdf(
    doc: Document,
    out: Union[str, Path, None] = None,
    engine: str = "auto",
    source_date_epoch: Optional[int] = None,
) -> bytes:
    """Compile the CV to PDF with ``engine`` (auto, pdflatex or docker), write ``out`` if given, and return the bytes."""
    workdir = Path(out).resolve().parent if out is not None else Path.cwd()
    pdf = _engine.compile_pdf(render_tex(doc), engine=engine, source_date_epoch=source_date_epoch, workdir=workdir)
    if out is not None:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_bytes(pdf)
    return pdf


def migrate_text(v1_text: str, name: str = "<string>") -> str:
    """Convert v1 YAML text to v2 YAML text. Warnings go to ``warnings.warn``."""
    migration = _migrate(v1_text, name)
    for warning in migration.warnings:
        warnings.warn(warning, UserWarning, stacklevel=2)
    return migration.text

