"""``cv-tools watch``: the polling loop with a fake clock, and the command as a subprocess."""

import io
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time

import pytest

from cv_tools import api, watch

from helpers import ROOT, env

EXAMPLES = ROOT / "examples"


class Clock:
    """A fake ``sleep`` that runs scheduled actions at given ticks and stops the loop at the end."""

    def __init__(self, actions, ticks):
        self.tick, self.actions, self.ticks = 0, actions, ticks

    def sleep(self, _interval):
        self.tick += 1
        action = self.actions.get(self.tick)
        if action:
            action()

    def stop(self):
        return self.tick >= self.ticks


def touch(path, text):
    def action():
        path.write_text(text)
        # Make the change visible even on file systems with coarse timestamps.
        stamp = time.time_ns() + 10**9 * (1 + touch.count)
        touch.count += 1
        os.utime(path, ns=(stamp, stamp))
    return action


touch.count = 0


def test_rebuilds_once_per_settled_change(tmp_path):
    cv, bib, other = tmp_path / "cv.yaml", tmp_path / "a.bib", tmp_path / "b.bib"
    for p in (cv, bib, other):
        p.write_text("0")
    builds = []

    def build():
        builds.append(sorted(p.read_text(encoding="utf-8") for p in (cv, bib)))
        return [cv, bib]

    # tick 2: bib changes; tick 3 it changes again before settling; tick 4 stable -> one rebuild.
    # tick 6: an unwatched file changes -> nothing.
    clock = Clock({2: touch(bib, "1"), 3: touch(bib, "22"), 6: touch(other, "x")}, ticks=9)
    out = io.StringIO()
    watch.run(build, 0.1, stop=clock.stop, sleep=clock.sleep, out=out)
    assert builds == [["0", "0"], ["0", "22"]]
    lines = out.getvalue().splitlines()
    assert lines[0].startswith("watching ") and lines[0].endswith(" (Ctrl-C to stop)")
    assert lines[1] == f"changed: {tmp_path / 'a.bib'}; rebuilding"
    assert len(lines) == 2


def test_new_files_are_watched_and_none_keeps_the_old_set(tmp_path):
    cv, bib = tmp_path / "cv.yaml", tmp_path / "pubs.bib"
    cv.write_text("0")
    bib.write_text("0")
    results = iter([[cv], None, [cv, bib], [cv, bib]])
    builds = []

    def build():
        builds.append(1)
        return next(results)

    clock = Clock({1: touch(cv, "1"), 4: touch(cv, "2"), 7: touch(bib, "1")}, ticks=10)
    watch.run(build, 0.1, stop=clock.stop, sleep=clock.sleep, out=io.StringIO())
    # cv edit -> build returns None (old set kept) -> cv edit -> build adds the bib -> bib edit -> rebuild
    assert len(builds) == 4


def test_a_deleted_file_counts_as_a_change(tmp_path):
    cv = tmp_path / "cv.yaml"
    cv.write_text("0")
    builds = []
    clock = Clock({2: cv.unlink}, ticks=5)
    watch.run(lambda: builds.append(1) or [cv], 0.1, stop=clock.stop, sleep=clock.sleep, out=io.StringIO())
    assert len(builds) == 2


def test_watched_files_include_bib_files():
    v2 = api.load(EXAMPLES / "cv.yaml")
    assert watch.watched_files(v2, EXAMPLES / "cv.yaml") == {
        (EXAMPLES / "cv.yaml").resolve(), (EXAMPLES / "publications.bib").resolve(),
    }
    v1 = api.load(EXAMPLES / "v1" / "cv.yaml")
    assert (EXAMPLES / "v1" / "publications.bib").resolve() in watch.watched_files(v1, EXAMPLES / "v1" / "cv.yaml")


def _reader(stream, lines):
    for line in iter(stream.readline, ""):
        lines.put(line.rstrip("\n"))


def _wait_for(lines, predicate, seen, timeout=30.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            line = lines.get(timeout=0.2)
        except queue.Empty:
            continue
        seen.append(line)
        if predicate(line):
            return line
    raise AssertionError(f"timed out; output so far: {seen}")


@pytest.mark.skipif(sys.platform == "win32", reason="uses SIGINT")
def test_watch_command_rebuilds_on_bib_change(tmp_path):
    shutil.copy(EXAMPLES / "cv.yaml", tmp_path / "cv.yaml")
    shutil.copy(EXAMPLES / "publications.bib", tmp_path / "publications.bib")
    proc = subprocess.Popen(
        [sys.executable, "-m", "cv_tools", "watch", "cv.yaml", "--tex-only", "--interval", "0.1"],
        cwd=tmp_path, env=env(), stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True,
    )
    lines, seen = queue.Queue(), []
    threading.Thread(target=_reader, args=(proc.stderr, lines), daemon=True).start()
    try:
        _wait_for(lines, lambda l: l.startswith("watching "), seen)
        assert seen[:3] == ["wrote cv.tex", "wrote resume.cls", "wrote orcid.pdf"]
        assert seen[3] == "watching cv.yaml, publications.bib (Ctrl-C to stop)"

        before = (tmp_path / "cv.tex").read_text(encoding="utf-8")
        with open(tmp_path / "publications.bib", "a") as f:
            f.write("\n@misc{watchtest, author={A. Tester}, title={Watched entry}, year={2025}}\n")
        _wait_for(lines, lambda l: l == "changed: publications.bib; rebuilding", seen)
        _wait_for(lines, lambda l: l == "wrote orcid.pdf", seen)
        assert "Watched entry" in (tmp_path / "cv.tex").read_text(encoding="utf-8") != before

        # A broken file is reported and watched; fixing it rebuilds.
        good = (tmp_path / "cv.yaml").read_text(encoding="utf-8")
        (tmp_path / "cv.yaml").write_text("version: 2\nname: [unclosed\n")
        _wait_for(lines, lambda l: "error:" in l, seen)
        (tmp_path / "cv.yaml").write_text(good)
        _wait_for(lines, lambda l: l == "wrote orcid.pdf", seen)
    finally:
        proc.send_signal(signal.SIGINT)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            raise
    assert proc.returncode == 0
    _wait_for(lines, lambda l: l == "stopped", seen, timeout=5)
