"""cv-tools: generate a LaTeX CV from a YAML file."""

__version__ = "2.0.0.dev0"

from .api import build_pdf, load, migrate_text, render_html, render_tex  # noqa: E402

__all__ = ["__version__", "build_pdf", "load", "migrate_text", "render_html", "render_tex"]
