"""The CV text markup (bold, italic, links, quotes) to LaTeX and to HTML."""

from __future__ import annotations

import functools
import itertools
import re
from dataclasses import dataclass
from typing import Optional, Union


@dataclass(frozen=True)
class Latex:
    """Raw LaTeX, written in YAML as ``{latex: "..."}``."""

    latex: str


Text = Union[str, int, float, Latex]

_SPECIAL = {
    "\\": r"\textbackslash{}",
    "{": r"\{",
    "}": r"\}",
    "#": r"\#",
    "$": r"\$",
    "%": r"\%",
    "&": r"\&",
    "_": r"\_",
    # \textasciitilde is a raised accent in OT1.
    "~": r"\ensuremath{\sim}",
    "^": r"\textasciicircum{}",
    # OT1 prints these three as other glyphs.
    "<": r"\textless{}",
    ">": r"\textgreater{}",
    "|": r"\textbar{}",
}

ESCAPABLE = frozenset("*[]()'\\")

# Characters that \\ and \item would read as an optional argument or a star.
_LINE_START_GUARD = {"[": "{[}", "*": "{*}"}

# ?` and !` are TeX ligatures (¿ and ¡).
_LIGATURE_FIRST = ("?", "!")

_WORD = re.compile(r"\w")

LINE_ENDS = re.compile("\r\n|[\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]")
_CONTROL = re.compile("[\x00-\x08\x0e-\x1b\x1f\x7f-\x84\x86-\x9f]")

# Control characters are removed first, so this cannot occur in the text.
_DATE = "\x00"
DATE_PLACEHOLDER = "{date}"

_URL_ESCAPES = {
    "%": r"\%",
    "#": r"\#",
    "\\": r"\%5C",
    "{": r"\%7B",
    "}": r"\%7D",
    "^": r"\%5E",  # ^^ would start a TeX character code in a macro argument
    " ": r"\%20",
    "\t": r"\%09",
    "\n": r"\%0A",
    "\r": r"\%0D",
}


# A line break inside a table cell, where \\ would end the row.
CELL_NEWLINE = r"\newline{}"

# Deeper markup prints as text, which keeps the recursion within Pyodide's stack.
MAX_NESTING = 32


def to_latex(value: Text, date: Optional[str] = None, newline: str = "\\\\") -> str:
    """Convert a text value to LaTeX, replacing ``{date}`` with ``date``."""
    if isinstance(value, Latex):
        return value.latex
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise TypeError(f"not a text value: {value!r}")
    text = normalize(str(value))
    if date is not None:
        text = text.replace(DATE_PLACEHOLDER, _DATE)
    return _Converter(date, newline).convert(text, top=True)


def normalize(text: str) -> str:
    """Line ends become ``\\n``; other control characters are removed."""
    return _CONTROL.sub("", LINE_ENDS.sub("\n", text))


def split_date(value: Text | None, newline: str = "\\\\") -> tuple[str, str]:
    """A ``dated`` layout date as two LaTeX columns, split at its last space."""
    if value is None:
        return ("", "")
    if isinstance(value, Latex):
        cut = _last_split_space(value.latex)
        if cut == -1:
            return ("", value.latex)
        return (value.latex[:cut], value.latex[cut + 1 :])
    head, space, tail = normalize(str(value)).rpartition(" ")
    if not space:
        return ("", to_latex(value, newline=newline))
    return (to_latex(head, newline=newline), to_latex(tail, newline=newline))


def _last_split_space(latex: str) -> int:
    depth, last, i = 0, -1, 0
    while i < len(latex):
        c = latex[i]
        if c == "\\":
            i += 2
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif c == " " and depth == 0:
            last = i
        i += 1
    return last


def escape(text: str) -> str:
    """Escape LaTeX special characters without applying any markup."""
    return "".join(_SPECIAL.get(c, c) for c in normalize(text))


def escape_url(url: str) -> str:
    """Escape a URL for ``\\href`` or ``\\url``."""
    # \href ends the target at a second #, so later ones become %23 (as RFC 3986 asks).
    out = []
    fragment = False
    for c in url.replace(_DATE, DATE_PLACEHOLDER):
        if c == "#" and fragment:
            out.append(r"\%23")
        elif c in _URL_ESCAPES:
            fragment = fragment or c == "#"
            out.append(_URL_ESCAPES[c])
        elif ord(c) > 0x7E or ord(c) < 0x20:
            out.append("".join(f"\\%{b:02X}" for b in c.encode("utf-8")))
        else:
            out.append(c)
    return "".join(out)


def unescape_markup(text: str) -> str:
    """Resolve the markup escapes (``\\*`` and the like)."""
    return re.sub(r"\\([*\[\]()'\\])", r"\1", text)


def _is_word(c: str) -> bool:
    return bool(_WORD.match(c))


def _spaces(run: str) -> str:
    # v1's order: four spaces, tabs, then two spaces.
    run = run.replace("    ", "\\quad ")
    run = run.replace("\t", "\\quad ")
    return re.sub(" {2}", r"\\ ", run)


def _escaped(s: str) -> list[bool]:
    marks = [False] * len(s)
    i = 0
    while i < len(s) - 1:
        if s[i] == "\\" and s[i + 1] in ESCAPABLE:
            marks[i + 1] = True
            i += 2
        else:
            i += 1
    return marks


class _Converter:
    """The markup parser, producing LaTeX; :class:`_HtmlConverter` overrides the output methods."""

    def __init__(self, date: Optional[str], newline: str = "\\\\"):
        self.date = date
        self.newline = newline
        self.depth = 0

    def convert(self, s: str, top: bool) -> str:
        self.depth += 1
        try:
            return self._convert(s, top, markup=self.depth <= MAX_NESTING)
        finally:
            self.depth -= 1

    def _convert(self, s: str, top: bool, markup: bool) -> str:
        esc = _escaped(s)
        out: list[str] = []
        emit = functools.partial(self.emit, out)

        i, n = 0, len(s)
        line_start = top
        while i < n:
            c = s[i]
            at_line_start, line_start = line_start, False
            if c == "\\" and i + 1 < n and esc[i + 1]:
                emit(self.escaped(s[i + 1], at_line_start))
                i += 2
                continue
            if c == "*" and markup and not esc[i]:
                done = self._emphasis(s, esc, i)
                if done is not None:
                    piece, i = done
                    emit(piece)
                    continue
            if c == "[" and markup and not esc[i]:
                link = _link(s, esc, i)
                if link is not None:
                    text, url, end = link
                    emit(self.link(url, self.convert(text, False)))
                    i = end
                    continue
            if c == "'" and markup and not esc[i]:
                j = _close_quote(s, esc, i)
                if j != -1:
                    emit(self.quote(self.convert(s[i + 1 : j], False)))
                    i = j + 1
                    continue
            if c == _DATE:
                emit(self.date_piece())
                i += 1
                continue
            if c == "\n":
                emit(self.line_break(out, top))
                line_start = True
                i += 1
                continue
            if c in " \t":
                j = i
                while j < n and s[j] in " \t":
                    j += 1
                run, plain = self.space_run(s[i:j])
                emit(run)
                # TeX skips plain spaces before an optional argument or a star.
                line_start = at_line_start and plain
                i = j
                continue
            emit(self.char(c, at_line_start))
            i += 1
        return "".join(out)

    def _emphasis(self, s: str, esc: list[bool], i: int) -> Optional[tuple[str, int]]:
        run = _run(s, i)
        if run >= 3:
            j = _find(s, esc, "***", i + 3)
            if j > i + 3:
                return self.bold_italic(self.convert(s[i + 3 : j], False)), j + 3
            j = _close_italic(s, esc, i)
            if j > i + 1:
                return self.italic(self.convert(s[i + 1 : j], False)), j + 1
        if run >= 2:
            j = _close_bold(s, esc, i)
            if j != -1:
                # In "**a *b***" the last two stars close the bold run.
                extra = _run(s, j) - 2
                if extra > 0 and _stars(s, esc, i + 2, j) % 2 == 1:
                    j += 1
                return self.bold(self.convert(s[i + 2 : j], False)), j + 2
        j = _close_italic(s, esc, i)
        if j > i + 1:
            return self.italic(self.convert(s[i + 1 : j], False)), j + 1
        return None

    def emit(self, out: list[str], piece: str) -> None:
        if piece.startswith("`") and out and out[-1].endswith(_LIGATURE_FIRST):
            out.append("{}")
        out.append(piece)

    def escaped(self, literal: str, at_line_start: bool) -> str:
        if at_line_start and literal in _LINE_START_GUARD:
            return _LINE_START_GUARD[literal]
        return _SPECIAL.get(literal, literal)

    def char(self, c: str, at_line_start: bool) -> str:
        if at_line_start and c in _LINE_START_GUARD:
            return _LINE_START_GUARD[c]
        return _SPECIAL.get(c, c)

    def bold(self, inner: str) -> str:
        return r"\textbf{" + inner + "}"

    def italic(self, inner: str) -> str:
        return r"\textit{" + inner + "}"

    def bold_italic(self, inner: str) -> str:
        return r"\textbf{\textit{" + inner + "}}"

    def link(self, url: str, inner: str) -> str:
        return r"\href{" + escape_url(unescape_markup(url)) + "}{" + inner + "}"

    def quote(self, inner: str) -> str:
        return "``" + inner + "''"

    def date_piece(self) -> str:
        # {} lets letters follow ({date}th).
        return (self.date or "") + "{}"

    def line_break(self, out: list[str], top: bool) -> str:
        # \\ before any text would end a line that does not exist yet.
        return self.newline if "".join(out).strip() or not top else "\\leavevmode" + self.newline

    def space_run(self, run: str) -> tuple[str, bool]:
        latex = _spaces(run)
        return latex, latex.strip(" ") == ""


def _run(s: str, i: int) -> int:
    j = i
    while j < len(s) and s[j] == "*":
        j += 1
    return j - i


def _positions(s: str, esc: list[bool], start: int):
    """Indices up to the end of the line that can carry markup (not escaped, not inside a link)."""
    k = start
    while k < len(s) and s[k] != "\n":
        if esc[k]:
            k += 1
            continue
        if s[k] == "[":
            link = _link(s, esc, k)
            if link is not None:
                k = link[2]
                continue
        yield k
        k += 1


def _find(s: str, esc: list[bool], token: str, start: int) -> int:
    for k in _positions(s, esc, start):
        if s.startswith(token, k):
            return k
    return -1


def _stars(s: str, esc: list[bool], start: int, end: int) -> int:
    count = 0
    for k in _positions(s, esc, start):
        if k >= end:
            break
        count += s[k] == "*"
    return count


def _close_bold(s: str, esc: list[bool], i: int) -> int:
    return _find(s, esc, "**", i + 2)


def _close_italic(s: str, esc: list[bool], i: int) -> int:
    # Bold runs inside are skipped, because v1 converted bold first.
    skip_to = i + 1
    for k in _positions(s, esc, i + 1):
        if k < skip_to:
            continue
        if s.startswith("**", k):
            j = _close_bold(s, esc, k)
            if j != -1:
                skip_to = j + 2
                continue
        if s[k] == "*":
            return k
    return -1


def _close_quote(s: str, esc: list[bool], i: int) -> int:
    if i > 0 and _is_word(s[i - 1]):
        return -1
    j = s.find("'", i + 1)
    while j != -1 and esc[j]:
        j = s.find("'", j + 1)
    if j <= i + 1 or (j + 1 < len(s) and _is_word(s[j + 1])):
        return -1
    return j


def _link(s: str, esc: list[bool], i: int) -> Optional[tuple[str, str, int]]:
    """``(text, url, end)`` of a ``[text](url)`` link at ``i``; balanced brackets may nest."""
    close = _balanced(s, esc, i, "[", "]")
    if close == -1 or close + 1 >= len(s) or s[close + 1] != "(" or esc[close + 1]:
        return None
    end = _balanced(s, esc, close + 1, "(", ")")
    if end == -1:
        return None
    return s[i + 1 : close], s[close + 2 : end], end + 1


def _balanced(s: str, esc: list[bool], i: int, open_: str, close: str) -> int:
    depth = 0
    for k in range(i, len(s)):
        c = s[k]
        if c == "\n":
            return -1
        if esc[k]:
            continue
        if c == open_:
            depth += 1
        elif c == close:
            depth -= 1
            if depth == 0:
                return k
    return -1


def v1_decode(text: str) -> str:
    """The v1 ``decode_special_characters``, byte for byte (nothing is escaped)."""
    text = re.sub(r"\*\*(.*?)\*\*", r"\\textbf{\1}", text)
    text = re.sub(r"\*(.*?)\*", r"\\textit{\1}", text)
    text = re.sub(r"\[(.*?)\]\((.*?)\)", r"\\href{\2}{\1}", text)
    text = text.replace("\n", "\\\\")
    text = re.sub(r" {4}", r"\\quad ", text)
    text = re.sub(r"\t", r"\\quad ", text)
    text = re.sub(r" {2}", r"\\ ", text)
    text = re.sub(r"(?<!\w)'([^']+)'(?!\w)", r"``\1''", text)
    return text


# HTML, for the live preview, from the same parser as the LaTeX.

SAFE_SCHEMES = ("http", "https", "mailto")
_SCHEME = re.compile(r"([a-zA-Z][a-zA-Z0-9+.-]*):")
# What browsers drop from a URL before they read the scheme.
_URL_DROPPED = re.compile("[\t\n\r]")
_C0_AND_SPACE = "".join(chr(c) for c in range(0x21))
_URL_ENCODED = re.compile("[\x00-\x20\x7f-\x9f\"'<>\\\\`{}|^]")

# Characters that pdflatex prints as other glyphs in OT1.
_HTML_CHAR = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "”",
    "~": "∼",
    "^": "ˆ",
}
_TEX_LIGATURES = re.compile("---|--|``|''|`|'")
_LIGATURE_GLYPH = {"---": "—", "--": "–", "``": "“", "''": "”", "`": "‘", "'": "’"}
_TAG_OR_TEXT = re.compile(r'(<code class="cv-latex">[^<]*</code>|<[^>]*>)')


def escape_html(text: str, quote: bool = True) -> str:
    """Escape text for an HTML text node or a double-quoted attribute value."""
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    if quote:
        text = text.replace('"', "&quot;").replace("'", "&#39;")
    return text


def safe_url(url: str) -> Optional[str]:
    """``url`` as an ``href`` (still to be escaped) when its scheme is http, https or mailto, else None."""
    # The scheme is checked after the cleanup, so the browser sees the scheme that was checked.
    url = _URL_DROPPED.sub("", url).strip(_C0_AND_SPACE)
    url = _URL_ENCODED.sub(lambda m: "".join(f"%{b:02X}" for b in m.group().encode("utf-8")), url)
    m = _SCHEME.match(url)
    if m is None or m.group(1).lower() not in SAFE_SCHEMES:
        return None
    return url


def tex_ligatures_text(text: str) -> str:
    """Apply the TeX ligatures (quotes and dashes) to plain text."""
    return _TEX_LIGATURES.sub(lambda m: _LIGATURE_GLYPH[m.group()], text)


def tex_ligatures(html: str) -> str:
    """Apply the TeX ligatures to the text between tags (never across a tag, as in TeX)."""
    parts = _TAG_OR_TEXT.split(html)
    for i in range(0, len(parts), 2):
        if parts[i]:
            parts[i] = tex_ligatures_text(parts[i])
    return "".join(parts)


def latex_html(latex: str) -> str:
    """Raw ``{latex: ...}`` text as a visible placeholder."""
    return '<code class="cv-latex">' + escape_html(latex, quote=False) + "</code>"


class _HtmlConverter(_Converter):
    def emit(self, out: list[str], piece: str) -> None:
        out.append(piece)

    def escaped(self, literal: str, at_line_start: bool) -> str:
        return self.char(literal, at_line_start)

    def char(self, c: str, at_line_start: bool) -> str:
        return _HTML_CHAR.get(c, c)

    def bold(self, inner: str) -> str:
        return "<strong>" + inner + "</strong>"

    def italic(self, inner: str) -> str:
        return "<em>" + inner + "</em>"

    def bold_italic(self, inner: str) -> str:
        return "<strong><em>" + inner + "</em></strong>"

    def link(self, url: str, inner: str) -> str:
        href = safe_url(unescape_markup(url).replace(_DATE, DATE_PLACEHOLDER))
        if href is None:
            return '<span class="cv-link">' + inner + "</span>"
        return _split_link('<a class="cv-link" href="' + escape_html(href) + '">', inner)

    def quote(self, inner: str) -> str:
        # TeX quotes, so tex_ligatures combines them with neighbouring quotes as TeX does.
        return "``" + inner + "''"

    def date_piece(self) -> str:
        return self.date or ""

    def line_break(self, out: list[str], top: bool) -> str:
        return "<br>"

    def space_run(self, run: str) -> tuple[str, bool]:
        latex, plain = super().space_run(run)
        if plain:
            return " ", True
        units = re.findall(r"\\quad *|\\ | +", latex)
        html = "".join('<span class="cv-quad"></span>' if u.startswith("\\quad") else " " for u in units)
        return '<span class="cv-space">' + html + "</span>", False


_TAG = re.compile(r"(<[^>]*>)")
_VOID = frozenset({"br"})


def _split_link(open_a: str, inner: str) -> str:
    """``open_a + inner + "</a>"``, split around the links inside ``inner``.

    HTML cannot nest links, so the outer link wraps each run between inner
    ones, as the PDF's inner link areas lie on top of the outer one.
    """
    if "<a " not in inner:
        return open_a + inner + "</a>"
    tokens = [t for t in _TAG.split(inner) if t]
    # Each piece of content with the (serial number, opening tag) of the elements around it.
    leaves: list[tuple[tuple[tuple[int, str], ...], str]] = []
    chain: list[tuple[int, str]] = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token.startswith("</"):
            chain.pop()
        elif token.startswith("<") and _tag_name(token) not in _VOID:
            close = f"</{_tag_name(token)}>"
            if i + 1 < len(tokens) and tokens[i + 1] == close:
                leaves.append((tuple(chain), token + close))
                i += 2
                continue
            chain.append((i, token))
        else:
            leaves.append((tuple(chain), token))
        i += 1

    def inner_link(leaf: tuple) -> Optional[int]:
        return next((n for n, tag in leaf[0] if tag.startswith("<a ")), None)

    out = []
    for link, group in itertools.groupby(leaves, key=inner_link):
        body = _nest(list(group))
        out.append(body if link is not None else open_a + body + "</a>")
    return "".join(out)


def _nest(leaves: list[tuple[tuple[tuple[int, str], ...], str]]) -> str:
    out: list[str] = []
    current: tuple[tuple[int, str], ...] = ()
    for chain, html in leaves:
        k = 0
        while k < min(len(current), len(chain)) and current[k] == chain[k]:
            k += 1
        out.extend(f"</{_tag_name(tag)}>" for _, tag in reversed(current[k:]))
        out.extend(tag for _, tag in chain[k:])
        out.append(html)
        current = chain
    out.extend(f"</{_tag_name(tag)}>" for _, tag in reversed(current))
    return "".join(out)


def _tag_name(tag: str) -> str:
    return re.match(r"</?([a-z0-9]+)", tag).group(1)  # type: ignore[union-attr]


def to_html(value: Text, date: Optional[str] = None) -> str:
    """Convert a text value to HTML, replacing ``{date}`` with ``date``."""
    if isinstance(value, Latex):
        return latex_html(value.latex)
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise TypeError(f"not a text value: {value!r}")
    text = normalize(str(value))
    if date is not None:
        text = text.replace(DATE_PLACEHOLDER, _DATE)
    return tex_ligatures(_HtmlConverter(date).convert(text, top=True))


def split_date_html(value: Text | None) -> tuple[str, str]:
    """:func:`split_date` in HTML."""
    if value is None:
        return ("", "")
    if isinstance(value, Latex):
        cut = _last_split_space(value.latex)
        if cut == -1:
            return ("", latex_html(value.latex))
        return (latex_html(value.latex[:cut]), latex_html(value.latex[cut + 1 :]))
    head, space, tail = normalize(str(value)).rpartition(" ")
    if not space:
        return ("", to_html(value))
    return (to_html(head), to_html(tail))
