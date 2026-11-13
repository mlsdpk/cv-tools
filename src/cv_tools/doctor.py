"""Offline checks for a PDF build: pdflatex with the TeX packages, or Docker."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Optional

TIMEOUT = 30  # seconds, for each external command

# The file that shows a package is installed, when it is not "<package>.sty".
PROBES = {
    "cm": "cmr10.tfm",
    "cm-super": "type1ec.sty",
    "ec": "ecrm1000.tfm",
    "epstopdf-pkg": "epstopdf-base.sty",
    "fontname": "texfonts.map",
    "graphics-cfg": "graphics.cfg",
    "graphics-def": "pdftex.def",
    "kpathsea": "texmf.cnf",
    "l3kernel": "l3backend-pdftex.def",
    "latex": "latex.ltx",
    "latexconfig": "epstopdf-sys.cfg",
    "mptopdf": "supp-pdf.mkii",
    "tools": "array.sty",
}

TESTED_TEXLIVE = 2026


def probe_file(package: str) -> str:
    return PROBES.get(package, f"{package}.sty")


def required_packages() -> list[str]:
    text = (resources.files("cv_tools") / "templates" / "latex" / "packages.txt").read_text(encoding="utf-8")
    names = (line.split("#", 1)[0].strip() for line in text.splitlines())
    return [name for name in names if name]


def tlmgr_command() -> str:
    """The ``tlmgr install`` command for every package cv-tools needs."""
    return "tlmgr install " + " ".join(["latex-bin", *required_packages()])


@dataclass
class TexStatus:
    pdflatex: Optional[str]
    missing: list[str] = field(default_factory=list)
    checked: bool = True  # False without kpsewhich

    @property
    def ok(self) -> bool:
        return self.pdflatex is not None and not self.missing


@dataclass
class DockerStatus:
    path: Optional[str]
    running: bool
    detail: str  # the server version, or why Docker cannot be used
    rootless: bool = False
    podman: bool = False
    userns_remap: bool = False

    @property
    def installed(self) -> bool:
        return self.path is not None


def find_kpsewhich(pdflatex: str) -> Optional[str]:
    """The kpsewhich next to ``pdflatex`` (or its symlink target), else the one on PATH."""
    name = "kpsewhich.exe" if sys.platform == "win32" else "kpsewhich"
    path = Path(pdflatex)
    for directory in (path.resolve().parent, path.parent):
        if (directory / name).is_file():
            return str(directory / name)
    return shutil.which("kpsewhich")


def missing_packages(kpsewhich: str, packages: list[str]) -> list[str]:
    """The packages whose probe file kpsewhich cannot find."""
    # In an empty directory, since kpsewhich also searches the current one.
    probes = {probe_file(p): p for p in packages}
    with tempfile.TemporaryDirectory(prefix="cv-tools-") as empty:
        proc = subprocess.run(
            [kpsewhich, "-progname=pdflatex", *probes], capture_output=True, text=True, timeout=TIMEOUT, cwd=empty
        )
    found = {Path(line.strip()).name for line in proc.stdout.splitlines() if line.strip()}
    return [package for probe, package in probes.items() if probe not in found]


def check_tex(pdflatex: Optional[str]) -> TexStatus:
    if pdflatex is None:
        return TexStatus(None)
    kpsewhich = find_kpsewhich(pdflatex)
    if kpsewhich is None:
        return TexStatus(pdflatex, checked=False)
    try:
        return TexStatus(pdflatex, missing_packages(kpsewhich, required_packages()))
    except (OSError, subprocess.SubprocessError):
        return TexStatus(pdflatex, checked=False)


def tex_distribution(pdflatex: str) -> Optional[str]:
    """For example "TeX Live 2026"."""
    try:
        proc = subprocess.run([pdflatex, "--version"], capture_output=True, text=True, timeout=TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return None
    first = proc.stdout.splitlines()[0].strip() if proc.stdout.strip() else ""
    match = re.search(r"TeX Live (\d{4})", first)
    return f"TeX Live {match.group(1)}" if match else (first or None)


def texlive_year(distribution: Optional[str]) -> Optional[int]:
    match = re.fullmatch(r"TeX Live (\d{4})", distribution or "")
    return int(match.group(1)) if match else None


def check_docker() -> DockerStatus:
    """Whether ``docker`` answers, and whether it is rootless Docker or Podman."""
    exe = shutil.which("docker")
    if exe is None:
        return DockerStatus(None, False, "not found")
    try:
        proc = subprocess.run(
            [exe, "info", "--format", "{{json .}}"], capture_output=True, text=True, timeout=TIMEOUT
        )
    except subprocess.TimeoutExpired:
        return DockerStatus(exe, False, f"the daemon did not answer within {TIMEOUT} seconds")
    except OSError as e:
        return DockerStatus(exe, False, e.strerror or str(e))
    return parse_docker_info(exe, proc.returncode, proc.stdout, proc.stderr)


def _json_object(text: str) -> dict:
    for candidate in (text, *reversed(text.strip().splitlines())):
        try:
            data = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(data, dict):
            return data
    return {}


def parse_docker_info(exe: str, returncode: int, stdout: str, stderr: str) -> DockerStatus:
    data = _json_object(stdout)
    errors = [str(e).strip() for e in data.get("ServerErrors") or [] if str(e).strip()]
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    host, version_info = data.get("host"), data.get("version")
    if isinstance(host, dict) and isinstance(version_info, dict):  # Podman's own report
        version = str(version_info.get("Version") or "")
        security = host.get("security") if isinstance(host.get("security"), dict) else {}
        rootless = bool(security.get("rootless"))
        detail = f"Podman {version}" + (", rootless" if rootless else "")
        if returncode == 0 and version:
            return DockerStatus(exe, True, detail, rootless=rootless, podman=True)
    else:
        version = str(data.get("ServerVersion") or "")
        options = [str(o) for o in data.get("SecurityOptions") or []]
        names = {part[5:] for o in options for part in o.split(",") if part.startswith("name=")}
        rootless = "rootless" in names
        detail = f"server {version}" + (", rootless" if rootless else "")
        if returncode == 0 and version and not errors:
            return DockerStatus(exe, True, detail, rootless=rootless, userns_remap="userns" in names)
    reason = (errors or lines or ["the daemon is not running"])[-1]
    return DockerStatus(exe, False, reason)


def has_image(docker: str, image: str) -> bool:
    """Whether ``image`` is already present."""
    try:
        proc = subprocess.run([docker, "image", "inspect", image], capture_output=True, timeout=TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0
