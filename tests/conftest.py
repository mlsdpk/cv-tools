import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpers import HAVE_PDFLATEX, HAVE_PDFTOPPM, REQUIRE_TEX  # noqa: E402


def pytest_addoption(parser):
    parser.addoption(
        "--update-golden",
        action="store_true",
        help="rewrite tests/golden/ from the current renderer instead of comparing",
    )


def _missing_tool():
    return None if HAVE_PDFLATEX and HAVE_PDFTOPPM else ("pdflatex" if not HAVE_PDFLATEX else "pdftoppm")


def pytest_collection_modifyitems(config, items):
    missing = _missing_tool()
    if missing is None or REQUIRE_TEX:
        return
    skip = pytest.mark.skip(reason=f"{missing} is not installed")
    for item in items:
        if "tex" in item.keywords:
            item.add_marker(skip)


def pytest_runtest_setup(item):
    # CV_TOOLS_REQUIRE_TEX=1: a test that needs TeX fails instead of being skipped.
    missing = _missing_tool()
    if missing is not None and REQUIRE_TEX and "tex" in item.keywords:
        pytest.fail(f"{missing} is not installed, and CV_TOOLS_REQUIRE_TEX=1 requires it", pytrace=False)


@pytest.fixture
def update_golden(request):
    return request.config.getoption("--update-golden")
