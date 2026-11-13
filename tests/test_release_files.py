"""The Dockerfile, its helper script and the workflows (checked without Docker or GitHub)."""

import re
import shutil
import subprocess
import sys

import pytest

from helpers import ROOT

DOCKERFILE = (ROOT / "Dockerfile").read_text(encoding="utf-8")
WORKFLOWS = ROOT / ".github" / "workflows"


def test_pip_constraints_reach_the_build_backend():
    # pip 26.2 (in the base image) no longer applies PIP_CONSTRAINT to isolated builds.
    install = next(line for line in DOCKERFILE.splitlines() if "pip install /tmp/cv-tools" in line)
    assert "PIP_CONSTRAINT=/tmp/constraints.txt" in install
    assert "PIP_BUILD_CONSTRAINT=/tmp/constraints.txt" in install
    assert re.search(r"^setuptools==", (ROOT / "docker" / "constraints.txt").read_text(encoding="utf-8"), re.M)


def test_texlive_installs_from_one_mirror():
    runs = re.findall(r"^RUN (.*?)(?<!\\)$", DOCKERFILE, re.M | re.S)
    tex_runs = [r for r in runs if "tlmgr" in r]
    assert len(tex_runs) == 1
    assert tex_runs[0].count("tl-repository)") == 1
    assert "/tmp/packages.txt" in tex_runs[0]
    assert "!docker/tl-repository.sh" in (ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()
    assert "2027-07-13" in DOCKERFILE


def _github_glob(pattern: str) -> re.Pattern:
    """A GitHub Actions filter pattern (* and + as GitHub reads them) as a regex."""
    out = ""
    for token in re.findall(r"\[[^\]]*\]\+?|\*|.", pattern):
        if token == "*":
            out += "[^/]*"
        elif token.startswith("["):
            out += token
        else:
            out += re.escape(token)
    return re.compile(out + r"\Z")


@pytest.mark.parametrize("workflow", ["docker.yml", "release.yml", "pages.yml"])
def test_only_major_and_minor_tags_release(workflow):
    text = (WORKFLOWS / workflow).read_text(encoding="utf-8")
    (pattern,) = re.findall(r'tags: \["([^"]+)"\]', text)
    glob = _github_glob(pattern)
    for tag in ("v2.0.0", "v2.1.0", "v10.12.0"):
        assert glob.match(tag), tag
    for tag in ("v2.0.1", "v2.1.10", "v2.0.0rc1", "v2.0.0-beta.1", "v2.0.0.dev0", "v2.0", "version-2"):
        assert not glob.match(tag), tag


def test_release_publishes_to_pypi_with_trusted_publishing():
    text = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")
    tags = re.compile(r'tags: \["([^"]+)"\]')
    assert tags.findall(text) == tags.findall((WORKFLOWS / "docker.yml").read_text(encoding="utf-8"))
    assert "uses: ./.github/workflows/ci.yml" in text and "src/cv_tools/__init__.py" in text
    assert "twine==" in text and "twine check --strict" in text
    publish = text[text.index("\n  publish:") :]
    assert text.count("id-token: write") == 1 and "id-token: write" in publish
    assert "environment:\n      name: pypi" in publish and "uses: pypa/gh-action-pypi-publish@" in publish
    assert "secrets." not in text and "password" not in text


def test_actions_are_pinned_by_commit():
    for path in WORKFLOWS.glob("*.yml"):
        for ref in re.findall(r"uses: (\S+)", path.read_text(encoding="utf-8")):
            assert ref.startswith("./") or re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}", ref), (path.name, ref)


def test_ci_checks_that_the_local_tex_is_complete():
    text = (WORKFLOWS / "ci.yml").read_text(encoding="utf-8")
    assert "grep -q \"^ready: 'cv-tools build' uses the local pdflatex$\"" in text
    assert "tools/derive_unicode.py --check" in text


def test_weekly_fuzz_workflow():
    text = (WORKFLOWS / "fuzz.yml").read_text(encoding="utf-8")
    assert re.search(r"^  schedule:\n    - cron: \"\d+ \d+ \* \* \d\"", text, re.M)
    assert "workflow_dispatch:" in text
    assert 'CV_TOOLS_FUZZ: "1"' in text and 'CV_TOOLS_REQUIRE_TEX: "1"' in text


# -- docker/tl-repository.sh with a fake curl

pytestmark_posix = pytest.mark.skipif(sys.platform == "win32" or shutil.which("sh") is None, reason="POSIX shell")


def _repository(tmp_path, existing):
    """Run the script with a fake curl that finds only ``existing`` (mirror.ctan.org redirects to mirror.example)."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    urls = "\n".join(existing)
    (bin_dir / "curl").write_text(
        "#!/bin/sh\n"
        'for a in "$@"; do url="$a"; done\n'
        'case "$url" in https://mirror.ctan.org/*) echo https://mirror.example/tex/; exit 0 ;; esac\n'
        f'printf "%s\\n" "{urls}" | grep -qxF "$url" && exit 0\n'
        "exit 22\n"
    )
    (bin_dir / "curl").chmod(0o755)
    env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "TL_YEAR": "2026", "TL_HISTORIC": "https://hist.example/texlive",
           "TL_MIRROR": "https://mirror.ctan.org/systems/texlive/tlnet"}
    return subprocess.run(["sh", str(ROOT / "docker" / "tl-repository.sh")], env=env, capture_output=True, text=True)


@pytestmark_posix
def test_tl_repository_prefers_the_frozen_release(tmp_path):
    r = _repository(tmp_path, ["https://hist.example/texlive/2026/tlnet-final/tlpkg/texlive.tlpdb.sha512"])
    assert (r.returncode, r.stdout) == (0, "https://hist.example/texlive/2026/tlnet-final\n")


@pytestmark_posix
def test_tl_repository_uses_a_mirror_that_serves_the_year(tmp_path):
    r = _repository(tmp_path, ["https://mirror.example/tex/TEXLIVE_2026"])
    assert (r.returncode, r.stdout) == (0, "https://mirror.example/tex\n")


@pytestmark_posix
def test_tl_repository_fails_for_another_year(tmp_path):
    r = _repository(tmp_path, ["https://mirror.example/tex/TEXLIVE_2027"])
    assert r.returncode == 1
    assert r.stderr == (
        "no TeX Live 2026 package repository at https://mirror.ctan.org/systems/texlive/tlnet or the fallback mirrors\n"
    )


@pytestmark_posix
def test_tl_repository_falls_back_to_a_fixed_mirror(tmp_path):
    mit = "https://mirrors.mit.edu/CTAN/systems/texlive/tlnet"
    r = _repository(tmp_path, [f"{mit}/TEXLIVE_2026"])
    assert (r.returncode, r.stdout) == (0, mit + "\n")
