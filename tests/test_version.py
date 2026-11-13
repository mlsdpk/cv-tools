"""Version detection and the v1 deprecation notice."""

import warnings

import pytest

from cv_tools import api, v1
from cv_tools.loader import CVError, load_text

from helpers import ROOT


@pytest.mark.parametrize(
    "text, fmt",
    [
        ("version: 2\nname: x\n", "v2"),
        ("heading: {name: x}\n", "v1"),
        ("subheading: []\n", "v1"),
        ("sections:\n  - type: newpage\n", "v1"),
        ("version: 2\nheading: {name: x}\n", "v2"),  # an explicit version wins
    ],
)
def test_detect(text, fmt):
    assert v1.detect(load_text(text)) == fmt


@pytest.mark.parametrize(
    "text, message",
    [
        ("version: 3\nname: x\n", "unsupported version 3: expected 'version: 2' \\(or 'version: 1' for the deprecated v1 format\\)"),
        ("version: '2'\nname: x\n", "unsupported version '2': the version is a number; write 'version: 2' without quotes"),
        ("version: true\n", "unsupported version True: expected 'version: 2'"),
        ("name: x\nsections: []\n", "cannot tell the CV format: expected 'version: 2'"),
        ("- a\n", "expected a mapping at the top level"),
        ("", "expected a mapping at the top level"),
    ],
)
def test_detect_errors(text, message):
    with pytest.raises(CVError, match=message):
        v1.detect(load_text(text))


def test_v1_prints_deprecation_and_warns(capsys):
    path = ROOT / "examples" / "v1" / "cv.yaml"
    with pytest.warns(DeprecationWarning, match="uses the v1 format"):
        doc = api.load(path)
    assert doc.source_format == "v1"
    expected = (
        f"cv-tools: {path} uses the v1 format, which is deprecated and will be removed in a future release. "
        f"Run 'cv-tools migrate {path}' to convert it.\n"
    )
    assert capsys.readouterr().err == expected


def test_v2_is_silent(capsys):
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        doc = api.load(ROOT / "examples" / "cv.yaml")
    assert doc.source_format == "v2"
    assert capsys.readouterr().err == ""
