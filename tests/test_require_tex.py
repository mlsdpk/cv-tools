"""CV_TOOLS_REQUIRE_TEX=1 turns a missing pdflatex into a failure instead of a skip."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from helpers import ROOT

TEST = "tests/test_golden.py::test_golden_pdf[contact]"


def run_without_tex(require):
    env = dict(os.environ, PATH=str(Path(sys.executable).parent))  # the venv only: no pdflatex
    env.pop("CV_TOOLS_REQUIRE_TEX", None)
    if require:
        env["CV_TOOLS_REQUIRE_TEX"] = "1"
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-rfs", TEST],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=120,
    )


@pytest.mark.parametrize("require", [False, True])
def test_missing_tex(require):
    proc = run_without_tex(require)
    if require:
        assert proc.returncode == 1, proc.stdout
        assert "pdflatex is not installed, and CV_TOOLS_REQUIRE_TEX=1 requires it" in proc.stdout
    else:
        assert proc.returncode == 0, proc.stdout
        assert "1 skipped" in proc.stdout and "pdflatex is not installed" in proc.stdout
