"""run.sh, the deprecated wrapper around ``cv-tools build``, with a fake checkout and a fake Python."""

import os
import shutil
import subprocess
import sys

import pytest

from helpers import ROOT, env

# On Windows, bash is Git Bash or WSL, and the fake Pythons are shell scripts.
pytestmark = pytest.mark.skipif(shutil.which("bash") is None or sys.platform == "win32",
                                reason="needs bash on a POSIX system")

NOTICE = "run.sh is deprecated and will be removed in a future release. Use 'cv-tools build' instead."


def bash():
    return shutil.which("bash")


def checkout(tmp_path, with_config=False):
    root = tmp_path / "repo"
    root.mkdir()
    shutil.copy(ROOT / "run.sh", root / "run.sh")
    (root / "src").symlink_to(ROOT / "src")
    shutil.copytree(ROOT / "examples", root / "examples")
    if with_config:
        (root / "config").mkdir()
        shutil.copy(ROOT / "examples" / "v1" / "cv.yaml", root / "config" / "cv.yaml")
        shutil.copy(ROOT / "examples" / "v1" / "publications.bib", root / "config" / "publications.bib")
    return root


def fake_python(tmp_path, import_ok=True, name="fakepython", version=None, environment=True, venv_template=None):
    """A 'python' that logs each call; ``version`` makes it an old one, ``-m venv`` copies ``venv_template``."""
    log = tmp_path / f"{name}.log"
    script = tmp_path / name
    old = (
        f'case "$2" in *version_info*) exit 1 ;; *python_version*) echo {version}; exit 0 ;; esac\n'
        if version else ""
    )
    venv = (
        f'if [ "$1" = -m ] && [ "$2" = venv ]; then {shutil.which("mkdir")} -p "$3/bin"; '
        f'{shutil.which("cp")} "{venv_template}" "$3/bin/python"; exit 0; fi\n'
        if venv_template else ""
    )
    script.write_text(
        "#!/bin/sh\n"
        f'printf "%s\\n" "$@" -- >> "{log}"\n'
        + old
        + f'case "$2" in *base_prefix*) exit {0 if environment else 1} ;; esac\n'
        + venv
        + 'if [ "$1" = -c ] && [ "$2" = "import cv_tools.cli" ]; then '
        + ("exit 0" if import_ok else "echo \"ModuleNotFoundError: No module named 'yaml'\" >&2; exit 1")
        + "; fi\n"
        "exit 0\n"
    )
    script.chmod(0o755)
    return script, log


def calls(log):
    out, current = [], []
    for line in log.read_text(encoding="utf-8").splitlines():
        if line == "--":
            out.append(current)
            current = []
        else:
            current.append(line)
    return out


def run_sh(root, *args, cwd, python=None, path=None, extra_env=None):
    variables = env()
    for name in ("CV_TOOLS_PYTHON", "VIRTUAL_ENV", "CONDA_PREFIX"):
        variables.pop(name, None)
    variables.update(extra_env or {})
    if python is not None:
        variables["CV_TOOLS_PYTHON"] = str(python)
    if path is not None:
        variables["PATH"] = path
    return subprocess.run([bash(), str(root / "run.sh"), *args], cwd=cwd, env=variables,
                          capture_output=True, text=True)


def test_help_and_usage_errors(tmp_path):
    r = run_sh(ROOT, "-h", cwd=tmp_path)
    assert r.returncode == 0
    assert r.stdout.startswith(f"Usage: {ROOT / 'run.sh'} [-c config_file] [-o output_file] [--tex-only] [--no-deps]")
    for flag in ("-c, --config", "-o, --output", "--tex-only", "--no-deps", "-h, --help"):
        assert f"  {flag}" in r.stdout
    r = run_sh(ROOT, "--frobnicate", cwd=tmp_path)
    assert r.returncode == 1
    assert r.stderr.startswith("run.sh: error: invalid option --frobnicate\nUsage:")
    r = run_sh(ROOT, "-o", cwd=tmp_path)
    assert (r.returncode, r.stderr.splitlines()[0]) == (1, "run.sh: error: option -o needs a value")


def test_defaults_use_examples_and_output_dir(tmp_path):
    root = checkout(tmp_path)
    python, log = fake_python(tmp_path)
    r = run_sh(root, cwd=tmp_path, python=python)
    assert r.returncode == 0, r.stderr
    assert r.stderr == f"{NOTICE}\nrun.sh: building {root}/examples/cv.yaml\n"
    version_check, import_check, build = calls(log)
    assert version_check[0] == "-c" and "version_info" in version_check[1]
    assert import_check == ["-c", "import cv_tools.cli"]
    assert build == ["-m", "cv_tools", "build", f"{root}/examples/cv.yaml", "-o", f"{root}/output/output.tex",
                     "--engine", "auto"]


def test_default_config_prefers_config_dir(tmp_path):
    root = checkout(tmp_path, with_config=True)
    python, log = fake_python(tmp_path)
    r = run_sh(root, "--tex-only", cwd=tmp_path, python=python)
    assert r.returncode == 0
    assert r.stderr.splitlines()[1] == f"run.sh: building {root}/config/cv.yaml"
    assert calls(log)[-1] == ["-m", "cv_tools", "build", f"{root}/config/cv.yaml", "-o",
                              f"{root}/output/output.tex", "--tex-only", "--engine", "auto"]


def test_config_dir_without_cv_yaml_is_an_error(tmp_path):
    """A user who renamed config/cv.yaml must not get the example CV instead of theirs."""
    root = checkout(tmp_path)
    (root / "config").mkdir()
    (root / "config" / "config.yaml").write_text("heading: {name: Me}\n")
    (root / "config" / "publications.bib").write_text("")
    python, log = fake_python(tmp_path)
    r = run_sh(root, cwd=tmp_path, python=python)
    assert r.returncode == 1
    assert r.stderr.splitlines() == [
        NOTICE,
        f"run.sh: error: {root}/config/cv.yaml does not exist",
        f"YAML files in {root}/config:",
        f"  {root}/config/config.yaml",
        f"Choose the CV file with -c, for example: {root}/run.sh -c {root}/config/config.yaml",
    ]
    assert not log.exists()  # nothing was built
    (root / "config" / "config.yaml").unlink()
    r = run_sh(root, cwd=tmp_path, python=python)
    assert r.returncode == 1
    assert f"{root}/config has no YAML files." in r.stderr.splitlines()
    # -c still works.
    r = run_sh(root, "-c", "config/other.yaml", cwd=tmp_path, python=python)
    assert r.returncode == 0, r.stderr
    assert calls(log)[-1][3] == "config/other.yaml"


def _bin_with(tmp_path, *pythons):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    os.symlink(shutil.which("dirname"), bin_dir / "dirname")
    logs = {}
    for name, version in pythons:
        _, logs[name] = fake_python(bin_dir, name=name, version=version)
    return bin_dir, logs


def test_python_search_prefers_python3_when_new_enough(tmp_path):
    root = checkout(tmp_path)
    bin_dir, logs = _bin_with(tmp_path, ("python3", None), ("python3.11", None))
    r = run_sh(root, "--tex-only", cwd=tmp_path, path=str(bin_dir))
    assert r.returncode == 0, r.stderr
    assert calls(logs["python3"])[-1][:3] == ["-m", "cv_tools", "build"]
    assert not logs["python3.11"].exists()


def test_python_search_falls_back_to_versioned_names(tmp_path):
    root = checkout(tmp_path)
    bin_dir, logs = _bin_with(tmp_path, ("python3", "3.9.6"), ("python3.11", None))
    r = run_sh(root, "--tex-only", cwd=tmp_path, path=str(bin_dir))
    assert r.returncode == 0, r.stderr
    assert calls(logs["python3.11"])[-1][:3] == ["-m", "cv_tools", "build"]
    assert len(calls(logs["python3"])) == 1  # only asked for its version


def test_active_environments_come_first(tmp_path):
    # $VIRTUAL_ENV, then $CONDA_PREFIX, then .venv of the checkout, then PATH.
    root = checkout(tmp_path)
    (root / ".venv" / "bin").mkdir(parents=True)
    _, checkout_log = fake_python(root / ".venv" / "bin", name="python")
    (tmp_path / "active" / "bin").mkdir(parents=True)
    _, venv_log = fake_python(tmp_path / "active" / "bin", name="python")
    (tmp_path / "conda" / "bin").mkdir(parents=True)
    _, conda_log = fake_python(tmp_path / "conda" / "bin", name="python")
    bin_dir, logs = _bin_with(tmp_path, ("python3", None))
    both = {"VIRTUAL_ENV": str(tmp_path / "active"), "CONDA_PREFIX": str(tmp_path / "conda")}
    assert run_sh(root, cwd=tmp_path, path=str(bin_dir), extra_env=both).returncode == 0
    assert calls(venv_log)[-1][:3] == ["-m", "cv_tools", "build"]
    assert not conda_log.exists() and not checkout_log.exists() and not logs["python3"].exists()
    r = run_sh(root, cwd=tmp_path, path=str(bin_dir), extra_env={"CONDA_PREFIX": str(tmp_path / "conda")})
    assert r.returncode == 0, r.stderr
    assert calls(conda_log)[-1][:3] == ["-m", "cv_tools", "build"]
    assert not checkout_log.exists()


def test_python_search_skips_old_pythons(tmp_path):
    root = checkout(tmp_path)
    (root / ".venv" / "bin").mkdir(parents=True)
    _, venv_log = fake_python(root / ".venv" / "bin", name="python", version="3.8.10")
    bin_dir, logs = _bin_with(tmp_path, ("python3", None))
    r = run_sh(root, "--tex-only", cwd=tmp_path, path=str(bin_dir))
    assert r.returncode == 0, r.stderr
    assert len(calls(venv_log)) == 1  # only asked for its version
    assert calls(logs["python3"])[-1][:3] == ["-m", "cv_tools", "build"]


def test_no_new_python_names_cv_tools_python(tmp_path):
    root = checkout(tmp_path)
    bin_dir, _ = _bin_with(tmp_path, ("python3", "3.9.6"))
    r = run_sh(root, cwd=tmp_path, path=str(bin_dir))
    assert r.returncode == 1
    assert r.stderr.splitlines()[-1] == (
        "run.sh: error: Python 3.10 or newer is required (python3 is 3.9.6); set CV_TOOLS_PYTHON to a newer Python"
    )
    (bin_dir / "python3").unlink()
    r = run_sh(root, cwd=tmp_path, path=str(bin_dir))
    assert r.stderr.splitlines()[-1] == (
        "run.sh: error: Python 3.10 or newer is required, but no python3 was found; set CV_TOOLS_PYTHON to one"
    )


def test_the_checkout_venv_comes_first(tmp_path):
    root = checkout(tmp_path)
    (root / ".venv" / "bin").mkdir(parents=True)
    _, venv_log = fake_python(root / ".venv" / "bin", name="python")
    bin_dir, logs = _bin_with(tmp_path, ("python3.13", None))
    assert run_sh(root, cwd=tmp_path, path=str(bin_dir)).returncode == 0
    assert calls(venv_log)[-1][:3] == ["-m", "cv_tools", "build"]
    assert not logs["python3.13"].exists()


def test_flags_map_to_build_options(tmp_path):
    root = checkout(tmp_path)
    python, log = fake_python(tmp_path)
    r = run_sh(root, "--config", "my cv.yaml", "--output", "out/cv.tex", "--tex-only", "--no-deps",
               cwd=tmp_path, python=python)
    assert r.returncode == 0, r.stderr
    # --no-deps skips the dependency check and calls pdflatex directly, as before.
    assert calls(log)[-1] == ["-m", "cv_tools", "build", "my cv.yaml", "-o", "out/cv.tex", "--tex-only",
                              "--engine", "pdflatex"]
    assert len(calls(log)) == 3  # version, import, build: nothing is installed


def test_missing_dependencies_are_installed_into_the_environment(tmp_path):
    root = checkout(tmp_path)
    python, log = fake_python(tmp_path, import_ok=False, environment=True)
    r = run_sh(root, "-c", "cv.yaml", cwd=tmp_path, python=python)
    assert r.returncode == 0, r.stderr
    assert ["-m", "pip", "install", str(root)] in calls(log)
    assert calls(log)[-1][:3] == ["-m", "cv_tools", "build"]
    assert f"run.sh: installing cv-tools and its dependencies with pip into the environment of {python}" in r.stderr
    assert not (root / ".venv").exists()


def test_a_system_python_gets_a_checkout_venv(tmp_path):
    # PEP 668 forbids pip outside an environment, so run.sh creates .venv instead.
    root = checkout(tmp_path)
    (tmp_path / "template").mkdir()
    template, venv_log = fake_python(tmp_path / "template", import_ok=False, name="venvpython")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    os.symlink(shutil.which("dirname"), bin_dir / "dirname")
    _, system_log = fake_python(bin_dir, import_ok=False, name="python3", environment=False, venv_template=template)
    r = run_sh(root, cwd=tmp_path, path=str(bin_dir))
    assert r.returncode == 0, r.stderr
    venv_python = root / ".venv" / "bin" / "python"
    assert ["-m", "venv", str(root / ".venv")] in calls(system_log)
    assert not any(c[:2] == ["-m", "pip"] for c in calls(system_log))
    assert ["-m", "pip", "install", str(root)] in calls(venv_log)
    assert calls(venv_log)[-1][:3] == ["-m", "cv_tools", "build"]
    assert r.stderr.splitlines()[2:4] == [
        f"run.sh: creating a virtual environment in {root}/.venv with python3",
        f"run.sh: installing cv-tools and its dependencies with pip into the environment of {venv_python}",
    ]


def test_an_unusable_checkout_venv_is_not_overwritten(tmp_path):
    root = checkout(tmp_path)
    (root / ".venv" / "bin").mkdir(parents=True)
    fake_python(root / ".venv" / "bin", name="python", version="3.8.10")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    os.symlink(shutil.which("dirname"), bin_dir / "dirname")
    _, system_log = fake_python(bin_dir, import_ok=False, name="python3", environment=False)
    r = run_sh(root, cwd=tmp_path, path=str(bin_dir))
    assert r.returncode == 1
    assert r.stderr.splitlines()[-1] == (
        f"run.sh: error: {root}/.venv exists but has no usable Python 3.10 or newer; "
        "remove it or set CV_TOOLS_PYTHON"
    )
    assert not any(c[:2] in (["-m", "pip"], ["-m", "venv"]) for c in calls(system_log))


def test_no_deps_with_missing_modules_prints_a_hint(tmp_path):
    root = checkout(tmp_path)
    python, log = fake_python(tmp_path, import_ok=False)
    r = run_sh(root, "--no-deps", cwd=tmp_path, python=python)
    assert r.returncode == 1
    assert r.stderr.splitlines()[-1] == (
        f"run.sh: error: {python} cannot import cv-tools (ModuleNotFoundError: No module named 'yaml'); "
        "run without --no-deps to install its dependencies"
    )
    assert not any(c[:2] == ["-m", "pip"] for c in calls(log))


def test_a_cv_tools_python_that_does_not_run(tmp_path):
    r = run_sh(ROOT, cwd=tmp_path, python=tmp_path / "nope")
    assert r.returncode == 1
    assert r.stderr.splitlines()[-1] == (
        f"run.sh: error: Python 3.10 or newer is required (CV_TOOLS_PYTHON={tmp_path / 'nope'} cannot be run as Python)"
    )


def test_python_path_points_to_the_checkout(tmp_path):
    root = checkout(tmp_path)
    script = tmp_path / "py"
    script.write_text(f'#!/bin/sh\necho "$PYTHONPATH" > "{tmp_path}/pythonpath"\nexit 0\n')
    script.chmod(0o755)
    run_sh(root, "--no-deps", cwd=tmp_path, python=script)
    assert (tmp_path / "pythonpath").read_text(encoding="utf-8").strip().split(":")[0] == f"{root}/src"


def test_old_python_is_rejected(tmp_path):
    script = tmp_path / "py"
    script.write_text('#!/bin/sh\nif [ "$1" = -c ]; then case "$2" in *version_info*) exit 1 ;; esac; echo 3.8.10; fi\n')
    script.chmod(0o755)
    r = run_sh(ROOT, cwd=tmp_path, python=script)
    assert r.returncode == 1
    assert r.stderr.splitlines()[-1] == (
        f"run.sh: error: Python 3.10 or newer is required (CV_TOOLS_PYTHON={script} is 3.8.10)"
    )


def test_tex_only_with_the_real_package(tmp_path):
    r = run_sh(ROOT, "-c", ROOT / "examples" / "cv.yaml", "-o", "out/output.tex", "--tex-only",
               cwd=tmp_path, python=sys.executable)
    assert r.returncode == 0, r.stderr
    assert r.stderr.splitlines() == [NOTICE, f"run.sh: building {ROOT / 'examples' / 'cv.yaml'}",
                                     "wrote out/output.tex", "wrote out/resume.cls", "wrote out/orcid.pdf"]


def test_no_deps_runs_pdflatex_without_checks(tmp_path):
    # Only dirname on PATH: no pdflatex and no docker, so the explicit pdflatex engine fails.
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    os.symlink(shutil.which("dirname"), bin_dir / "dirname")
    r = run_sh(ROOT, "-c", ROOT / "examples" / "cv.yaml", "-o", "out/x.tex", "--no-deps",
               cwd=tmp_path, python=sys.executable, path=str(bin_dir))
    assert r.returncode == 1
    assert r.stderr.splitlines()[-1] == (
        "error: pdflatex not found. Install TeX Live, or use --tex-only and compile the .tex elsewhere."
    )


@pytest.mark.tex
def test_full_build(tmp_path):
    r = run_sh(ROOT, "-c", ROOT / "examples" / "v1" / "cv.yaml", "-o", "output/output.tex",
               cwd=tmp_path, python=sys.executable)
    assert r.returncode == 0, r.stderr
    assert sorted(p.name for p in (tmp_path / "output").iterdir()) == [
        "orcid.pdf", "output.pdf", "output.tex", "resume.cls",
    ]
    assert r.stderr.splitlines()[:3] == [NOTICE, f"run.sh: building {ROOT / 'examples' / 'v1' / 'cv.yaml'}",
                                         f"cv-tools: {ROOT / 'examples' / 'v1' / 'cv.yaml'} uses the v1 format, "
                                         "which is deprecated and will be removed in a future release. "
                                         f"Run 'cv-tools migrate {ROOT / 'examples' / 'v1' / 'cv.yaml'}' to convert it."]
