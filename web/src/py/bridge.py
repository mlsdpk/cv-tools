"""Glue between the py worker and cv_tools in Pyodide: JSON text in, JSON text out."""

import base64
import contextlib
import io
import json
import shutil
import traceback
import warnings
from pathlib import Path, PurePosixPath

WORK = Path("/cvwork")


def _diagnostic(error, severity="error"):
    file = error.file
    if file and file.startswith(str(WORK) + "/"):
        file = file[len(str(WORK)) + 1:]
    return {"file": file, "line": error.line, "col": error.col, "message": error.message, "severity": severity}


def _write_files(files):
    """Replace the work directory with the given .bib (and other) files."""
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)
    for name, text in files.items():
        rel = PurePosixPath(name)
        if rel.is_absolute() or ".." in rel.parts or not rel.parts:
            continue
        path = WORK.joinpath(*rel.parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


def _guard(fn):
    """Turn cv-tools errors into diagnostics and any other exception into an internal error."""

    def wrapper(*args):
        from cv_tools.loader import CVError
        from cv_tools.validate import ValidationError

        stderr = io.StringIO()
        try:
            with contextlib.redirect_stderr(stderr), warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                out = fn(*(json.loads(a) for a in args))
            out.setdefault("ok", True)
            notes = [str(w.message) for w in caught if not issubclass(w.category, DeprecationWarning)]
            if notes:
                out["warnings"] = out.get("warnings", []) + notes
        except ValidationError as e:
            out = {"ok": False, "diagnostics": [_diagnostic(x) for x in e.errors]}
        except CVError as e:
            out = {"ok": False, "diagnostics": [_diagnostic(e)]}
        except Exception as e:  # a bug in cv-tools or in this bridge
            out = {
                "ok": False,
                "internal": True,
                "diagnostics": [{"file": None, "line": None, "col": None, "severity": "error",
                                 "message": f"internal error: {type(e).__name__}: {e}"}],
                "traceback": traceback.format_exc(),
            }
        return json.dumps(out)

    wrapper.__name__ = fn.__name__
    return wrapper


def _format(text, name):
    """ "v1" or "v2" for the YAML text, raising CVError when the file is neither."""
    from cv_tools import v1
    from cv_tools.loader import load_text

    return v1.detect(load_text(text, name, WORK))


def _load(text, files, name):
    from cv_tools import api

    _write_files(files)
    return api.loads(text, name, base_dir=WORK)


@_guard
def validate(text, files, name="cv.yaml"):
    _write_files(files)
    fmt = _format(text, name)
    if fmt == "v1":
        return {"ok": False, "format": "v1", "diagnostics": []}
    doc = _load(text, files, name)
    return {"format": "v2", "diagnostics": [], "warnings": list(doc.warnings), "bibs": _bibs(doc)}


def _bibs(doc):
    out = []
    for section in doc.sections:
        bib = getattr(section, "bib", None)
        if bib is not None:
            path = Path(bib)
            out.append(str(path.relative_to(WORK)) if path.is_relative_to(WORK) else str(path))
    return out


@_guard
def render_tex(text, files, name="cv.yaml"):
    from cv_tools import api

    doc = _load(text, files, name)
    result = api.render_tex(doc)
    return {
        "tex": result.tex,
        "files": {k: base64.b64encode(v).decode("ascii") for k, v in result.files.items()},
        "warnings": list(doc.warnings),
    }


def _html_renderer():
    """``cv_tools.api.render_html``, or the renderer module's ``render``, or None before it exists."""
    from cv_tools import api

    fn = getattr(api, "render_html", None)
    if fn is not None:
        return fn
    try:
        from cv_tools.render import html as module
    except ImportError:
        return None
    return getattr(module, "render", None)


@_guard
def render_html(text, files, name="cv.yaml"):
    render = _html_renderer()
    if render is None:
        return {"ok": False, "unavailable": True, "diagnostics": []}
    doc = _load(text, files, name)
    result = render(doc)
    if isinstance(result, str):
        html, css = result, None
    elif isinstance(result, tuple):
        html, css = result[0], (result[1] if len(result) > 1 else None)
    elif isinstance(result, dict):
        html, css = result["html"], result.get("css")
    else:
        html, css = result.html, getattr(result, "css", None)
    return {"html": html, "css": css, "warnings": list(doc.warnings)}


@_guard
def migrate(text, name="cv.yaml"):
    from cv_tools import api

    return {"text": api.migrate_text(text, name)}


@_guard
def schema():
    from cv_tools.validate import schema as cv_schema

    return {"schema": cv_schema()}


@_guard
def version():
    import sys

    import cv_tools

    return {"cvTools": cv_tools.__version__, "python": sys.version.split()[0]}
