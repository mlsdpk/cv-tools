"""Engine resolution, the Docker engine (with a fake docker) and the Overleaf zip."""

import csv
import io
import os
import subprocess
import sys
import zipfile

import pytest

import cv_tools
from cv_tools import api, doctor, engine

from fakes import FAKE_PDF, docker_calls, fake_docker, fake_tex, posix_only, run_args
from helpers import ROOT

TEX_OK = doctor.TexStatus("/usr/bin/pdflatex")
NO_TEX = doctor.TexStatus(None)
MISSING = doctor.TexStatus("/usr/bin/pdflatex", missing=["fontawesome", "datetime"])
UNCHECKED = doctor.TexStatus("/usr/bin/pdflatex", checked=False)
DOCKER_UP = doctor.DockerStatus("/usr/bin/docker", True, "server 27.3.1")
DOCKER_DOWN = doctor.DockerStatus("/usr/bin/docker", False, "the daemon is not running")
NO_DOCKER = doctor.DockerStatus(None, False, "not found")


@pytest.fixture(autouse=True)
def fresh_cache(monkeypatch):
    monkeypatch.setattr(engine, "_COMPLETE_TEX", set())


def result():
    return api.render_tex(api.load(ROOT / "examples" / "cv.yaml"))


@pytest.mark.parametrize("tex, docker, expected", [
    (TEX_OK, DOCKER_UP, "pdflatex"),
    (TEX_OK, NO_DOCKER, "pdflatex"),
    (UNCHECKED, NO_DOCKER, "pdflatex"),
    (NO_TEX, DOCKER_UP, "docker"),
    (MISSING, DOCKER_UP, "docker"),
])
def test_auto_resolution(tex, docker, expected):
    assert engine.resolve_engine("auto", tex, docker) == expected


def test_auto_checks_lazily(monkeypatch):
    calls = []
    monkeypatch.setattr(engine, "find_pdflatex", lambda: "/usr/bin/pdflatex")
    monkeypatch.setattr(doctor, "check_tex", lambda path: calls.append(("tex", path)) or TEX_OK)
    monkeypatch.setattr(doctor, "check_docker", lambda: calls.append("docker") or DOCKER_UP)
    assert engine.resolve_engine() == "pdflatex"
    assert calls == [("tex", "/usr/bin/pdflatex")]  # Docker is only asked when pdflatex cannot build


def test_a_complete_tex_is_checked_once(monkeypatch):
    calls = []
    monkeypatch.setattr(engine, "find_pdflatex", lambda: "/usr/bin/pdflatex")
    monkeypatch.setattr(doctor, "check_tex", lambda path: calls.append(path) or TEX_OK)
    assert [engine.resolve_engine() for _ in range(3)] == ["pdflatex"] * 3
    assert calls == ["/usr/bin/pdflatex"]
    # An incomplete or unchecked installation is checked again every time.
    monkeypatch.setattr(engine, "_COMPLETE_TEX", set())
    monkeypatch.setattr(doctor, "check_tex", lambda path: calls.append(path) or UNCHECKED)
    engine.resolve_engine()
    engine.resolve_engine()
    assert len(calls) == 3


def test_explicit_engines_are_not_checked(monkeypatch):
    monkeypatch.setattr(doctor, "check_tex", lambda path: pytest.fail("checked"))
    assert engine.resolve_engine("pdflatex") == "pdflatex"
    assert engine.resolve_engine("docker") == "docker"
    with pytest.raises(engine.EngineError, match=r"unknown engine 'lualatex' \(expected one of: auto, pdflatex, docker\)"):
        engine.resolve_engine("lualatex")


def test_no_engine_explains_the_three_options():
    with pytest.raises(engine.EngineError) as e:
        engine.resolve_engine("auto", NO_TEX, DOCKER_DOWN)
    assert str(e.value).splitlines() == [
        "cannot build the PDF. pdflatex was not found, and Docker is installed but not running "
        "(the daemon is not running).",
        "Choose one of these:",
        "  - install TeX Live (https://tug.org/texlive/), then check it with 'cv-tools doctor'",
        "  - start Docker; cv-tools then compiles in the ghcr.io/mlsdpk/cv-tools image",
        "  - run 'cv-tools build --zip' and upload the zip to Overleaf, or use --tex-only and compile the .tex elsewhere",
    ]


def test_no_engine_names_missing_packages():
    with pytest.raises(engine.EngineError) as e:
        engine.resolve_engine("auto", MISSING, NO_DOCKER)
    lines = str(e.value).splitlines()
    assert lines[0] == (
        "cannot build the PDF. pdflatex is installed, but these TeX packages are missing: fontawesome datetime, "
        "and Docker is not installed."
    )
    assert lines[2:5] == [
        "  - install the missing packages with 'tlmgr install fontawesome datetime' (TeX Live)",
        "  - with MiKTeX, which installs missing packages on the fly, build with --engine pdflatex",
        "  - install Docker and start it; cv-tools then compiles in the ghcr.io/mlsdpk/cv-tools image",
    ]
    assert len(lines) == 6


def test_docker_image(monkeypatch):
    monkeypatch.delenv(engine.IMAGE_VARIABLE, raising=False)
    monkeypatch.setattr(cv_tools, "__version__", "2.0.0.dev0")
    assert engine.docker_image() == "ghcr.io/mlsdpk/cv-tools:latest"
    monkeypatch.setattr(cv_tools, "__version__", "2.1.0")
    assert engine.docker_image() == "ghcr.io/mlsdpk/cv-tools:2.1.0"
    monkeypatch.setenv(engine.IMAGE_VARIABLE, "cv-tools:local")
    assert engine.docker_image() == "cv-tools:local"


def test_docker_command(tmp_path, monkeypatch):
    monkeypatch.setenv(engine.IMAGE_VARIABLE, "img:1")
    cmd = engine.docker_command(tmp_path, {"SOURCE_DATE_EPOCH": "1", "FORCE_SOURCE_DATE": "1"}, DOCKER_UP, "cv-x")
    assert cmd[:13] == [
        "/usr/bin/docker", "run", "--rm", "--name", "cv-x", "--network", "none", "--security-opt", "label=disable",
        "--mount", f"type=bind,source={tmp_path.resolve()},target=/work", "-w", "/work",
    ]
    assert cmd[-7:] == [
        "--entrypoint", "pdflatex", "img:1", "-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "cv.tex",
    ]
    i = cmd.index("-e")
    assert cmd[i : i + 4] == ["-e", "SOURCE_DATE_EPOCH", "-e", "FORCE_SOURCE_DATE"]
    if hasattr(os, "getuid"):
        assert cmd[cmd.index("--user") + 1] == f"{os.getuid()}:{os.getgid()}"
    assert "SOURCE_DATE_EPOCH" not in engine.docker_command(tmp_path, {})
    assert engine.docker_command(tmp_path, {})[4].startswith(f"cv-tools-{os.getpid()}-")


@pytest.mark.parametrize("status", [
    doctor.DockerStatus("/usr/bin/docker", True, "server 27.3.1, rootless", rootless=True),
    doctor.DockerStatus("/usr/bin/docker", True, "Podman 5.2.0, rootless", rootless=True, podman=True),
    doctor.DockerStatus("/usr/bin/docker", True, "Podman 5.2.0", podman=True),
])
def test_docker_command_leaves_user_mapping_to_rootless_engines(tmp_path, status):
    assert "--user" not in engine.docker_command(tmp_path, {}, status)


no_quotes_on_windows = pytest.mark.skipif(sys.platform == "win32", reason="Windows file names cannot contain quotes")


@pytest.mark.parametrize("name", [
    "plain", "with space", "with,comma",
    pytest.param('with"quote', marks=no_quotes_on_windows), pytest.param('both,"and', marks=no_quotes_on_windows),
])
def test_mount_option_is_one_csv_record(tmp_path, name):
    directory = tmp_path / name
    fields = next(csv.reader([engine.mount_option(directory)]))
    assert fields == ["type=bind", f"source={directory.resolve()}", "target=/work"]


@posix_only
@pytest.mark.parametrize("name", ["out", "my cv, final", 'say "hi"'])
def test_docker_compile_runs_in_workdir(tmp_path, monkeypatch, name):
    bin_dir, work, log = tmp_path / "bin", tmp_path / name, tmp_path / "docker.log"
    fake_docker(bin_dir, log=log)
    monkeypatch.setenv("PATH", str(bin_dir))
    monkeypatch.setenv(engine.IMAGE_VARIABLE, "cv-tools:test")
    pdf = engine.compile_pdf(result(), engine="docker", source_date_epoch=1700000000, workdir=work)
    assert pdf == FAKE_PDF
    args = run_args(log)
    source = next(csv.reader([args[args.index("--mount") + 1]]))[1]
    assert source.startswith(f"source={work.resolve()}{os.sep}.cv-tools-")
    assert "cv-tools:test" in args
    assert list(work.iterdir()) == []  # the temporary directory is gone


@posix_only
def test_docker_compile_without_workdir_uses_the_current_directory(tmp_path, monkeypatch):
    """Not the system temporary directory, which Docker Desktop, Colima and Podman may not share."""
    log = tmp_path / "docker.log"
    fake_docker(tmp_path / "bin", log=log)
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))
    (tmp_path / "here").mkdir()
    monkeypatch.chdir(tmp_path / "here")
    assert engine.compile_pdf(result(), engine="docker") == FAKE_PDF
    args = run_args(log)
    assert f"source={(tmp_path / 'here').resolve()}{os.sep}.cv-tools-" in args[args.index("--mount") + 1]


@posix_only
@pytest.mark.parametrize("flags, user", [({}, True), ({"rootless": True}, False), ({"podman": True}, False)])
def test_docker_compile_detects_the_user_mapping(tmp_path, monkeypatch, flags, user):
    log = tmp_path / "docker.log"
    fake_docker(tmp_path / "bin", log=log, **flags)
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))
    engine.compile_pdf(result(), engine="docker", workdir=tmp_path / "out")
    assert ("--user" in run_args(log)) == (user and hasattr(os, "getuid"))


@posix_only
def test_docker_compile_with_userns_remap_opens_the_directory(tmp_path, monkeypatch):
    modes = []
    real_write_tex = engine.write_tex
    monkeypatch.setattr(engine, "write_tex", lambda res, path: modes.append(path.parent.stat().st_mode & 0o777)
                        or real_write_tex(res, path))
    fake_docker(tmp_path / "bin", userns_remap=True)
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))
    engine.compile_pdf(result(), engine="docker", workdir=tmp_path / "out")
    assert modes == [0o777]


@posix_only
def test_docker_compile_reports_docker_errors(tmp_path, monkeypatch):
    message = "Unable to find image 'cv-tools:none' locally"
    fake_docker(tmp_path, exit_code=125, stderr=message)
    monkeypatch.setenv("PATH", str(tmp_path))
    with pytest.raises(engine.EngineError) as e:
        engine.compile_pdf(result(), engine="docker", workdir=tmp_path / "out")
    assert str(e.value) == f"pdflatex (in Docker) failed:\n{message}"


@posix_only
def test_docker_timeout_removes_the_container(tmp_path, monkeypatch):
    log = tmp_path / "docker.log"
    fake_docker(tmp_path / "bin", log=log, hang=True)
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))
    monkeypatch.setattr(engine, "DOCKER_TIMEOUT", 1)
    with pytest.raises(engine.EngineError, match=r"^pdflatex \(in Docker\) did not finish within 1 seconds$"):
        engine.compile_pdf(result(), engine="docker", workdir=tmp_path / "out")
    name = run_args(log)[run_args(log).index("--name") + 1]
    assert docker_calls(log, "rm") == [["rm", "-f", name]]
    assert list((tmp_path / "out").iterdir()) == []


@posix_only
def test_interrupt_removes_the_container(tmp_path, monkeypatch):
    log = tmp_path / "docker.log"
    fake_docker(tmp_path / "bin", log=log)
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))
    real_run = subprocess.run

    def interrupted(cmd, *args, **kwargs):
        if cmd[1] == "run":
            real_run(cmd, *args, **kwargs)  # the container started; then the user presses Ctrl-C
            raise KeyboardInterrupt
        return real_run(cmd, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", interrupted)
    with pytest.raises(KeyboardInterrupt):
        engine.compile_pdf(result(), engine="docker", workdir=tmp_path / "out")
    name = run_args(log)[run_args(log).index("--name") + 1]
    assert docker_calls(log, "rm") == [["rm", "-f", name]]


@posix_only
@pytest.mark.parametrize("running, message", [
    (True, None),
    (False, r"^Docker is installed but not running \(Cannot connect.*\)\. Start it, or use --engine pdflatex\.$"),
])
def test_docker_engine_needs_a_running_daemon(tmp_path, monkeypatch, running, message):
    fake_docker(tmp_path, running=running)
    monkeypatch.setenv("PATH", str(tmp_path))
    if message is None:
        assert engine.compile_pdf(result(), engine="docker", workdir=tmp_path / "out") == FAKE_PDF
        return
    with pytest.raises(engine.EngineError, match=message):
        engine.compile_pdf(result(), engine="docker")


def test_docker_engine_without_docker(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path))
    with pytest.raises(engine.EngineError, match=r"^Docker is not installed\. Install Docker, or use --engine pdflatex\.$"):
        engine.compile_pdf(result(), engine="docker")


@posix_only
def test_auto_falls_back_to_docker(tmp_path, monkeypatch):
    fake_docker(tmp_path, has_image=False)
    monkeypatch.setenv("PATH", str(tmp_path))  # no pdflatex here
    monkeypatch.setenv(engine.IMAGE_VARIABLE, "img:1")
    notes = []
    assert engine.compile_pdf(result(), workdir=tmp_path / "out", notify=notes.append) == FAKE_PDF
    assert notes == [
        "cv-tools: pdflatex was not found",
        "cv-tools: the first Docker build downloads img:1 (a few hundred MB), which can take a few minutes",
        "compiling with Docker (img:1)",
    ]


@posix_only
def test_auto_explains_missing_packages(tmp_path, monkeypatch):
    fake_tex(tmp_path, missing=["fontawesome.sty"])
    fake_docker(tmp_path)
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setenv(engine.IMAGE_VARIABLE, "img:1")
    notes = []
    engine.compile_pdf(result(), workdir=tmp_path / "out", notify=notes.append)
    assert notes == [
        "cv-tools: the local TeX installation lacks these packages: fontawesome",
        "cv-tools: to use it, install them with 'tlmgr install fontawesome' (TeX Live); "
        "with MiKTeX, which installs missing packages on the fly, build with --engine pdflatex",
        "compiling with Docker (img:1)",
    ]


@posix_only
def test_pdflatex_without_a_pdf_is_an_error(tmp_path, monkeypatch):
    fake_tex(tmp_path)
    monkeypatch.setenv("PATH", str(tmp_path))
    with pytest.raises(engine.EngineError) as e:
        engine.compile_pdf(result(), engine="pdflatex")
    assert str(e.value).splitlines()[0] == "pdflatex exited without writing cv.pdf:"


@posix_only
def test_build_pdf_creates_the_output_directory(tmp_path, monkeypatch):
    log = tmp_path / "docker.log"
    fake_docker(tmp_path / "bin", log=log)
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))
    monkeypatch.chdir(tmp_path)
    doc = api.load(ROOT / "examples" / "cv.yaml")
    assert api.build_pdf(doc, out=tmp_path / "a" / "b" / "cv.pdf", engine="docker") == FAKE_PDF
    assert (tmp_path / "a" / "b" / "cv.pdf").read_bytes() == FAKE_PDF
    assert api.build_pdf(doc, engine="docker") == FAKE_PDF
    mounts = [call[call.index("--mount") + 1] for call in docker_calls(log, "run")]
    assert f"source={(tmp_path / 'a' / 'b').resolve()}{os.sep}.cv-tools-" in mounts[0]
    assert f"source={tmp_path.resolve()}{os.sep}.cv-tools-" in mounts[1]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["a", "bin", "docker.log"]


def test_write_zip(tmp_path):
    res = result()
    path = engine.write_zip(res, tmp_path / "out" / "john.zip")
    with zipfile.ZipFile(path) as z:
        assert z.namelist() == ["john.tex", "resume.cls", "orcid.pdf"]
        assert z.read("john.tex").decode() == res.tex
        assert z.read("resume.cls") == res.files["resume.cls"]
        assert z.read("orcid.pdf") == res.files["orcid.pdf"]
        assert {i.date_time for i in z.infolist()} == {engine.ZIP_DATE}
    again = engine.write_zip(res, tmp_path / "again.zip", tex_name="john.tex")
    assert again.read_bytes() == path.read_bytes()


def test_write_tex_uses_lf_line_ends(tmp_path):
    engine.write_tex(result(), tmp_path / "cv.tex")
    assert b"\r\n" not in (tmp_path / "cv.tex").read_bytes()


@pytest.mark.tex
def test_zip_compiles_as_is(tmp_path):
    with zipfile.ZipFile(io.BytesIO(engine.write_zip(result(), tmp_path / "cv.zip").read_bytes())) as z:
        z.extractall(tmp_path / "project")
    proc = subprocess.run(
        [engine.find_pdflatex(), "-interaction=nonstopmode", "-halt-on-error", "cv.tex"],
        cwd=tmp_path / "project", capture_output=True,
    )
    assert proc.returncode == 0, proc.stdout[-2000:]
    assert (tmp_path / "project" / "cv.pdf").exists()
