"""Unit tests for the CV text markup."""

import pytest

from cv_tools.markup import Latex, escape, escape_url, normalize, split_date, to_latex, v1_decode
from cv_tools.render.latex import AUTO_DATE


@pytest.mark.parametrize(
    "text, latex",
    [
        ("plain text", "plain text"),
        ("**bold**", r"\textbf{bold}"),
        ("*italic*", r"\textit{italic}"),
        ("[text](https://example.com)", r"\href{https://example.com}{text}"),
        ("line one\nline two", r"line one\\line two"),
        ("two  spaces", r"two\ spaces"),
        ("four    spaces", r"four\quad spaces"),
        ("a\ttab", r"a\quad tab"),
        ("'quoted'", "``quoted''"),
        ("it's", "it's"),
        ("'not closed", "'not closed"),
        ("'a'b", "'a'b"),  # closing quote followed by a letter
        ("x'a'", "x'a'"),  # opening quote after a letter
        ("", ""),
    ],
)
def test_rules(text, latex):
    assert to_latex(text) == latex


@pytest.mark.parametrize(
    "text, latex",
    [
        ("*a **b** c*", r"\textit{a \textbf{b} c}"),
        ("**a *b* c**", r"\textbf{a \textit{b} c}"),
        ("*[a](https://x.org)*", r"\textit{\href{https://x.org}{a}}"),
        ("[**a** 'b'](https://x.org)", r"\href{https://x.org}{\textbf{a} ``b''}"),
        ("'*a*'", r"``\textit{a}''"),
        ("'a\nb'", r"``a\\b''"),
    ],
)
def test_nesting(text, latex):
    assert to_latex(text) == latex


@pytest.mark.parametrize(
    "text, latex",
    [
        ("#", r"\#"),
        ("$", r"\$"),
        ("%", r"\%"),
        ("&", r"\&"),
        ("_", r"\_"),
        ("{", r"\{"),
        ("}", r"\}"),
        ("~", r"\ensuremath{\sim}"),  # \textasciitilde prints a raised accent in OT1
        ("^", r"\textasciicircum{}"),
        ("\\", r"\textbackslash{}"),
        ("<", r"\textless{}"),
        (">", r"\textgreater{}"),
        ("|", r"\textbar{}"),
        ("30% of $5", r"30\% of \$5"),
        ("**50%**", r"\textbf{50\%}"),
    ],
)
def test_escaping(text, latex):
    assert to_latex(text) == latex
    assert escape(text) == latex or "*" in text


def test_unmatched_markers_are_literal():
    assert to_latex("a * b") == "a * b"
    assert to_latex("x **open") == "x **open"
    assert to_latex("x [a] (b)") == "x [a] (b)"
    assert to_latex("x *a\nb*") == r"x *a\\b*"  # emphasis does not span lines, as in v1


@pytest.mark.parametrize(
    "text, latex",
    [
        ("[draft] paper", "{[}draft] paper"),
        ("* star", "{*} star"),
        ("**open", "{*}*open"),
        (" [x]", " {[}x]"),
        ("a\n[b]", r"a\\{[}b]"),
        ("a [b]", "a [b]"),
        ("  [x]", r"\ [x]"),  # a control space ends the lookahead of \\ and \item
    ],
)
def test_line_start_guard(text, latex):
    # \\ and \item read a following [ as an optional argument and * as a star.
    assert to_latex(text) == latex


def test_urls_are_escaped_not_converted():
    assert to_latex("[t](https://x.org/a_b*c*)") == r"\href{https://x.org/a_b*c*}{t}"
    assert escape_url("https://x.org/a%20b#frag") == r"https://x.org/a\%20b\#frag"
    assert escape_url("https://x.org/~u/a_b&c") == "https://x.org/~u/a_b&c"
    assert escape_url("a b\\{c}") == r"a\%20b\%5C\%7Bc\%7D"


def test_raw_latex_is_verbatim():
    assert to_latex(Latex(r"30\% {x} **y** {date}")) == r"30\% {x} **y** {date}"
    assert to_latex(Latex("{date}"), date="X") == "{date}"


def test_numbers():
    assert to_latex(2024) == "2024"
    assert to_latex(1.5) == "1.5"
    with pytest.raises(TypeError):
        to_latex(True)
    with pytest.raises(TypeError):
        to_latex(None)


def test_date_placeholder():
    # {} follows every insertion, so letters after {date} never extend a control word.
    assert to_latex("Curriculum Vitae, {date}", date=r"\today") == r"Curriculum Vitae, \today{}"
    assert to_latex("{date} and {date}", date="D") == "D{} and D{}"
    assert to_latex("{date}th", date=r"\today") == r"\today{}th"
    assert to_latex("{date}th", date="Spring") == "Spring{}th"
    assert to_latex("{x}", date="D") == r"\{x\}"
    assert to_latex("Curriculum Vitae, {date}") == r"Curriculum Vitae, \{date\}"


@pytest.mark.parametrize(
    "text, latex",
    [
        # Markup may span the placeholder.
        ("*Updated {date}*", r"\textit{Updated \customdate\today{}}"),
        ("**{date}**", r"\textbf{\customdate\today{}}"),
        ("[{date}](https://x.org)", r"\href{https://x.org}{\customdate\today{}}"),
        # {} ends the macro name, so letters can follow.
        ("{date}th", r"\customdate\today{}th"),
        # In a URL the placeholder is not replaced.
        ("[a](https://x.org/{date})", r"\href{https://x.org/\%7Bdate\%7D}{a}"),
        ("\\{date}", r"\textbackslash{}\customdate\today{}"),
    ],
)
def test_date_placeholder_with_markup(text, latex):
    assert to_latex(text, date=AUTO_DATE) == latex


@pytest.mark.parametrize(
    "text, latex",
    [
        ("5\\*", "5*"),
        ("4\\* and \\*star\\*", "4* and *star*"),
        ("\\*\\*not bold\\*\\*", "{*}*not bold**"),  # still guarded at the start of a line
        ("\\[draft\\]", "{[}draft]"),
        ("a \\[x\\](y)", "a [x](y)"),
        ("\\[a](https://x.org)", "{[}a](https://x.org)"),
        ("\\(a\\)", "(a)"),
        ("\\'not quoted\\'", "'not quoted'"),
        ("a\\\\b", r"a\textbackslash{}b"),
        ("\\\\*i*", r"\textbackslash{}\textit{i}"),  # an escaped backslash does not escape the star
        ("*a\\*b*", r"\textit{a*b}"),
        ("**a\\**b**", r"\textbf{a**b}"),
        ("[a\\]b](https://x.org)", r"\href{https://x.org}{a]b}"),
        ("[a](https://x.org/\\))", r"\href{https://x.org/)}{a}"),
        # Any other backslash prints itself.
        ("\\q \\% \\n", r"\textbackslash{}q \textbackslash{}\% \textbackslash{}n"),
        ("trailing\\", r"trailing\textbackslash{}"),
    ],
)
def test_backslash_escapes(text, latex):
    assert to_latex(text) == latex


@pytest.mark.parametrize(
    "text, latex",
    [
        ("***x***", r"\textbf{\textit{x}}"),
        ("**a *b***", r"\textbf{a \textit{b}}"),
        ("***a** b*", r"\textit{\textbf{a} b}"),
        ("***a* b**", r"\textbf{\textit{a} b}"),
        ("**bold *and italic***", r"\textbf{bold \textit{and italic}}"),
        ("**x***", r"\textbf{x}*"),
        ("***", "{*}**"),
        # Escaped stars and stars inside links do not count when "***" closes both runs.
        ("**a \\* *b***", r"\textbf{a * \textit{b}}"),
        ("**[*](https://x.org) *b***", r"\textbf{\href{https://x.org}{*} \textit{b}}"),
        ("**[\\*](https://x.org) *b***", r"\textbf{\href{https://x.org}{*} \textit{b}}"),
        ("**[x](https://x.org/a*b) *c***", r"\textbf{\href{https://x.org/a*b}{x} \textit{c}}"),
        # Links are read before emphasis, so a star in a link never closes emphasis.
        ("*see [docs](https://x.org/a*b) here*", r"\textit{see \href{https://x.org/a*b}{docs} here}"),
        ("**see [d](https://x.org/a**b) here**", r"\textbf{see \href{https://x.org/a**b}{d} here}"),
        ("***a [d](https://x.org/a***b) x***", r"\textbf{\textit{a \href{https://x.org/a***b}{d} x}}"),
        ("*a [b* c](https://x.org)*", r"\textit{a \href{https://x.org}{b* c}}"),
        ("*a [b*](https://x.org)", r"{*}a \href{https://x.org}{b*}"),
    ],
)
def test_bold_italic(text, latex):
    assert to_latex(text) == latex


@pytest.mark.parametrize(
    "text, latex",
    [
        ("a~b", r"a\ensuremath{\sim}b"),
        ("a^b", r"a\textasciicircum{}b"),
        # ^^41 in a macro argument would be read as the character A.
        ("^^41", r"\textasciicircum{}\textasciicircum{}41"),
        ("[x](https://x.org/^^41)", r"\href{https://x.org/\%5E\%5E41}{x}"),
        ("[x](https://x.org/~u)", r"\href{https://x.org/~u}{x}"),
    ],
)
def test_tilde_and_caret(text, latex):
    assert to_latex(text) == latex


@pytest.mark.parametrize(
    "text, latex",
    [
        ("?'q'", "?{}``q''"),  # ?` is the ligature for an inverted question mark
        ("!'q'", "!{}``q''"),
        ("?`", "?{}`"),
        ("!`", "!{}`"),
        ("? 'q'", "? ``q''"),
        ("`q'", "`q'"),
    ],
)
def test_spanish_ligatures_are_broken(text, latex):
    assert to_latex(text) == latex


@pytest.mark.parametrize(
    "text, normalized",
    [
        ("a\r\nb", "a\nb"),
        ("a\rb", "a\nb"),
        ("a\fb\vc", "a\nb\nc"),
        ("a\x85b\u2028c\u2029d", "a\nb\nc\nd"),
        ("a\x00b\x01c\x1bd\x7fe\x9ff", "abcdef"),
        ("tab\tand\nnewline", "tab\tand\nnewline"),
        ("café — ł", "café — ł"),
    ],
)
def test_control_characters(text, normalized):
    assert normalize(text) == normalized
    assert to_latex(text) == to_latex(normalized)


@pytest.mark.parametrize(
    "text, latex",
    [
        ("[x](https://en.wikipedia.org/wiki/Foo_(bar))", r"\href{https://en.wikipedia.org/wiki/Foo_(bar)}{x}"),
        ("[x](https://x.org/a_(b)) and (c)", r"\href{https://x.org/a_(b)}{x} and (c)"),
        ("[x](https://x.org/a(b)", "{[}x](https://x.org/a(b)"),
        ("[[1]](https://x.org/1)", r"\href{https://x.org/1}{[1]}"),
        ("[x](https://x.org/é—)", r"\href{https://x.org/\%C3\%A9\%E2\%80\%94}{x}"),
        ("[a\nb](https://x.org)", r"{[}a\\b](https://x.org)"),  # a link stays on one line
    ],
)
def test_links(text, latex):
    assert to_latex(text) == latex


def test_escape_url_keeps_one_fragment():
    # \\href ends the link target at a second #, so later ones are percent-encoded.
    assert escape_url("https://x.org/#a#b") == r"https://x.org/\#a\%23b"
    assert escape_url("https://x.org/a#b") == r"https://x.org/a\#b"
    assert to_latex("[x](https://x.org/#a#b#c)") == r"\href{https://x.org/\#a\%23b\%23c}{x}"


def test_escape_url_percent_encodes_non_ascii():
    assert escape_url("https://x.org/é?q=ü") == r"https://x.org/\%C3\%A9?q=\%C3\%BC"
    assert escape_url("https://x.org/a^b") == r"https://x.org/a\%5Eb"


@pytest.mark.parametrize(
    "value, columns",
    [
        ("Nov. 2023", ("Nov.", "2023")),
        ("Early Nov. 2023", ("Early Nov.", "2023")),
        ("2023", ("", "2023")),
        (2023, ("", "2023")),
        ("Nov. ", ("Nov.", "")),
        (None, ("", "")),
        ("*Nov.* 50%", (r"\textit{Nov.}", r"50\%")),
        (Latex("Nov. 2023"), ("Nov.", "2023")),
        (Latex("Mar. {2019 (online)}"), ("Mar.", "{2019 (online)}")),
        (Latex(r"a\ b"), ("", r"a\ b")),
        (Latex(" 2021"), ("", "2021")),
    ],
)
def test_split_date(value, columns):
    assert split_date(value) == columns


def test_v1_decode_is_v1():
    # v1 converts everything, escapes nothing, and also rewrites inside URLs.
    assert v1_decode(r"30\% **b** *i*") == r"30\% \textbf{b} \textit{i}"
    assert v1_decode("[a](http://x/*y*)") == r"\href{http://x/\textit{y}}{a}"
    assert v1_decode("five     spaces") == r"five\quad\ spaces"
    assert v1_decode("'a' x\ny") == r"``a'' x\\y"


@pytest.mark.parametrize(
    "text",
    [
        "plain", "**b** *i* [l](https://x.org) 'q'", "two  four    tab\t", "a\nb",
        "five     spaces", "Thesis Title: *An Exploration of ['QC'](https://en.wikipedia.org/wiki/QC)*",
    ],
)
def test_v2_matches_v1_on_ordinary_text(text):
    # Migration keeps text clean exactly when this holds.
    assert to_latex(text) == v1_decode(text)
