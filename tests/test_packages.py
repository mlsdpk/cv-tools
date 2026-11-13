"""packages.txt (from tools/derive_packages.py) lists every package resume.cls loads."""

import re

from cv_tools.render.latex import TEMPLATE_DIR


def listed():
    lines = (TEMPLATE_DIR / "packages.txt").read_text().splitlines()
    return {line for line in lines if line and not line.startswith("#")}


def test_class_packages_are_listed():
    cls = (TEMPLATE_DIR / "resume.cls").read_text()
    used = set(re.findall(r"\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}", cls))
    # TeX Live ships these inside larger packages.
    tl_names = {"graphicx": "graphics", "array": "tools", "calc": "tools", "ifthen": "latex"}
    assert {tl_names.get(p, p) for p in used} <= listed()


def test_tikz_is_not_needed():
    assert not {"pgf", "tikz", "scalerel", "academicons"} & listed()
