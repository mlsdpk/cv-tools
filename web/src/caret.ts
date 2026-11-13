// Where a click in formatted text lands in its markup source (the parser is cv_tools/markup.py).

const ESCAPABLE = "*[]()'\\";
/** Characters the page prints as another glyph: quotes and dashes are TeX ligatures. */
const GLYPHS: Record<string, string> = { '"': "”", "~": "∼", "^": "ˆ", "'": "’‘“”", "`": "‘“" };
const LIGATURES: [string, string][] = [["---", "—"], ["--", "–"], ["``", "“"], ["''", "”"]];
const SPACE = /[ \t ]/;

const same = (raw: string, shown: string | undefined) => !!shown && (raw === shown || !!GLYPHS[raw]?.includes(shown));

/** The index of the bracket that closes the one at `i` on its line, or -1. */
function closing(s: string, i: number, open: string, close: string, end: number): number {
  let depth = 0;
  for (let k = i; k < end; k++) {
    const c = s[k];
    if (c === "\n") return -1;
    if (c === "\\" && ESCAPABLE.includes(s[k + 1] ?? "")) k++;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return k;
  }
  return -1;
}

/** `[text](url)` at `i`: where its text ends and where the link ends. */
function linkAt(s: string, i: number, end: number): { close: number; end: number } | null {
  const close = closing(s, i, "[", "]", end);
  if (close < 0 || s[close + 1] !== "(") return null;
  const stop = closing(s, close + 1, "(", ")", end);
  return stop < 0 ? null : { close, end: stop + 1 };
}

/**
 * The offset in the markup `raw` for offset `at` in the text it shows; `date` is what `{date}` shows.
 * Markup (`**`, `*`, a link's `](url)`, escapes) has no width, and a click inside a link stays in its text.
 */
export function rawOffset(raw: string, shown: string, at: number, date = ""): number {
  const map: number[] = new Array(shown.length + 1).fill(-1);
  let j = 0;
  const put = (k: number, i: number) => {
    if (map[k] < 0) map[k] = i;
  };
  const walk = (start: number, end: number) => {
    let i = start;
    while (i < end && j <= shown.length) {
      const c = raw[i];
      if (c === "\\" && ESCAPABLE.includes(raw[i + 1] ?? "") && same(raw[i + 1], shown[j])) {
        put(j++, i);
        i += 2;
        continue;
      }
      const link = c === "[" ? linkAt(raw, i, end) : null;
      if (link) {
        walk(i + 1, link.close);
        put(j, link.close);
        i = link.end;
        continue;
      }
      if (date && raw.startsWith("{date}", i) && shown.startsWith(date, j)) {
        for (const _ of date) put(j++, i);
        i += 6;
        continue;
      }
      if (SPACE.test(c)) {
        while (i < end && SPACE.test(raw[i])) put(j, i++);
        while (j < shown.length && SPACE.test(shown[j])) put(j++, i - 1);
        continue;
      }
      const lig = LIGATURES.find(([r, s]) => raw.startsWith(r, i) && shown[j] === s);
      if (lig) {
        put(j++, i);
        i += lig[0].length;
        continue;
      }
      if (same(c, shown[j])) put(j++, i);
      i++;
    }
  };
  walk(0, raw.length);
  // Text the markup does not explain (such as a contact link's address): keep the plain offset.
  if (j < shown.length) return Math.min(at, raw.length);
  put(shown.length, raw.length);
  return map[Math.max(0, Math.min(at, shown.length))];
}
