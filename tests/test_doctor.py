"""The offline checks behind ``cv-tools doctor`` and ``--engine auto``."""

import json
import os
import subprocess
from pathlib import Path

import pytest

from cv_tools import doctor, engine
from cv_tools.render.latex import TEMPLATE_DIR

from fakes import DAEMON_DOWN, fake_docker, fake_tex, posix_only


def test_required_packages_are_packages_txt():
    lines = (TEMPLATE_DIR / "packages.txt").read_text(encoding="utf-8").splitlines()
    assert doctor.required_packages() == [line for line in lines if line and not line.startswith("#")]


def test_probes_only_name_required_packages():
    # A probe for a package that left packages.txt would hide a stale entry.
    assert set(doctor.PROBES) <= set(doctor.required_packages())
    assert doctor.probe_file("geometry") == "geometry.sty"
    assert doctor.probe_file("cm") == "cmr10.tfm"


def _tlpdb() -> Path:
    try:
        root = subprocess.run(["kpsewhich", "-var-value", "TEXMFROOT"], capture_output=True, text=True).stdout.strip()
    except OSError:
        pytest.skip("kpsewhich is not installed")
    tlpdb = Path(root) / "tlpkg" / "texlive.tlpdb"
    if not root or not tlpdb.exists():
        pytest.skip("no TeX Live package database (not a TeX Live installation)")
    return tlpdb


@pytest.mark.tex
def test_every_probe_belongs_to_its_package():
    text = _tlpdb().read_text(encoding="utf-8", errors="replace")
    if f"depend release/{doctor.TESTED_TEXLIVE}\n" not in text:
        pytest.skip(f"packages.txt names TeX Live {doctor.TESTED_TEXLIVE} packages")
    runfiles: dict[str, set[str]] = {}
    package = None
    for line in text.splitlines():
        if line.startswith("name "):
            package = line[5:].strip()
        elif line.startswith(" ") and package:
            runfiles.setdefault(package, set()).add(line.split()[0].rsplit("/", 1)[-1])
    wrong = {p: doctor.probe_file(p) for p in doctor.required_packages()
             if doctor.probe_file(p) not in runfiles.get(p, set())}
    assert wrong == {}


@pytest.mark.tex
def test_local_tex_has_every_package():
    status = doctor.check_tex(engine.find_pdflatex())
    assert status.checked
    assert status.missing == []
    assert status.ok


def test_check_tex_without_pdflatex():
    status = doctor.check_tex(None)
    assert (status.pdflatex, status.ok) == (None, False)


@posix_only
def test_check_tex_reports_missing_packages(tmp_path):
    pdflatex = fake_tex(tmp_path, missing=["fontawesome.sty", "cmr10.tfm"])
    status = doctor.check_tex(str(pdflatex))
    assert status.checked
    assert status.missing == ["cm", "fontawesome"]
    assert not status.ok


@posix_only
def test_check_tex_finds_everything(tmp_path):
    status = doctor.check_tex(str(fake_tex(tmp_path)))
    assert (status.missing, status.ok) == ([], True)


@posix_only
def test_kpsewhich_next_to_pdflatex_wins(tmp_path, monkeypatch):
    pdflatex = fake_tex(tmp_path / "tex")
    fake_tex(tmp_path / "other", missing=["geometry.sty"])
    monkeypatch.setenv("PATH", str(tmp_path / "other"))
    assert doctor.find_kpsewhich(str(pdflatex)) == str(tmp_path / "tex" / "kpsewhich")
    assert doctor.check_tex(str(pdflatex)).ok


@posix_only
def test_stray_sty_files_in_the_current_directory_do_not_count(tmp_path, monkeypatch):
    pdflatex = fake_tex(tmp_path / "bin", missing=["fontawesome.sty"])
    (tmp_path / "cv").mkdir()
    (tmp_path / "cv" / "fontawesome.sty").write_text("% a copy left next to the CV\n")
    monkeypatch.chdir(tmp_path / "cv")
    assert doctor.check_tex(str(pdflatex)).missing == ["fontawesome"]


@posix_only
def test_kpsewhich_next_to_the_symlinked_pdflatex(tmp_path, monkeypatch):
    real = fake_tex(tmp_path / "texlive" / "bin")
    (tmp_path / "links").mkdir()
    (tmp_path / "links" / "pdflatex").symlink_to(real)
    fake_tex(tmp_path / "old", missing=["geometry.sty"])
    monkeypatch.setenv("PATH", f"{tmp_path / 'links'}{os.pathsep}{tmp_path / 'old'}")
    kpsewhich = doctor.find_kpsewhich(str(tmp_path / "links" / "pdflatex"))
    assert kpsewhich == str((tmp_path / "texlive" / "bin" / "kpsewhich").resolve())
    assert doctor.check_tex(str(tmp_path / "links" / "pdflatex")).ok


@posix_only
def test_without_kpsewhich_packages_are_not_checked(tmp_path, monkeypatch):
    pdflatex = fake_tex(tmp_path, kpsewhich=False)
    monkeypatch.setenv("PATH", str(tmp_path))
    status = doctor.check_tex(str(pdflatex))
    assert (status.checked, status.missing, status.ok) == (False, [], True)


@posix_only
@pytest.mark.parametrize("line, expected, year", [
    ("pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026)", "TeX Live 2026", 2026),
    ("pdfTeX 3.141592653-2.6-1.40.24 (TeX Live 2022/Debian)", "TeX Live 2022", 2022),
    ("MiKTeX-pdfTeX 4.19 (MiKTeX 24.4)", "MiKTeX-pdfTeX 4.19 (MiKTeX 24.4)", None),
])
def test_tex_distribution(tmp_path, line, expected, year):
    distribution = doctor.tex_distribution(str(fake_tex(tmp_path, version_line=line)))
    assert distribution == expected
    assert doctor.texlive_year(distribution) == year


def test_tex_distribution_of_a_broken_pdflatex(tmp_path):
    assert doctor.tex_distribution(str(tmp_path / "missing")) is None


@posix_only
@pytest.mark.parametrize("flags, expected", [
    ({}, doctor.DockerStatus("", True, "server 27.3.1")),
    ({"rootless": True}, doctor.DockerStatus("", True, "server 27.3.1, rootless", rootless=True)),
    ({"userns_remap": True}, doctor.DockerStatus("", True, "server 27.3.1", userns_remap=True)),
    ({"podman": True, "rootless": True},
     doctor.DockerStatus("", True, "Podman 5.2.0, rootless", rootless=True, podman=True)),
    ({"podman": True}, doctor.DockerStatus("", True, "Podman 5.2.0", podman=True)),
])
def test_check_docker_running(tmp_path, monkeypatch, flags, expected):
    fake_docker(tmp_path, **flags)
    monkeypatch.setenv("PATH", str(tmp_path))
    expected.path = str(tmp_path / "docker")
    assert doctor.check_docker() == expected


def test_docker_info_with_server_errors():
    """Docker 23 and newer print the report even when the daemon is down, with ServerErrors."""
    stdout = json.dumps({"ServerVersion": "", "ServerErrors": [DAEMON_DOWN], "ClientInfo": {"Version": "27.3.1"}})
    assert doctor.parse_docker_info("docker", 1, stdout, "") == doctor.DockerStatus("docker", False, DAEMON_DOWN)


def test_docker_info_of_podman_with_its_machine_stopped():
    stderr = "Cannot connect to Podman. Please verify your connection to the Linux system\nError: unable to connect"
    status = doctor.parse_docker_info("docker", 125, "", stderr)
    assert (status.running, status.detail) == (False, "Error: unable to connect")


def test_docker_info_that_is_not_json():
    status = doctor.parse_docker_info("docker", 0, "27.3.1\n", "")
    assert (status.running, status.detail) == (False, "the daemon is not running")


@posix_only
def test_check_docker_daemon_down(tmp_path, monkeypatch):
    fake_docker(tmp_path, running=False)
    monkeypatch.setenv("PATH", str(tmp_path))
    assert doctor.check_docker() == doctor.DockerStatus(str(tmp_path / "docker"), False, DAEMON_DOWN)


def test_check_docker_not_installed(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path))
    status = doctor.check_docker()
    assert status == doctor.DockerStatus(None, False, "not found")
    assert not status.installed


@posix_only
def test_has_image(tmp_path):
    assert doctor.has_image(str(fake_docker(tmp_path / "a")), "img:1")
    assert not doctor.has_image(str(fake_docker(tmp_path / "b", has_image=False)), "img:1")
    assert not doctor.has_image(str(tmp_path / "missing"), "img:1")
