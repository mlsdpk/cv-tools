"""Rebuild when the CV file or one of its .bib files changes (polling, which works everywhere)."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Callable, Iterable, Optional, TextIO

from .model import Document

Signature = Optional[tuple[int, int]]  # (mtime in ns, size), or None for a missing file


def watched_files(doc: Document, config: Path) -> set[Path]:
    """The CV file and every .bib file it references."""
    return {Path(config).resolve()} | {s.bib for s in doc.sections if s.bib is not None}


def signature(path: Path) -> Signature:
    try:
        st = path.stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def snapshot(paths: Iterable[Path]) -> dict[Path, Signature]:
    return {p: signature(p) for p in paths}


def _display(path: Path) -> str:
    try:
        return str(path.relative_to(Path.cwd()))
    except ValueError:
        return str(path)


def run(
    build: Callable[[], Optional[Iterable[Path]]],
    interval: float = 0.5,
    *,
    stop: Callable[[], bool] = lambda: False,
    sleep: Callable[[float], None] = time.sleep,
    out: TextIO = sys.stderr,
) -> None:
    """Call ``build`` now and after every change to the files it returns (None keeps the previous set)."""
    # Wait one quiet interval, because editors often save in several steps.
    files: set[Path] = set()

    def rebuild() -> None:
        nonlocal files, state
        before = snapshot(files)
        new = build()
        if new is not None:
            files = {Path(p) for p in new}
        # Old signatures, so an edit during the build triggers another one.
        state = {p: before[p] if p in before else signature(p) for p in files}

    state: dict[Path, Signature] = {}
    rebuild()
    print(f"watching {', '.join(sorted(_display(p) for p in files))} (Ctrl-C to stop)", file=out, flush=True)
    while not stop():
        sleep(interval)
        current = snapshot(files)
        if current == state:
            continue
        while True:
            sleep(interval)
            settled = snapshot(files)
            if settled == current:
                break
            current = settled
        changed = sorted(_display(p) for p in files if current.get(p) != state.get(p))
        print(f"changed: {', '.join(changed)}; rebuilding", file=out, flush=True)
        rebuild()
