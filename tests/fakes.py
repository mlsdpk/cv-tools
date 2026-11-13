"""Fake pdflatex, kpsewhich and docker executables (POSIX shell scripts) to put on PATH."""

from __future__ import annotations

import json
import shlex
import sys
from pathlib import Path
from typing import Iterable, Optional

import pytest

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="the fake executables are shell scripts")

DAEMON_DOWN = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"
FAKE_PDF = b"%PDF-1.5 fake"


def _script(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)
    return path


def fake_tex(bin_dir: Path, version_line: str = "pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026)",
             missing: Iterable[str] = (), kpsewhich: bool = True) -> Path:
    """A pdflatex that only prints its version, and a kpsewhich that finds every file except ``missing``."""
    pdflatex = _script(bin_dir / "pdflatex", f"echo {shlex.quote(version_line)}\necho 'kpathsea version 6.4.2'\n")
    if kpsewhich:
        skip = " ".join(missing)
        _script(bin_dir / "kpsewhich", (
            'for a in "$@"; do\n'
            '  case "$a" in -*) continue ;; esac\n'
            '  if [ -f "./$a" ]; then echo "./$a"; continue; fi\n'
            f'  case " {skip} " in *" $a "*) continue ;; esac\n'
            '  echo "/fake/texmf/$a"\n'
            "done\n"
        ))
    return pdflatex


_FAKE_DOCKER = r'''
import csv, json, os, sys, time

config = json.loads(sys.argv[1])
args = sys.argv[2:]


def fail(message, code=125):
    print(f"fake docker: {message}", file=sys.stderr)
    sys.exit(code)


if config["log"]:
    with open(config["log"], "a", encoding="utf-8") as f:
        f.write(json.dumps(args) + "\n")

if args[:1] == ["info"]:
    if args[1:] != ["--format", "{{json .}}"]:
        fail(f"unexpected info arguments {args[1:]}")
    if not config["running"]:
        print(config["daemon_down"], file=sys.stderr)
        sys.exit(1)
    if config["podman"]:
        info = {"host": {"security": {"rootless": config["rootless"]}}, "version": {"Version": "5.2.0"}}
    else:
        options = ["name=seccomp,profile=builtin", "name=cgroupns"]
        options += ["name=rootless"] if config["rootless"] else []
        options += ["name=userns"] if config["userns_remap"] else []
        info = {"ServerVersion": "27.3.1", "SecurityOptions": options}
    print(json.dumps(info))
    sys.exit(0)

if args[:2] == ["image", "inspect"]:
    sys.exit(0 if config["has_image"] else 1)

if args[:2] == ["rm", "-f"] and len(args) == 3:
    sys.exit(0)

if args[:1] != ["run"]:
    fail(f"unexpected command {args}")

# Parse "docker run" like the real CLI: every option before the image is known.
WITH_VALUE = {"--name", "--network", "--security-opt", "--mount", "-w", "--user", "-e", "--entrypoint"}
options, i = {}, 1
while i < len(args) and args[i].startswith("-"):
    if args[i] == "--rm":
        i += 1
        continue
    if args[i] not in WITH_VALUE or i + 1 >= len(args):
        fail(f"unknown flag: {args[i]}")
    options.setdefault(args[i], []).append(args[i + 1])
    i += 2
if i >= len(args):
    fail("no image given")

mounts = options.get("--mount", [])
if len(mounts) != 1:
    fail(f"expected one --mount, got {mounts}")
fields = next(csv.reader([mounts[0]]))  # Docker reads --mount as one CSV record
spec = {}
for field in fields:
    key, sep, value = field.partition("=")
    if not sep or key in spec:
        fail(f"invalid field {field!r} in --mount {mounts[0]!r}")
    spec[key] = value
if spec.get("type") != "bind" or spec.get("target") != "/work" or set(spec) != {"type", "source", "target"}:
    fail(f"unexpected --mount {mounts[0]!r}")
source = spec["source"]
if not os.path.isdir(source):
    fail(f"invalid mount config: bind source path does not exist: {source}")
if options.get("-w") != ["/work"]:
    fail(f"unexpected -w {options.get('-w')}")
missing = [name for name in ("cv.tex", "resume.cls", "orcid.pdf") if not os.path.isfile(os.path.join(source, name))]
if missing:
    fail(f"{', '.join(missing)} not in the mounted directory {source}", 1)
for name in options.get("-e", []):
    if name not in os.environ:
        fail(f"-e {name}: not set in the environment")

if config["hang"]:
    time.sleep(120)
if config["exit_code"]:
    print(config["stderr"], file=sys.stderr)
    sys.exit(config["exit_code"])
if config["write_pdf"]:
    with open(os.path.join(source, "cv.pdf"), "wb") as f:
        f.write(b"%PDF-1.5 fake")
sys.exit(0)
'''


def fake_docker(bin_dir: Path, running: bool = True, log: Optional[Path] = None, exit_code: int = 0,
                stderr: str = "", *, rootless: bool = False, podman: bool = False, userns_remap: bool = False,
                has_image: bool = True, hang: bool = False, write_pdf: bool = True) -> Path:
    """A docker whose ``run`` checks its arguments and writes cv.pdf; ``log`` gets one JSON line per call."""
    config = {
        "running": running, "log": str(log) if log else None, "exit_code": exit_code, "stderr": stderr,
        "rootless": rootless, "podman": podman, "userns_remap": userns_remap, "has_image": has_image,
        "hang": hang, "write_pdf": write_pdf, "daemon_down": DAEMON_DOWN,
    }
    script = bin_dir / "fake_docker.py"
    bin_dir.mkdir(parents=True, exist_ok=True)
    script.write_text(_FAKE_DOCKER)
    return _script(bin_dir / "docker", (
        f"exec {shlex.quote(sys.executable)} {shlex.quote(str(script))} {shlex.quote(json.dumps(config))} \"$@\"\n"
    ))


def docker_calls(log: Path, command: Optional[str] = None) -> list[list[str]]:
    calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    return [c for c in calls if command is None or c[:1] == [command]]


def run_args(log: Path) -> list[str]:
    runs = docker_calls(log, "run")
    assert len(runs) == 1, runs
    return runs[0]
