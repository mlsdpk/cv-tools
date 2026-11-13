"""The cv-tools command line, run as a subprocess."""

import csv
import os
import shutil
import stat
import subprocess
import sys
import sysconfig
from dataclasses import dataclass
from pathlib import Path

import pytest

from cv_tools import __version__, api, cli
from cv_tools.cli import main
from cv_tools.loader import load_text

from fakes import FAKE_PDF, fake_docker, posix_only, run_args
from helpers import FIXTURES, ROOT, env

V1_EXAMPLE = ROOT / "examples" / "v1" / "cv.yaml"
V2_EXAMPLE = ROOT / "examples" / "cv.yaml"


@dataclass
class Result:
    returncode: int
    stdout: str
    stderr: str


@pytest.fixture(params=["subprocess", "in-process"])
def run(request, monkeypatch, capsys):
    """Run cv-tools as a subprocess, or call cli.main() so coverage sees the CLI."""

    def runner(*args, cwd, extra_env=None):
        variables = {**env(), **(extra_env or {})}
        argv = [str(a) for a in args]
        if request.param == "subprocess":
            r = subprocess.run(
                [sys.executable, "-m", "cv_tools", *argv], cwd=cwd, env=variables, capture_output=True, text=True
            )
            return Result(r.returncode, r.stdout, r.stderr)
        monkeypatch.chdir(cwd)
        for key, value in variables.items():
            monkeypatch.setenv(key, value)
        capsys.readouterr()
        try:
            code = main(argv)
        except SystemExit as e:  # argparse usage errors and --version
            code = e.code
        out = capsys.readouterr()
        return Result(code, out.out, out.err)

    return runner


def deprecation(path):
    return (
        f"cv-tools: {path} uses the v1 format, which is deprecated and will be removed in a future release. "
        f"Run 'cv-tools migrate {path}' to convert it."
    )


@pytest.mark.tex
def test_build_v2_writes_pdf(run, tmp_path):
    r = run("build", V2_EXAMPLE, cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    assert (tmp_path / "cv.pdf").read_bytes().startswith(b"%PDF")
    assert r.stderr == "wrote cv.pdf\n"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["cv.pdf"]


@pytest.mark.tex
def test_build_v1_prints_deprecation(run, tmp_path):
    r = run("build", V1_EXAMPLE, "-o", "out/v1.pdf", cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    assert r.stderr.splitlines() == [deprecation(V1_EXAMPLE), "wrote out/v1.pdf"]
    assert (tmp_path / "out" / "v1.pdf").exists()


@pytest.mark.tex
def test_build_to_tex_path_keeps_sources_and_pdf(run, tmp_path):
    # run.sh passed the .tex path with -o; the PDF lands next to it.
    r = run("build", V2_EXAMPLE, "-o", "output/output.tex", cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    assert sorted(p.name for p in (tmp_path / "output").iterdir()) == [
        "orcid.pdf", "output.pdf", "output.tex", "resume.cls",
    ]


def test_tex_only(run, tmp_path):
    r = run("build", V2_EXAMPLE, "--tex-only", cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    assert sorted(p.name for p in tmp_path.iterdir()) == ["cv.tex", "orcid.pdf", "resume.cls"]
    assert "\\documentclass{resume}" in (tmp_path / "cv.tex").read_text(encoding="utf-8")
    assert r.stderr.splitlines() == ["wrote cv.tex", "wrote resume.cls", "wrote orcid.pdf"]


def test_tex_only_needs_no_pdflatex(run, tmp_path):
    r = run("build", V2_EXAMPLE, "--tex-only", "-o", "x.tex", cwd=tmp_path, extra_env={"PATH": "/nonexistent"})
    assert r.returncode == 0, r.stderr
    assert (tmp_path / "x.tex").exists()


def test_missing_pdflatex_is_an_error(run, tmp_path):
    r = run("build", V2_EXAMPLE, cwd=tmp_path, extra_env={"PATH": "/nonexistent"})
    assert r.returncode == 1
    assert r.stderr.splitlines() == [
        "error: cannot build the PDF. pdflatex was not found, and Docker is not installed.",
        "Choose one of these:",
        "  - install TeX Live (https://tug.org/texlive/), then check it with 'cv-tools doctor'",
        "  - install Docker and start it; cv-tools then compiles in the ghcr.io/mlsdpk/cv-tools image",
        "  - run 'cv-tools build --zip' and upload the zip to Overleaf, or use --tex-only and compile the .tex elsewhere",
    ]
    r = run("build", V2_EXAMPLE, "--engine", "pdflatex", cwd=tmp_path, extra_env={"PATH": "/nonexistent"})
    assert r.returncode == 1
    assert r.stderr.strip() == (
        "error: pdflatex not found. Install TeX Live, or use --tex-only and compile the .tex elsewhere."
    )


@pytest.mark.tex
def test_latex_errors_are_reported(run, tmp_path):
    cv = tmp_path / "bad.yaml"
    cv.write_text("version: 2\nname: {latex: '\\undefinedmacro'}\nsections: []\n")
    r = run("build", cv, cwd=tmp_path)
    assert r.returncode == 1
    assert r.stderr.startswith("error: pdflatex failed:\n! Undefined control sequence.")


def test_migrate_to_stdout_and_file(run, tmp_path):
    shutil.copy(V1_EXAMPLE, tmp_path / "old.yaml")
    shutil.copy(V1_EXAMPLE.parent / "publications.bib", tmp_path / "publications.bib")
    r = run("migrate", "old.yaml", cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    assert r.stdout.startswith("# yaml-language-server: $schema=")
    assert r.stderr == ""
    r = run("migrate", "old.yaml", "-o", "new.yaml", cwd=tmp_path)
    assert r.returncode == 0
    assert (tmp_path / "new.yaml").read_text(encoding="utf-8") == run("migrate", "old.yaml", cwd=tmp_path).stdout
    assert r.stderr == "wrote new.yaml\n"


def test_migrate_into_another_directory_keeps_the_bib_file(run, tmp_path):
    (tmp_path / "old").mkdir()
    shutil.copy(V1_EXAMPLE, tmp_path / "old" / "cv.yaml")
    shutil.copy(V1_EXAMPLE.parent / "publications.bib", tmp_path / "old" / "publications.bib")
    r = run("migrate", "old/cv.yaml", "-o", "new/cv.yaml", cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    text = (tmp_path / "new" / "cv.yaml").read_text(encoding="utf-8")
    stdout = run("migrate", "old/cv.yaml", cwd=tmp_path).stdout
    assert "    bib: publications.bib\n" in stdout
    assert text == stdout.replace("    bib: publications.bib\n", "    bib: ../old/publications.bib\n")
    doc = api.load(tmp_path / "new" / "cv.yaml")
    assert [s.bib for s in doc.sections if s.bib] == [(tmp_path / "old" / "publications.bib").resolve()]


def test_rebase_bib_paths_quotes_when_needed(tmp_path):
    text = "version: 2\nname: x\nsections:\n  - title: P\n    layout: publications\n    bib: 'my pubs.bib'  # mine\n"
    out = cli.rebase_bib_paths(text, tmp_path / "a b", tmp_path / "c")
    assert out.splitlines()[-1] == '    bib: "../a b/my pubs.bib"  # mine'
    assert cli.rebase_bib_paths(text, tmp_path, tmp_path) == text
    absolute = text.replace("'my pubs.bib'", (tmp_path / "abs" / "pubs.bib").as_posix())
    assert cli.rebase_bib_paths(absolute, tmp_path / "a", tmp_path / "c") == absolute
    # Directories that share only the root get an absolute path, not a chain of '..'.
    root = Path(tmp_path.anchor)
    far = cli.rebase_bib_paths(text, root / "cv-tools-test-a", root / "cv-tools-test-b")
    assert far.splitlines()[-1] == f'    bib: "{(root / "cv-tools-test-a" / "my pubs.bib").as_posix()}"  # mine'


@pytest.mark.parametrize("name, written", [
    ("2024", '"2024"'), ("yes", '"yes"'), ("1e3", '"1e3"'), ("null", '"null"'), ("pubs.bib", "pubs.bib"),
])
def test_rebased_bib_paths_stay_strings(tmp_path, name, written):
    # Moving the file into sub/ turns "sub/2024" into "2024", which as a plain
    # scalar would load as a number.
    text = f"version: 2\nname: x\nsections:\n  - title: P\n    layout: publications\n    bib: sub/{name}\n"
    out = cli.rebase_bib_paths(text, tmp_path, tmp_path / "sub")
    assert out.splitlines()[-1] == f"    bib: {written}"
    assert load_text(out).data["sections"][0]["bib"] == name


def test_migrate_into_a_directory(run, tmp_path):
    (tmp_path / "old").mkdir()
    shutil.copy(V1_EXAMPLE, tmp_path / "old" / "my-cv.yaml")
    shutil.copy(V1_EXAMPLE.parent / "publications.bib", tmp_path / "old" / "publications.bib")
    (tmp_path / "existing").mkdir()
    for target, written in [("existing", str(Path("existing/my-cv.yaml"))), ("new/", str(Path("new/my-cv.yaml")))]:
        r = run("migrate", "old/my-cv.yaml", "-o", target, cwd=tmp_path)
        assert (r.returncode, r.stderr) == (0, f"wrote {written}\n")
        doc = api.load(tmp_path / written)
        assert [s.bib for s in doc.sections if s.bib] == [(tmp_path / "old" / "publications.bib").resolve()]
    # The overwrite rules apply to the file inside the directory.
    r = run("migrate", "old/my-cv.yaml", "-o", "existing", cwd=tmp_path)
    assert (r.returncode, r.stderr) == (1, f"{Path('existing/my-cv.yaml')}: error: already exists; use --force to overwrite it\n")
    r = run("migrate", "old/my-cv.yaml", "-o", "old/", "--force", cwd=tmp_path)
    assert r.returncode == 1 and "the output is the input file" in r.stderr


@pytest.mark.skipif(sys.platform == "win32", reason="symlinks need privileges on Windows")
def test_migrate_follows_symlinks_like_the_loader(run, tmp_path):
    # A symlinked v1 file names its .bib relative to the real file, and a
    # symlinked output directory reads its .bib relative to the real directory.
    real = tmp_path / "real" / "deep"
    real.mkdir(parents=True)
    shutil.copy(V1_EXAMPLE, real / "cv.yaml")
    shutil.copy(V1_EXAMPLE.parent / "publications.bib", real / "publications.bib")
    (tmp_path / "link").mkdir()
    (tmp_path / "link" / "cv.yaml").symlink_to(real / "cv.yaml")
    (tmp_path / "out-real" / "x").mkdir(parents=True)
    (tmp_path / "out").symlink_to(tmp_path / "out-real" / "x")
    r = run("migrate", "link/cv.yaml", "-o", "out/cv.yaml", cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    doc = api.load(tmp_path / "out" / "cv.yaml")
    assert [s.bib for s in doc.sections if s.bib] == [(real / "publications.bib").resolve()]


def test_migrate_refuses_to_overwrite(run, tmp_path):
    (tmp_path / "new.yaml").write_text("mine")
    r = run("migrate", V1_EXAMPLE, "-o", "new.yaml", cwd=tmp_path)
    assert (r.returncode, r.stderr) == (1, "new.yaml: error: already exists; use --force to overwrite it\n")
    assert (tmp_path / "new.yaml").read_text(encoding="utf-8") == "mine"
    r = run("migrate", V1_EXAMPLE, "-o", "new.yaml", "--force", cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    assert (tmp_path / "new.yaml").read_text(encoding="utf-8").startswith("# yaml-language-server")


def test_migrate_never_overwrites_its_input(run, tmp_path):
    shutil.copy(V1_EXAMPLE, tmp_path / "cv.yaml")
    before = (tmp_path / "cv.yaml").read_text(encoding="utf-8")
    for target in ("cv.yaml", "./sub/../cv.yaml", str(tmp_path / "cv.yaml")):
        (tmp_path / "sub").mkdir(exist_ok=True)
        r = run("migrate", "cv.yaml", "-o", target, "--force", cwd=tmp_path)
        assert r.returncode == 1
        assert r.stderr == (f"{target}: error: the output is the input file; write the v2 file elsewhere "
                            "and check it before replacing the v1 file\n")
    assert (tmp_path / "cv.yaml").read_text(encoding="utf-8") == before


def test_migrate_prints_warnings(run, tmp_path):
    shutil.copy(FIXTURES / "v1" / "ignored-data" / "cv.yaml", tmp_path / "cv.yaml")
    r = run("migrate", "cv.yaml", cwd=tmp_path)
    assert r.returncode == 0
    assert r.stderr.splitlines()[0] == "cv.yaml:5:3: warning: v1 ignores the field 'email'; it is dropped"
    assert len(r.stderr.splitlines()) == 8


def test_migrate_errors(run, tmp_path):
    r = run("migrate", FIXTURES / "invalid" / "duplicate-key-v1.yaml", cwd=tmp_path)
    assert r.returncode == 1
    assert r.stderr.endswith("duplicate-key-v1.yaml:130:9: error: duplicate key 'year' (first defined on line 129)\n")
    r = run("migrate", V2_EXAMPLE, cwd=tmp_path)
    assert (r.returncode, r.stderr) == (1, f"{V2_EXAMPLE}: error: the file already uses the v2 format\n")
    r = run("migrate", "missing.yaml", cwd=tmp_path)
    assert (r.returncode, r.stderr) == (1, "missing.yaml: error: cannot read file: No such file or directory\n")


def test_validate(run, tmp_path):
    r = run("validate", V2_EXAMPLE, V1_EXAMPLE, cwd=tmp_path)
    assert r.returncode == 0
    assert r.stdout.splitlines() == [f"{V2_EXAMPLE}: valid (v2)", f"{V1_EXAMPLE}: valid (v1)"]
    assert r.stderr.splitlines() == [deprecation(V1_EXAMPLE)]


def test_validate_reports_every_file(run, tmp_path):
    bad = FIXTURES / "invalid" / "misspelled-key.yaml"
    r = run("validate", bad, V2_EXAMPLE, cwd=tmp_path)
    assert r.returncode == 1
    assert r.stdout == f"{V2_EXAMPLE}: valid (v2)\n"
    assert r.stderr == f"{bad}:7:9: error: sections[0].entries[0].titel: unknown key 'titel'; did you mean 'title'?\n"


def test_build_invalid_file_fails_before_latex(run, tmp_path):
    r = run("build", FIXTURES / "invalid" / "unknown-layout.yaml", cwd=tmp_path, extra_env={"PATH": "/nonexistent"})
    assert r.returncode == 1
    assert "unknown value 'dates'; did you mean 'dated'?" in r.stderr
    assert list(tmp_path.iterdir()) == []


def test_usage_errors_exit_2(run, tmp_path):
    assert run(cwd=tmp_path).returncode == 2
    assert run("build", cwd=tmp_path).returncode == 2
    assert run("frobnicate", cwd=tmp_path).returncode == 2


def test_version(run, tmp_path):
    r = run("--version", cwd=tmp_path)
    assert (r.returncode, r.stdout) == (0, f"cv-tools {__version__}\n")


def test_console_script_is_installed():
    exe = shutil.which("cv-tools", path=sysconfig.get_path("scripts"))
    assert exe is not None
    r = subprocess.run([exe, "--version"], capture_output=True, text=True)
    assert r.stdout == f"cv-tools {__version__}\n"


# -- v1 warnings during a build


def test_build_summarizes_v1_warnings(run, tmp_path):
    shutil.copy(FIXTURES / "v1" / "ignored-data" / "cv.yaml", tmp_path / "cv.yaml")
    r = run("build", "cv.yaml", "--tex-only", cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    assert r.stderr.splitlines() == [
        deprecation("cv.yaml"),
        "cv-tools: 8 v1 fields or items were ignored, as v1 ignored them; "
        "run 'cv-tools validate cv.yaml' for details",
        "wrote cv.tex", "wrote resume.cls", "wrote orcid.pdf",
    ]
    # validate still lists each one.
    r = run("validate", "cv.yaml", cwd=tmp_path)
    assert len(r.stderr.splitlines()) == 1 + 8
    assert r.stderr.splitlines()[1] == "cv.yaml:5:3: warning: v1 ignores the field 'email'; it is dropped"


def test_build_summary_is_singular_for_one_warning(run, tmp_path):
    text = V1_EXAMPLE.read_text(encoding="utf-8").replace("heading:\n", "heading:\n  nickname: JD\n", 1)
    assert "nickname" in text
    (tmp_path / "cv.yaml").write_text(text)
    shutil.copy(V1_EXAMPLE.parent / "publications.bib", tmp_path / "publications.bib")
    r = run("build", "cv.yaml", "--tex-only", cwd=tmp_path)
    assert r.stderr.splitlines()[1] == (
        "cv-tools: 1 v1 field or item was ignored, as v1 ignored them; run 'cv-tools validate cv.yaml' for details"
    )


def test_build_prints_other_warnings_in_full(run, tmp_path):
    shutil.copytree(FIXTURES / "v1-bugfix" / "missing-bib-fields", tmp_path / "cv")
    r = run("build", "cv/cv.yaml", "--tex-only", "-o", "out.tex", cwd=tmp_path)
    lines = r.stderr.splitlines()
    assert lines[0] == deprecation(Path("cv/cv.yaml"))
    assert not any("fields or items" in line for line in lines)
    assert sum(": warning: entry " in line for line in lines) == 6


# -- --zip


def test_zip(run, tmp_path):
    import zipfile

    r = run("build", V2_EXAMPLE, "--zip", cwd=tmp_path, extra_env={"PATH": "/nonexistent"})
    assert r.returncode == 0, r.stderr
    assert r.stderr == "wrote cv.zip\n"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["cv.zip"]
    with zipfile.ZipFile(tmp_path / "cv.zip") as z:
        assert z.namelist() == ["cv.tex", "resume.cls", "orcid.pdf"]
        assert "\\documentclass{resume}" in z.read("cv.tex").decode()
    first = (tmp_path / "cv.zip").read_bytes()
    r = run("build", V2_EXAMPLE, "--zip", "-o", "overleaf/john.pdf", cwd=tmp_path)
    assert r.stderr == f"wrote {Path('overleaf/john.zip')}\n"
    with zipfile.ZipFile(tmp_path / "overleaf" / "john.zip") as z:
        assert z.namelist() == ["john.tex", "resume.cls", "orcid.pdf"]
    run("build", V2_EXAMPLE, "--zip", cwd=tmp_path)
    assert (tmp_path / "cv.zip").read_bytes() == first  # same input, same bytes


def test_zip_and_tex_only_exclude_each_other(run, tmp_path):
    r = run("build", V2_EXAMPLE, "--zip", "--tex-only", cwd=tmp_path)
    assert r.returncode == 2
    assert "not allowed with argument" in r.stderr


# -- --engine docker


@posix_only
def test_build_with_docker_engine(run, tmp_path):
    log = tmp_path / "docker.log"
    fake_docker(tmp_path / "bin", log=log)
    variables = {"PATH": str(tmp_path / "bin"), "CV_TOOLS_IMAGE": "cv-tools:test"}
    (tmp_path / "work").mkdir()
    r = run("build", V2_EXAMPLE, "-o", "out/cv.pdf", cwd=tmp_path / "work", extra_env=variables)
    assert r.returncode == 0, r.stderr
    assert r.stderr.splitlines() == ["cv-tools: pdflatex was not found", "compiling with Docker (cv-tools:test)",
                                     "wrote out/cv.pdf"]
    assert (tmp_path / "work" / "out" / "cv.pdf").read_bytes() == FAKE_PDF
    args = run_args(log)
    # The compile directory lives next to the output (Colima and Podman share only $HOME) and is removed.
    source = next(csv.reader([args[args.index("--mount") + 1]]))[1]
    assert source.startswith(f"source={(tmp_path / 'work' / 'out').resolve() / '.cv-tools-'}")
    assert [p.name for p in (tmp_path / "work" / "out").iterdir()] == ["cv.pdf"]
    # The image only runs pdflatex: neither the YAML nor the .bib file is mounted.
    assert args.count("--mount") == 1 and "-v" not in args
    assert "SOURCE_DATE_EPOCH" in args


@posix_only
def test_docker_engine_messages(run, tmp_path):
    """An explicit --engine docker says nothing before Docker is confirmed, and names the first download."""
    fake_docker(tmp_path / "up", has_image=False)
    variables = {"PATH": str(tmp_path / "up"), "CV_TOOLS_IMAGE": "img:1"}
    r = run("build", V2_EXAMPLE, "--engine", "docker", cwd=tmp_path, extra_env=variables)
    assert r.returncode == 0, r.stderr
    assert r.stderr.splitlines() == [
        "cv-tools: the first Docker build downloads img:1 (a few hundred MB), which can take a few minutes",
        "compiling with Docker (img:1)",
        "wrote cv.pdf",
    ]
    fake_docker(tmp_path / "down", running=False)
    r = run("build", V2_EXAMPLE, "--engine", "docker", cwd=tmp_path, extra_env={"PATH": str(tmp_path / "down")})
    assert r.returncode == 1
    assert r.stderr.startswith("error: Docker is installed but not running (Cannot connect to the Docker daemon")
    assert "compiling" not in r.stderr


# -- output names


@pytest.mark.parametrize("output, flags, expected", [
    (None, [], "cv.tex"),
    ("J.Doe-CV", [], "J.Doe-CV.tex"),
    ("cv-2026.11", [], "cv-2026.11.tex"),
    ("final.pdf", [], "final.tex"),
    ("final.TEX", [], "final.TEX"),
    ("outdir", [], os.path.join("outdir", "cv.tex")),
    ("newdir/", [], os.path.join("newdir", "cv.tex")),
    ("J.Doe-CV", ["--zip"], "J.Doe-CV.zip"),
    ("outdir", ["--zip"], os.path.join("outdir", "cv.zip")),
])
def test_output_names(run, tmp_path, output, flags, expected):
    (tmp_path / "outdir").mkdir()
    mode = flags or ["--tex-only"]
    r = run("build", V2_EXAMPLE, *mode, *(["-o", output] if output else []), cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    assert r.stderr.splitlines()[0] == f"wrote {expected}"
    assert (tmp_path / expected).is_file()


@pytest.mark.parametrize("output, kind, expected", [
    ("J.Doe-CV", ".pdf", "J.Doe-CV.pdf"),
    ("cv-2026.11", ".pdf", "cv-2026.11.pdf"),
    ("x.pdf", ".pdf", "x.pdf"),
    ("x.tex", ".pdf", "x.tex"),
])
def test_output_path(output, kind, expected):
    assert cli.output_path(output, Path("cv.yaml"), kind) == Path(expected)


def test_zip_output_needs_the_zip_flag(run, tmp_path):
    for flags in ([], ["--tex-only"]):
        r = run("build", V2_EXAMPLE, *flags, "-o", "cv.zip", cwd=tmp_path)
        assert (r.returncode, r.stderr) == (
            1, "cv.zip: error: a .zip output needs --zip, which writes the LaTeX sources for Overleaf\n",
        )
    assert list(tmp_path.iterdir()) == []


# -- write errors


def test_output_under_a_file_is_a_clean_error(run, tmp_path):
    (tmp_path / "taken").write_text("a file, not a directory")
    r = run("build", V2_EXAMPLE, "--tex-only", "-o", "taken/cv.tex", cwd=tmp_path)
    assert r.returncode == 1
    assert len(r.stderr.splitlines()) == 1
    assert r.stderr.startswith("taken")
    assert ": error: " in r.stderr and "Traceback" not in r.stderr


@pytest.mark.skipif(sys.platform == "win32" or getattr(os, "geteuid", lambda: 1)() == 0,
                    reason="needs POSIX permissions and a non-root user")
def test_unwritable_output_is_a_clean_error(run, tmp_path):
    (tmp_path / "ro").mkdir()
    (tmp_path / "ro").chmod(stat.S_IRUSR | stat.S_IXUSR)
    try:
        r = run("build", V2_EXAMPLE, "--zip", "-o", "ro/cv.zip", cwd=tmp_path)
    finally:
        (tmp_path / "ro").chmod(stat.S_IRWXU)
    assert (r.returncode, r.stderr) == (1, f"{Path('ro/cv.zip')}: error: Permission denied\n")


@pytest.mark.skipif(sys.platform == "win32" or getattr(os, "geteuid", lambda: 1)() == 0,
                    reason="needs POSIX permissions and a non-root user")
def test_watch_keeps_running_after_a_write_error(tmp_path, monkeypatch, capsys):
    (tmp_path / "ro").mkdir()
    (tmp_path / "ro").chmod(stat.S_IRUSR | stat.S_IXUSR)
    monkeypatch.chdir(tmp_path)
    rounds = []

    def fake_run(build, interval):
        rounds.append(build())
        (tmp_path / "ro").chmod(stat.S_IRWXU)  # the user fixes the permissions
        rounds.append(build())

    monkeypatch.setattr(cli.watch, "run", fake_run)
    try:
        assert main(["watch", str(V2_EXAMPLE), "--tex-only", "-o", "ro/cv.tex"]) == 0
    finally:
        (tmp_path / "ro").chmod(stat.S_IRWXU)
    err = capsys.readouterr().err.splitlines()
    assert err[0] == f"{Path('ro/cv.tex')}: error: Permission denied"
    assert err[1] == f"wrote {Path('ro/cv.tex')}"
    assert len(rounds) == 2 and V2_EXAMPLE.resolve() in rounds[0]


# -- watch --interval


@pytest.mark.parametrize("value", ["0", "0.01", "-1", "61", "1e12", "nan", "inf", "soon"])
def test_watch_interval_is_validated(run, tmp_path, value):
    r = run("watch", V2_EXAMPLE, "--interval", value, cwd=tmp_path)
    assert r.returncode == 2
    assert "argument --interval: " in r.stderr.splitlines()[-1]
    assert "Traceback" not in r.stderr


def test_watch_interval_accepts_the_range():
    assert [cli.interval(v) for v in ("0.05", "0.5", "60")] == [0.05, 0.5, 60.0]


# -- init


def test_init_writes_starter_files(run, tmp_path):
    r = run("init", cwd=tmp_path)
    assert r.returncode == 0, r.stderr
    assert r.stderr.splitlines() == [
        "wrote cv.yaml", "wrote publications.bib", "next: edit cv.yaml, then run 'cv-tools build cv.yaml'",
    ]
    assert run("validate", "cv.yaml", cwd=tmp_path).returncode == 0
    assert run("build", "cv.yaml", "--tex-only", cwd=tmp_path).returncode == 0
    r = run("init", "new/dir", cwd=tmp_path)
    assert r.returncode == 0
    assert sorted(p.name for p in (tmp_path / "new" / "dir").iterdir()) == ["cv.yaml", "publications.bib"]


@pytest.mark.parametrize("existing", ["cv.yaml", "publications.bib"])
def test_init_refuses_to_overwrite(run, tmp_path, existing):
    (tmp_path / existing).write_text("mine")
    r = run("init", cwd=tmp_path)
    assert r.returncode == 1
    assert r.stderr == f"{existing}: error: already exists; 'cv-tools init' never overwrites files\n"
    assert (tmp_path / existing).read_text(encoding="utf-8") == "mine"
    assert sorted(p.name for p in tmp_path.iterdir()) == [existing]  # nothing else was written


def test_starter_matches_the_example():
    import yaml

    from cv_tools import cli
    from importlib import resources

    starter = resources.files("cv_tools") / "starter"
    assert set(cli.STARTER_FILES) == {"cv.yaml", "publications.bib"}
    assert yaml.safe_load(starter.joinpath("cv.yaml").read_text(encoding="utf-8")) == yaml.safe_load(V2_EXAMPLE.read_text(encoding="utf-8"))
    assert starter.joinpath("publications.bib").read_bytes() == (V2_EXAMPLE.parent / "publications.bib").read_bytes()


# -- schema


def test_schema(run, tmp_path):
    import json

    r = run("schema", cwd=tmp_path)
    assert r.returncode == 0
    path = r.stdout.strip()
    assert path.endswith("cv-v2.schema.json")
    r = run("schema", "--print", cwd=tmp_path)
    assert r.returncode == 0
    assert r.stdout == open(path, encoding="utf-8").read()
    assert json.loads(r.stdout)["$schema"] == "https://json-schema.org/draft/2020-12/schema"


# -- doctor


def _doctor(run, tmp_path, *, tex=None, docker=None):
    """Run doctor with only fake executables on PATH."""
    from fakes import fake_docker, fake_tex

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    if tex is not None:
        fake_tex(bin_dir, **tex)
    if docker is not None:
        fake_docker(bin_dir, running=docker)
    return run("doctor", cwd=tmp_path, extra_env={"PATH": str(bin_dir)}), bin_dir


def test_doctor_tlmgr_prints_the_install_command(run, tmp_path):
    # Nothing is checked, so it works with an empty PATH.
    r = run("doctor", "--tlmgr", cwd=tmp_path, extra_env={"PATH": str(tmp_path)})
    assert r.returncode == 0, r.stderr
    packages = (ROOT / "src" / "cv_tools" / "templates" / "latex" / "packages.txt").read_text(encoding="utf-8").split("\n")
    names = [line for line in packages if line and not line.startswith("#")]
    assert r.stdout == "tlmgr install latex-bin " + " ".join(names) + "\n"


def _rows(stdout):
    return {line[:10].strip(): line[10:] for line in stdout.split("\n\n")[0].splitlines()}


@posix_only
def test_doctor_ready_with_local_tex(run, tmp_path):
    r, bin_dir = _doctor(run, tmp_path, tex={}, docker=False)
    assert r.returncode == 0, r.stdout
    rows = _rows(r.stdout)
    assert rows["cv-tools"] == __version__
    assert rows["python"].startswith(f"{sys.version_info.major}.{sys.version_info.minor}.")
    assert rows["pdflatex"] == f"{bin_dir / 'pdflatex'} (TeX Live 2026)"
    assert rows["packages"] == f"all {len(__import__('cv_tools.doctor').doctor.required_packages())} found"
    assert rows["docker"].startswith(f"{bin_dir / 'docker'} (Cannot connect to the Docker daemon")
    assert r.stdout.endswith("\n\nready: 'cv-tools build' uses the local pdflatex\n")


@posix_only
def test_doctor_notes_other_texlive_years(run, tmp_path):
    r, _ = _doctor(run, tmp_path, tex={"version_line": "pdfTeX 3.14-2.6-1.40.27 (TeX Live 2025)"})
    assert r.returncode == 0
    assert r.stdout.splitlines()[-1] == (
        "note: cv-tools is tested with TeX Live 2026; with TeX Live 2025 the PDF can differ slightly"
    )


@posix_only
def test_doctor_falls_back_to_docker(run, tmp_path):
    r, bin_dir = _doctor(run, tmp_path, tex={"missing": ["fontawesome.sty"]}, docker=True)
    assert r.returncode == 0, r.stdout
    rows = _rows(r.stdout)
    total = len(__import__("cv_tools.doctor").doctor.required_packages())
    assert rows["packages"] == f"1 of {total} missing: fontawesome"
    assert rows["docker"] == f"{bin_dir / 'docker'} (server 27.3.1)"
    assert r.stdout.splitlines()[-1].startswith("ready: 'cv-tools build' uses Docker (ghcr.io/mlsdpk/cv-tools:")


def test_doctor_fails_without_any_engine(run, tmp_path):
    r, _ = _doctor(run, tmp_path)
    assert r.returncode == 1
    rows = _rows(r.stdout)
    assert (rows["pdflatex"], rows["docker"]) == ("not found", "not found")
    assert "packages" not in rows
    tail = r.stdout.split("\n\n", 1)[1].splitlines()
    assert tail[0] == "not ready: cannot build the PDF. pdflatex was not found, and Docker is not installed."
    assert len(tail) == 5


@posix_only
def test_doctor_fails_on_missing_packages(run, tmp_path):
    r, _ = _doctor(run, tmp_path, tex={"missing": ["fontawesome.sty", "datetime.sty"]}, docker=False)
    assert r.returncode == 1
    assert "  - install the missing packages with 'tlmgr install datetime fontawesome' (TeX Live)" in r.stdout


@posix_only
def test_doctor_without_kpsewhich(run, tmp_path):
    r, _ = _doctor(run, tmp_path, tex={"kpsewhich": False})
    assert r.returncode == 0
    assert _rows(r.stdout)["packages"] == "not checked (kpsewhich not found)"


@pytest.mark.tex
def test_doctor_on_this_machine(run, tmp_path):
    r = run("doctor", cwd=tmp_path)
    assert r.returncode == 0, r.stdout
    assert _rows(r.stdout)["packages"].startswith("all ")
