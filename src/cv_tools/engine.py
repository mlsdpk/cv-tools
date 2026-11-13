"""Compile rendered LaTeX to PDF with a local pdflatex or the cv-tools Docker image."""

from __future__ import annotations

import os
import re
import secrets
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Callable, Optional, Union

from . import doctor
from .loader import CVError
from .render.latex import RenderResult

ENGINES = ("auto", "pdflatex", "docker")
JOBNAME = "cv"
TIMEOUT = 300  # seconds
DOCKER_TIMEOUT = 1800  # seconds; the first run also pulls the image
DOCKER_REPOSITORY = "ghcr.io/mlsdpk/cv-tools"
IMAGE_VARIABLE = "CV_TOOLS_IMAGE"
PDFLATEX_ARGS = ["-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", f"{JOBNAME}.tex"]
# The earliest date a zip entry holds, so the same input gives the same bytes.
ZIP_DATE = (1980, 1, 1, 0, 0, 0)


# TikZ and scalerel, which cv-tools 1.x loaded for the ORCID logo.
REMOVED_COMMANDS = frozenset({
    "tikz", "tikzset", "usetikzlibrary", "pgfmathsetmacro", "scalerel", "stretchrel", "scaleto", "scaleobj",
})
REMOVED_ENVIRONMENTS = frozenset({"tikzpicture"})
REMOVED_ADVICE = ("cv-tools 2.0 no longer loads TikZ and scalerel. "
                  "Remove it from the CV file or replace it with text.")

_COMPLETE_TEX: set[str] = set()


class EngineError(CVError):
    """No engine can run, or the compilation failed."""


def find_pdflatex() -> Optional[str]:
    return shutil.which("pdflatex")


def docker_image() -> str:
    """The image for ``--engine docker``: ``CV_TOOLS_IMAGE``, or the one tagged with this release."""
    from . import __version__

    override = os.environ.get(IMAGE_VARIABLE)
    if override:
        return override
    release = all(part.isdigit() for part in __version__.split("."))
    return f"{DOCKER_REPOSITORY}:{__version__ if release else 'latest'}"


def write_tex(result: RenderResult, tex_path: Path) -> list[Path]:
    """Write the .tex file (LF line ends) and its support files next to it."""
    tex_path = Path(tex_path)
    tex_path.parent.mkdir(parents=True, exist_ok=True)
    tex_path.write_bytes(result.tex.encode("utf-8"))
    written = [tex_path]
    for name, data in result.files.items():
        target = tex_path.parent / name
        target.write_bytes(data)
        written.append(target)
    return written


def write_zip(result: RenderResult, zip_path: Path, tex_name: Optional[str] = None) -> Path:
    """Write the .tex and its support files into a zip that Overleaf can open."""
    zip_path = Path(zip_path)
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    members = {tex_name or f"{zip_path.stem}.tex": result.tex.encode("utf-8"), **result.files}
    with zipfile.ZipFile(zip_path, "w") as archive:
        for name, data in members.items():
            info = zipfile.ZipInfo(name, date_time=ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)
    return zip_path


def compile_env(source_date_epoch: Optional[int] = None) -> dict[str, str]:
    """The environment for pdflatex, with ``SOURCE_DATE_EPOCH`` set if given."""
    env = dict(os.environ)
    if source_date_epoch is not None:
        env["SOURCE_DATE_EPOCH"] = str(int(source_date_epoch))
        env["FORCE_SOURCE_DATE"] = "1"
    return env


def docker_problem(docker: doctor.DockerStatus) -> str:
    if not docker.installed:
        return "Docker is not installed"
    return f"Docker is installed but not running ({docker.detail})"


def tlmgr_advice(missing: list[str]) -> str:
    return f"'tlmgr install {' '.join(missing)}' (TeX Live)"


MIKTEX_ADVICE = "with MiKTeX, which installs missing packages on the fly, build with --engine pdflatex"


def no_engine_message(tex: Optional[doctor.TexStatus], docker: doctor.DockerStatus) -> str:
    """Why ``--engine auto`` cannot build, and the ways to fix it."""
    if tex is None or tex.pdflatex is None:
        problem = "pdflatex was not found"
    else:
        problem = f"pdflatex is installed, but these TeX packages are missing: {' '.join(tex.missing)}"
    lines = [f"cannot build the PDF. {problem}, and {docker_problem(docker)}.", "Choose one of these:"]
    if tex is not None and tex.missing:
        lines.append(f"  - install the missing packages with {tlmgr_advice(tex.missing)}")
        lines.append(f"  - {MIKTEX_ADVICE}")
    else:
        lines.append("  - install TeX Live (https://tug.org/texlive/), then check it with 'cv-tools doctor'")
    start = "start Docker" if docker.installed else "install Docker and start it"
    lines += [
        f"  - {start}; cv-tools then compiles in the {DOCKER_REPOSITORY} image",
        "  - run 'cv-tools build --zip' and upload the zip to Overleaf,"
        " or use --tex-only and compile the .tex elsewhere",
    ]
    return "\n".join(lines)


def _choose(
    engine: str,
    tex: Optional[doctor.TexStatus] = None,
    docker: Optional[doctor.DockerStatus] = None,
) -> tuple[str, Optional[doctor.TexStatus], Optional[doctor.DockerStatus]]:
    if engine not in ENGINES:
        raise EngineError(f"unknown engine {engine!r} (expected one of: {', '.join(ENGINES)})")
    if engine != "auto":
        return engine, tex, docker
    if tex is None:
        pdflatex = find_pdflatex()
        if pdflatex is not None and pdflatex in _COMPLETE_TEX:
            return "pdflatex", None, docker
        tex = doctor.check_tex(pdflatex)
    if tex.ok:
        if tex.checked:
            _COMPLETE_TEX.add(tex.pdflatex)
        return "pdflatex", tex, docker
    if docker is None:
        docker = doctor.check_docker()
    if docker.running:
        return "docker", tex, docker
    raise EngineError(no_engine_message(tex, docker))


def resolve_engine(
    engine: str = "auto",
    tex: Optional[doctor.TexStatus] = None,
    docker: Optional[doctor.DockerStatus] = None,
) -> str:
    """Turn ``auto`` into ``pdflatex`` (when it has every package) or ``docker``."""
    return _choose(engine, tex, docker)[0]


def fallback_notes(tex: Optional[doctor.TexStatus]) -> list[str]:
    """Why ``--engine auto`` compiles with Docker, and how to use the local TeX instead."""
    if tex is None or tex.pdflatex is None:
        return ["cv-tools: pdflatex was not found"]
    return [
        f"cv-tools: the local TeX installation lacks these packages: {' '.join(tex.missing)}",
        f"cv-tools: to use it, install them with {tlmgr_advice(tex.missing)}; {MIKTEX_ADVICE}",
    ]


def _csv_field(value: str) -> str:
    # Docker and Podman read a --mount value as CSV.
    if any(c in value for c in ',"\r\n'):
        return '"' + value.replace('"', '""') + '"'
    return value


def mount_option(directory: Path) -> str:
    return f"type=bind,{_csv_field(f'source={Path(directory).resolve()}')},target=/work"


def container_name() -> str:
    return f"cv-tools-{os.getpid()}-{secrets.token_hex(4)}"


def docker_command(
    directory: Path,
    env: dict[str, str],
    status: Optional[doctor.DockerStatus] = None,
    name: Optional[str] = None,
) -> list[str]:
    """``docker run`` that compiles ``directory/cv.tex`` with the image's pdflatex."""
    # label=disable lets SELinux hosts use the bind mount. Rootless Docker and
    # Podman already run as the user, where --user would lose write access.
    exe = (status.path if status is not None else None) or shutil.which("docker") or "docker"
    cmd = [exe, "run", "--rm", "--name", name or container_name(), "--network", "none",
           "--security-opt", "label=disable", "--mount", mount_option(directory), "-w", "/work"]
    maps_user = status is not None and (status.rootless or status.podman)
    if hasattr(os, "getuid") and not maps_user:
        cmd += ["--user", f"{os.getuid()}:{os.getgid()}"]
    for variable in ("SOURCE_DATE_EPOCH", "FORCE_SOURCE_DATE"):
        if variable in env:
            cmd += ["-e", variable]
    return cmd + ["--entrypoint", "pdflatex", docker_image(), *PDFLATEX_ARGS]


def _remove_container(exe: str, name: str) -> None:
    try:
        subprocess.run([exe, "rm", "-f", name], capture_output=True, timeout=doctor.TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        pass


def compile_pdf(
    result: RenderResult,
    engine: str = "auto",
    source_date_epoch: Optional[int] = None,
    workdir: Union[str, Path, None] = None,
    notify: Optional[Callable[[str], None]] = None,
) -> bytes:
    """Compile in a temporary directory and return the PDF bytes.

    For Docker the directory is inside ``workdir``, because Docker Desktop,
    Colima and Podman machines share only some host directories.
    """
    notify = notify or (lambda line: None)
    chosen, tex, docker = _choose(engine)
    env = compile_env(source_date_epoch)
    if chosen == "pdflatex":
        exe = find_pdflatex()
        if exe is None:
            raise EngineError("pdflatex not found. Install TeX Live, or use --tex-only and compile the .tex elsewhere.")
        with tempfile.TemporaryDirectory(prefix="cv-tools-", ignore_cleanup_errors=True) as tmp:
            write_tex(result, Path(tmp) / f"{JOBNAME}.tex")
            return _run([exe, *PDFLATEX_ARGS], Path(tmp), env, TIMEOUT, "pdflatex")

    if docker is None:
        docker = doctor.check_docker()
    if not docker.running:
        hint = "Start it" if docker.installed else "Install Docker"
        raise EngineError(f"{docker_problem(docker)}. {hint}, or use --engine pdflatex.")
    if engine == "auto":
        for line in fallback_notes(tex):
            notify(line)
    image = docker_image()
    if not doctor.has_image(docker.path, image):
        notify(f"cv-tools: the first Docker build downloads {image} (a few hundred MB), "
               "which can take a few minutes")
    notify(f"compiling with Docker ({image})")
    parent = Path(workdir) if workdir is not None else Path.cwd()
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".cv-tools-", dir=parent, ignore_cleanup_errors=True) as tmp:
        if docker.userns_remap:
            # Container ids map to unprivileged host ids that are "others" here.
            os.chmod(tmp, 0o777)
        write_tex(result, Path(tmp) / f"{JOBNAME}.tex")
        name = container_name()
        cmd = docker_command(Path(tmp), env, docker, name)
        return _run(cmd, Path(tmp), env, DOCKER_TIMEOUT, "pdflatex (in Docker)",
                    cleanup=lambda: _remove_container(cmd[0], name))


def _run(cmd: list[str], tmp: Path, env: dict[str, str], timeout: int, label: str,
         cleanup: Callable[[], None] = lambda: None) -> bytes:
    try:
        proc = subprocess.run(cmd, cwd=tmp, env=env, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        cleanup()
        raise EngineError(f"{label} did not finish within {timeout} seconds") from None
    except KeyboardInterrupt:
        cleanup()
        raise
    except OSError as e:
        raise EngineError(f"cannot run {cmd[0]}: {e.strerror or e}") from None
    pdf = tmp / f"{JOBNAME}.pdf"
    if proc.returncode == 0 and pdf.is_file() and pdf.stat().st_size > 0:
        return pdf.read_bytes()
    log = tmp / f"{JOBNAME}.log"
    if log.exists():
        text = log.read_text(encoding="utf-8", errors="replace")
    else:  # Docker reports its own errors on stderr
        text = (proc.stdout + proc.stderr).decode(errors="replace")
    if proc.returncode == 0:
        message = f"{label} exited without writing {JOBNAME}.pdf"
        details = log_errors(text).strip()
        raise EngineError(message + (f":\n{details}" if details else ""))
    removed = removed_command(text)
    if removed is not None:
        raise EngineError(f"{label} failed: {removed} is not available. {REMOVED_ADVICE}\n" + log_errors(text))
    raise EngineError(f"{label} failed:\n" + log_errors(text))


def removed_command(log: str) -> Optional[str]:
    """The TikZ or scalerel command or environment that stopped pdflatex, if any."""
    lines = log.splitlines()
    for i, line in enumerate(lines):
        if not line.startswith("!"):
            continue
        if line.startswith("! Undefined control sequence.") and i + 1 < len(lines):
            found = re.search(r"\\([A-Za-z@]+)\s*$", lines[i + 1])
            if found and found.group(1) in REMOVED_COMMANDS:
                return "\\" + found.group(1)
        found = re.match(r"! LaTeX Error: Environment (\S+) undefined\.", line)
        if found and found.group(1) in REMOVED_ENVIRONMENTS:
            return f"the {found.group(1)} environment"
        return None
    return None


def log_errors(log: str, context: int = 3) -> str:
    """The error lines of a TeX log and a little context."""
    lines = log.splitlines()
    out: list[str] = []
    for i, line in enumerate(lines):
        if line.startswith("!"):
            out.extend(lines[i : i + 1 + context])
    return "\n".join(out) if out else "\n".join(lines[-20:])
