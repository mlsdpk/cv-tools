"""Command line interface: ``cv-tools build | watch | init | migrate | validate | doctor | schema``."""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import re
import sys
from importlib import resources
from pathlib import Path
from typing import Optional, Sequence

import yaml

from . import __version__, api, doctor, engine, watch
from .loader import CVError, resolves_to_string
from .migrate import migrate_text
from .model import Document
from .validate import ValidationError

EXIT_OK, EXIT_ERROR, EXIT_USAGE = 0, 1, 2
STARTER_FILES = ("cv.yaml", "publications.bib")
OUTPUT_SUFFIXES = (".pdf", ".tex", ".zip")
INTERVAL_RANGE = (0.05, 60.0)  # seconds


def _print_error(error: CVError) -> None:
    errors = error.errors if isinstance(error, ValidationError) else [error]
    for e in errors:
        print(e.format("error"), file=sys.stderr)


def _print_os_error(error: OSError) -> None:
    reason = error.strerror or str(error)
    location = error.filename if error.filename is not None else None
    print(f"{location}: error: {reason}" if location is not None else f"error: {reason}", file=sys.stderr)


def _note(line: str) -> None:
    print(line, file=sys.stderr, flush=True)


def _print_warnings(warnings: list[str]) -> None:
    for w in warnings:
        print(w, file=sys.stderr)


def _load_for_build(config: Path) -> Document:
    """Load a CV and print its warnings, with the v1 conversion warnings as one summary line."""
    doc, v1_warnings = api.load_with_v1_warnings(config)
    if v1_warnings:
        n = len(v1_warnings)
        what = "1 v1 field or item was" if n == 1 else f"{n} v1 fields or items were"
        print(f"cv-tools: {what} ignored, as v1 ignored them; run 'cv-tools validate {config}' for details",
              file=sys.stderr)
    _print_warnings(doc.warnings[len(v1_warnings):])
    return doc


def output_path(output: Optional[str], config: Path, kind: str) -> Path:
    """Where ``build`` writes a ``kind`` (.pdf, .tex or .zip) file."""
    # A name without one of these suffixes gets ``kind`` appended, so J.Doe-CV keeps its dot.
    default = Path(config).stem + kind
    if output is None:
        return Path(default)
    out = Path(output)
    if output.endswith(("/", os.sep)) or out.is_dir():
        return out / default
    suffix = out.suffix.lower()
    if suffix == ".zip" and kind != ".zip":
        raise CVError("a .zip output needs --zip, which writes the LaTeX sources for Overleaf", output)
    if suffix not in OUTPUT_SUFFIXES:
        return out.with_name(out.name + kind)
    return out


def _with_suffix(path: Path, suffix: str) -> Path:
    return path if path.suffix.lower() == suffix else path.with_suffix(suffix)


def _write_outputs(args: argparse.Namespace, doc: Document) -> None:
    config = Path(args.config)
    result = api.render_tex(doc)
    kind = ".zip" if args.zip else ".tex" if args.tex_only else ".pdf"
    out = output_path(args.output, config, kind)

    if args.zip:
        path = engine.write_zip(result, _with_suffix(out, ".zip"))
        print(f"wrote {path}", file=sys.stderr)
        return
    # A .tex output also keeps the LaTeX sources next to the PDF, as run.sh did.
    if args.tex_only or out.suffix.lower() == ".tex":
        for path in engine.write_tex(result, _with_suffix(out, ".tex")):
            print(f"wrote {path}", file=sys.stderr)
    if args.tex_only:
        return
    pdf_path = _with_suffix(out, ".pdf")
    pdf = engine.compile_pdf(result, engine=args.engine, workdir=pdf_path.parent, notify=_note)
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    pdf_path.write_bytes(pdf)
    print(f"wrote {pdf_path}", file=sys.stderr)


def cmd_build(args: argparse.Namespace) -> int:
    doc = _load_for_build(Path(args.config))
    _write_outputs(args, doc)
    return EXIT_OK


def cmd_watch(args: argparse.Namespace) -> int:
    config = Path(args.config)
    last = {config.resolve()}

    def build_once() -> set[Path]:
        nonlocal last
        try:
            doc = _load_for_build(config)
        except CVError as e:
            _print_error(e)
            return last | {config.resolve()}
        except OSError as e:
            _print_os_error(e)
            return last | {config.resolve()}
        last = watch.watched_files(doc, config)
        try:
            _write_outputs(args, doc)
        except CVError as e:
            _print_error(e)
        except OSError as e:  # for example an output directory that is not writable
            _print_os_error(e)
        return last

    try:
        watch.run(build_once, args.interval)
    except KeyboardInterrupt:
        print("stopped", file=sys.stderr)
    return EXIT_OK


def cmd_init(args: argparse.Namespace) -> int:
    target = Path(args.directory)
    for name in STARTER_FILES:
        if (target / name).exists():
            raise CVError("already exists; 'cv-tools init' never overwrites files", str(target / name))
    target.mkdir(parents=True, exist_ok=True)
    for name in STARTER_FILES:
        data = (resources.files("cv_tools") / "starter" / name).read_bytes()
        with open(target / name, "xb") as f:  # "x" also refuses a file created meanwhile
            f.write(data)
        print(f"wrote {target / name}", file=sys.stderr)
    print(f"next: edit {target / 'cv.yaml'}, then run 'cv-tools build {target / 'cv.yaml'}'", file=sys.stderr)
    return EXIT_OK


def _same_file(a: Path, b: Path) -> bool:
    try:
        return a.samefile(b)
    except OSError:
        return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


_PLAIN_PATH = re.compile(r"[A-Za-z0-9_.][A-Za-z0-9_./+-]*")  # safe as a plain YAML scalar


def rebase_bib_paths(text: str, source_dir: Path, target_dir: Path) -> str:
    """Rewrite each relative ``bib:`` of a v2 file so it names the same file from ``target_dir``."""
    source_dir, target_dir = Path(os.path.abspath(source_dir)), Path(os.path.abspath(target_dir))
    if source_dir == target_dir:
        return text
    root = yaml.compose(text)
    sections = next((v for k, v in getattr(root, "value", []) if k.value == "sections"), None)
    edits = []
    for section in getattr(sections, "value", None) or []:
        if not isinstance(section, yaml.MappingNode):
            continue
        for key, value in section.value:
            if key.value != "bib" or not isinstance(value, yaml.ScalarNode) or os.path.isabs(value.value):
                continue
            target = os.path.normpath(source_dir / value.value)
            try:
                shared = os.path.commonpath([target, target_dir])
            except ValueError:  # another drive on Windows
                shared = None
            if shared is None or shared == Path(target).anchor:
                new = Path(target).as_posix()  # nothing in common but the root: an absolute path is clearer
            else:
                new = Path(os.path.relpath(target, target_dir)).as_posix()
            if new != value.value:
                # A plain scalar only when it reads back as the same string ("2024" would be a number).
                plain = _PLAIN_PATH.fullmatch(new) and resolves_to_string(new)
                quoted = new if plain else json.dumps(new, ensure_ascii=False)
                edits.append((value.start_mark.index, value.end_mark.index, quoted))
    for start, end, replacement in sorted(edits, reverse=True):
        text = text[:start] + replacement + text[end:]
    return text


def migrate_output(output: Optional[str], source: Path) -> Optional[Path]:
    if output is None:
        return None
    out = Path(output)
    if output.endswith(("/", os.sep)) or out.is_dir():
        return out / source.name
    return out


def cmd_migrate(args: argparse.Namespace) -> int:
    source = Path(args.file)
    output = migrate_output(args.output, source)
    # Messages name the output as written, unless it is a directory.
    shown = args.output if output is not None and Path(args.output) == output else str(output)
    if output is not None:
        if _same_file(source, output):
            raise CVError("the output is the input file; write the v2 file elsewhere and check it "
                          "before replacing the v1 file", shown)
        if output.exists() and not args.force:
            raise CVError("already exists; use --force to overwrite it", shown)
    try:
        text = source.read_text(encoding="utf-8")
    except OSError as e:
        raise CVError(f"cannot read file: {e.strerror}", str(source)) from None
    migration = migrate_text(text, str(source))
    _print_warnings(migration.warnings)
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        # bib: paths are relative to the real directories, after symlinks, as the loader reads them.
        out_text = rebase_bib_paths(migration.text, source.resolve().parent, output.parent.resolve())
        output.write_bytes(out_text.encode("utf-8"))
        print(f"wrote {shown}", file=sys.stderr)
    else:
        sys.stdout.write(migration.text)
    return EXIT_OK


def cmd_validate(args: argparse.Namespace) -> int:
    status = EXIT_OK
    for name in args.files:
        try:
            doc = api.load(name)
        except CVError as e:
            _print_error(e)
            status = EXIT_ERROR
            continue
        _print_warnings(doc.warnings)
        print(f"{name}: valid ({doc.source_format})")
    return status


def cmd_doctor(args: argparse.Namespace) -> int:
    if args.tlmgr:
        print(doctor.tlmgr_command())
        return EXIT_OK
    pdflatex = engine.find_pdflatex()
    tex = doctor.check_tex(pdflatex)
    docker = doctor.check_docker()
    rows = [("cv-tools", __version__), ("python", f"{platform.python_version()} ({sys.executable})")]
    year = None
    if pdflatex is None:
        rows.append(("pdflatex", "not found"))
    else:
        distribution = doctor.tex_distribution(pdflatex)
        year = doctor.texlive_year(distribution)
        rows.append(("pdflatex", f"{pdflatex} ({distribution or 'unknown version'})"))
        total = len(doctor.required_packages())
        if not tex.checked:
            rows.append(("packages", "not checked (kpsewhich not found)"))
        elif tex.missing:
            rows.append(("packages", f"{len(tex.missing)} of {total} missing: {' '.join(tex.missing)}"))
        else:
            rows.append(("packages", f"all {total} found"))
    rows.append(("docker", f"{docker.path} ({docker.detail})" if docker.path else "not found"))
    for key, value in rows:
        print(f"{key:<10}{value}")
    print()
    try:
        chosen = engine.resolve_engine("auto", tex, docker)
    except engine.EngineError as e:
        print(f"not ready: {e.message}")
        return EXIT_ERROR
    if chosen == "pdflatex":
        print("ready: 'cv-tools build' uses the local pdflatex")
        if year is not None and year != doctor.TESTED_TEXLIVE:
            print(f"note: cv-tools is tested with TeX Live {doctor.TESTED_TEXLIVE}; "
                  f"with TeX Live {year} the PDF can differ slightly")
    else:
        print(f"ready: 'cv-tools build' uses Docker ({engine.docker_image()})")
    return EXIT_OK


def cmd_schema(args: argparse.Namespace) -> int:
    path = resources.files("cv_tools") / "schema" / "cv-v2.schema.json"
    if args.print:
        sys.stdout.write(path.read_text(encoding="utf-8"))
    else:
        print(path)
    return EXIT_OK


def interval(text: str) -> float:
    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a number: {text!r}") from None
    low, high = INTERVAL_RANGE
    if not (math.isfinite(value) and low <= value <= high):
        raise argparse.ArgumentTypeError(f"must be between {low:g} and {high:g} seconds, not {text}")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cv-tools", description="Generate a LaTeX CV from a YAML file.")
    parser.add_argument("--version", action="version", version=f"cv-tools {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="COMMAND", required=True)

    outputs = argparse.ArgumentParser(add_help=False)
    outputs.add_argument("config", help="the CV YAML file (v1 or v2)")
    outputs.add_argument(
        "-o", "--output",
        help="output file or directory (default: <config name>.pdf in the current directory). "
        "A name without .pdf, .tex or .zip gets the right suffix appended. "
        "A .tex path also writes the LaTeX sources next to the PDF.",
    )
    only = outputs.add_mutually_exclusive_group()
    only.add_argument("--tex-only", action="store_true", help="write the .tex, resume.cls and orcid.pdf; skip pdflatex")
    only.add_argument("--zip", action="store_true", help="write a .zip of the LaTeX sources for Overleaf; skip pdflatex")
    outputs.add_argument(
        "--engine", choices=engine.ENGINES, default="auto",
        help="auto (default) uses the local pdflatex if it has every package, else Docker",
    )

    build = sub.add_parser("build", parents=[outputs], help="build the PDF (or the .tex or .zip) from a CV file")
    build.set_defaults(func=cmd_build)

    watch_ = sub.add_parser("watch", parents=[outputs], help="build, then rebuild whenever the CV or its .bib files change")
    watch_.add_argument("--interval", type=interval, default=0.5, metavar="SECONDS",
                        help="time between checks for changes, from 0.05 to 60 (default: 0.5)")
    watch_.set_defaults(func=cmd_watch)

    init = sub.add_parser("init", help="write a starter cv.yaml and publications.bib")
    init.add_argument("directory", nargs="?", default=".", help="where to write them (default: the current directory)")
    init.set_defaults(func=cmd_init)

    migrate = sub.add_parser("migrate", help="convert a v1 CV file to the v2 format")
    migrate.add_argument("file", help="the v1 YAML file")
    migrate.add_argument(
        "-o", "--output",
        help="write the v2 file here instead of standard output (a directory gets the input file's name); "
        "relative bib: paths are adjusted to its directory",
    )
    migrate.add_argument("--force", action="store_true", help="overwrite the -o file if it exists")
    migrate.set_defaults(func=cmd_migrate)

    validate = sub.add_parser("validate", help="check CV files and report errors with line numbers")
    validate.add_argument("files", nargs="+", metavar="FILE")
    validate.set_defaults(func=cmd_validate)

    doctor_ = sub.add_parser("doctor", help="check that pdflatex, the TeX packages or Docker are ready")
    doctor_.add_argument("--tlmgr", action="store_true",
                         help="only print the 'tlmgr install' command for every TeX package cv-tools needs")
    doctor_.set_defaults(func=cmd_doctor)

    schema = sub.add_parser("schema", help="print the path of the v2 JSON Schema")
    schema.add_argument("--print", action="store_true", help="print the schema itself")
    schema.set_defaults(func=cmd_schema)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except CVError as e:
        _print_error(e)
        return EXIT_ERROR
    except OSError as e:  # an output that cannot be written, a full disk
        _print_os_error(e)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
