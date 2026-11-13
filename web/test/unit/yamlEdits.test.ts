// Page edits never change other values or reformat the file; a property test on randomly styled CVs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Document, isAlias, isMap, isScalar, isSeq, parseDocument, Scalar, YAMLMap, YAMLSeq } from "yaml";
import { addKey, addSection, deleteAt, insertItem, LAYOUTS, moveItem, newSection, parse, parseCached, REFORMAT_MESSAGE, replaceItem, setScalar, YamlEditError } from "../../src/yamlDoc";

const js = (text: string) => parseDocument(text).toJS();

describe("numbers", () => {
  const text = "version: 2\nname: X\ndate: 2024\nsections: []\n";
  it("keeps a number only when the typed text is how YAML prints that number", () => {
    expect(js(setScalar(text, ["date"], "2025")).date).toBe(2025);
    for (const typed of ["2024.10", "1e3", "0x10", "07", "+5", "2024.0", "1_000", ".5"]) {
      const out = setScalar(text, ["date"], typed);
      expect(js(out).date, typed).toBe(typed);
    }
  });
});

describe("line-level patches instead of a reprint", () => {
  const user = `version: 2
name: Jane Doe        # aligned comment
date: 2024

contact:
  - - jane@x.org     # mail
    - url: https://jane.example
    - Curriculum Vitae, {date}

sections:
  - title: Talks
    layout: dated
    entries:
      - date: 2022
        text: &t Talk two
      - date: 2021
        text: *t
  - title: Single
    layout: list
    entries:
      - Only item
  - title: Awards
    layout: list
    entries: [Dean's List, "Best Paper"]   # flow
`;
  const keepsOtherLines = (out: string, changed: number) => {
    const a = user.split("\n");
    const b = out.split("\n");
    expect(b.filter((l) => !a.includes(l)).length).toBeLessThanOrEqual(changed);
    expect(out).toContain("name: Jane Doe        # aligned comment\n");
  };

  it("deletes the only item as `entries: []`", () => {
    const out = deleteAt(user, ["sections", 1, "entries", 0]);
    expect(js(out).sections[1].entries).toEqual([]);
    expect(out).toContain("    layout: list\n    entries: []\n  - title: Awards");
    keepsOtherLines(out, 1);
  });

  it("clears the last key of a mapping as `{}`", () => {
    const out = deleteAt(user, ["contact", 0, 1, "url"]);
    expect(js(out).contact[0][1]).toEqual({});
    keepsOtherLines(out, 1);
  });

  it("replaces an alias with the new text and keeps the anchor", () => {
    const out = setScalar(user, ["sections", 0, "entries", 1, "text"], "Talk three");
    expect(out).toContain("        text: &t Talk two\n");
    expect(out).toContain("        text: Talk three\n");
    keepsOtherLines(out, 1);
  });

  it("moves items of a `- -` contact line", () => {
    const out = moveItem(user, ["contact", 0], 0, 2);
    expect(js(out).contact[0]).toEqual([{ url: "https://jane.example" }, "Curriculum Vitae, {date}", "jane@x.org"]);
    expect(out).toContain("  - - url: https://jane.example     # mail\n    - Curriculum Vitae, {date}\n    - jane@x.org\n");
    keepsOtherLines(out, 3);
  });

  it("deletes an item of a `- -` contact line", () => {
    const out = deleteAt(user, ["contact", 0, 0]);
    expect(js(out).contact[0]).toEqual([{ url: "https://jane.example" }, "Curriculum Vitae, {date}"]);
    keepsOtherLines(out, 2);
  });

  it("inserts into, deletes from and moves within flow lists", () => {
    const ins = insertItem(user, ["sections", 2, "entries"], "Another, award", 1);
    expect(js(ins).sections[2].entries).toEqual(["Dean's List", "Another, award", "Best Paper"]);
    keepsOtherLines(ins, 1);
    const del = deleteAt(user, ["sections", 2, "entries", 0]);
    expect(del).toContain('    entries: ["Best Paper"]   # flow\n');
    const mv = moveItem(user, ["sections", 2, "entries"], 0, 1);
    expect(mv).toContain('    entries: ["Best Paper", Dean\'s List]   # flow\n');
  });

  it("writes plain text into an empty quoted value, and keeps other quotes", () => {
    expect(setScalar('a:\n  - title: ""\n', ["a", 0, "title"], "Startup")).toBe("a:\n  - title: Startup\n");
    expect(setScalar("a: ''\n", ["a"], "x: y")).toBe("a: 'x: y'\n");
    expect(setScalar('a: "b"\n', ["a"], "c")).toBe('a: "c"\n');
  });

  it("adds a first item to `[]` and to an empty key", () => {
    const empty = "version: 2\nname: X  # n\nsections: []   # none yet\n";
    const out = addSection(empty, newSection("list", "About"));
    expect(out).toBe("version: 2\nname: X  # n\nsections:   # none yet\n  - title: About\n    layout: list\n    entries:\n      - \"\"\n");
    const nul = "version: 2\nname: X  # n\nsections:\n# later\n";
    const out2 = addSection(nul, newSection("list", "About"));
    expect(js(out2).sections).toHaveLength(1);
    expect(out2).toContain("name: X  # n\n");
    expect(out2).toContain("# later");
  });

  it("refuses an edit that only a reprint of the whole file could make", () => {
    // A key inside a flow mapping can only be added by reprinting, which would lose the alignment.
    const text = "version: 2\nname: X        # aligned\nsections: [{title: A, layout: list, entries: [a]}]\n";
    expect(() => setScalar(text, ["sections", 0, "description"], "d")).toThrow(YamlEditError);
    expect(() => setScalar(text, ["sections", 0, "description"], "d")).toThrow(REFORMAT_MESSAGE);
    // The same edit on a file that reprints exactly goes through.
    const plain = "version: 2\nname: X\nsections: [{title: A, layout: list, entries: [a]}]\n";
    expect(js(setScalar(plain, ["sections", 0, "description"], "d")).sections[0].description).toBe("d");
  });
});

describe("parseCached", () => {
  it("returns the same Document for the same text and a new one for another text", () => {
    const a = parseCached("a: 1\n");
    expect(parseCached("a: 1\n")).toBe(a);
    expect(parseCached("a: 2\n")).not.toBe(a);
    expect(parse("a: 1\n")).not.toBe(a);
  });
  it("is not changed by edits", () => {
    const text = "version: 2\nname: A\nsections:\n  - title: T\n    layout: list\n    entries: [x, y]\n";
    const before = JSON.stringify(parseCached(text).toJS());
    setScalar(text, ["name"], "B");
    moveItem(text, ["sections", 0, "entries"], 0, 1);
    deleteAt(text, ["sections", 0, "entries", 0]);
    insertItem(text, ["sections", 0, "entries"], "z");
    expect(JSON.stringify(parseCached(text).toJS())).toBe(before);
  });
});

describe("a commented CV", () => {
  const text = readFileSync(new URL("./data/commented.yaml", import.meta.url), "utf8");

  it("adds an entry after an item that ends with comment lines, and after a commented-out last item", () => {
    const out = insertItem(text, ["sections", 0, "entries"], { title: "New" }, 2);
    expect(out).toContain("        subtitle: BSc\n      - title: New\n");
    const list = insertItem(text, ["sections", 0, "entries", 0, "details"], "New detail", 1);
    expect(list).toContain("          - 'Supervisor: Prof. X'\n          - New detail\n          # - 'Co-supervisor: TBD'\n");
    const first = insertItem(text, ["sections", 0, "entries"], { title: "New" }, 1);
    expect(first).toContain("          # - 'Co-supervisor: TBD'\n      - title: New\n      # - title: Old College\n");
  });

  it("clears the first key of a `- key:` item in place", () => {
    const out = deleteAt(text, ["sections", 4, "entries", 0, "date"]);
    expect(out).toContain("      - text: Talk one\n");
    expect(out.split("\n").length).toBe(text.split("\n").length - 1);
  });

  it("makes every insert, move, delete and clear without a reprint, keeping comments outside the edit", () => {
    const doc = parse(text);
    const seqs: P[] = [];
    const maps: P[] = [];
    const rec = (n: unknown, p: P) => {
      if (isSeq(n)) {
        seqs.push(p);
        n.items.forEach((x, i) => rec(x, [...p, i]));
      } else if (isMap(n)) {
        maps.push(p);
        for (const it of n.items) rec(it.value, [...p, String((it.key as Scalar).value)]);
      }
    };
    rec(doc.contents, []);
    const kept = (out: string, removed: string[]) => commentLines(text).every((c) => out.includes(c) || removed.some((r) => r.includes(c)));
    let edits = 0;
    for (const s of seqs) {
      const n = (doc.getIn(s, true) as YAMLSeq).items.length;
      for (let i = 0; i <= n; i++) {
        const out = insertItem(text, s, "New item", i);
        expect(at(js(out), s)[i]).toBe("New item");
        expect(kept(out, [])).toBe(true);
        edits++;
      }
      for (let i = 0; i < n; i++) {
        if (i + 1 < n) {
          const out = moveItem(text, s, i, i + 1);
          expect(at(js(out), s)[i + 1]).toEqual(at(js(text), s)[i]);
          expect(kept(out, [])).toBe(true);
        }
        const out = deleteAt(text, [...s, i]);
        expect(at(js(out), s)).toHaveLength(n - 1);
        expect(kept(out, [text])).toBe(true);
        edits += 2;
      }
    }
    for (const m of maps) {
      for (const k of Object.keys(at(js(text), m) ?? {})) {
        if (["date", "subtitle", "location", "details", "bullets"].includes(k)) {
          expect(at(js(deleteAt(text, [...m, k])), m)).not.toHaveProperty(k);
          edits++;
        }
      }
    }
    expect(edits).toBeGreaterThan(80);
  });
});

// ---------------------------------------------------------------- property test

// mulberry32
let seed = 1;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const chance = (p: number) => rnd() < p;
const STRINGS = ["Plain text", "**bold** and *it*", "[link](https://x.org/a_b)", "Curriculum Vitae, {date}", "esc \\* star", "é ü 中文 😀",
  "a: b", "- dash", "#hash", "it's", 'say "hi"', "two\nlines", "  lead", "trail  ", "", "true", "123", "null", "tab\there",
  "a, b, [c]", "{curly}", "50%", "back\\slash", "colon:", "@at", "`tick`", "~", "line\n\nbreak para", "end newline\n"];
const str = () => pick(STRINGS) + (chance(0.3) ? " " + Math.floor(rnd() * 100) : "");

function genEntry(layout: string): unknown {
  if (layout === "list" || layout === "text") return chance(0.7) ? str() : { text: str() };
  if (layout === "pairs") return { title: str(), text: str() };
  if (layout === "dated") return { date: str(), text: str() };
  const e: Record<string, unknown> = { title: str(), date: chance(0.2) ? 2020 + Math.floor(rnd() * 5) : str() };
  if (chance(0.5)) e.bullets = Array.from({ length: 1 + Math.floor(rnd() * 3) }, str);
  return e;
}

function genText(): string {
  const contact = Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => (chance(0.3) ? { url: "https://x.org" } : str())));
  const sections: unknown[] = [];
  for (let i = 0; i < 1 + Math.floor(rnd() * 4); i++) {
    if (chance(0.15)) sections.push("newpage");
    else {
      const layout = pick(["entries", "list", "pairs", "dated", "text"]);
      sections.push({ title: str(), layout, entries: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => genEntry(layout)) });
    }
  }
  const doc = new Document({ version: 2, name: str(), contact, sections });
  let n = 0;
  const walk = (node: unknown, inFlow: boolean) => {
    if (isMap(node) || isSeq(node)) {
      const flow = inFlow || (chance(0.08) && node.items.length > 0);
      if (flow) node.flow = true;
      for (const it of node.items as unknown[]) {
        const pair = it as { key?: Scalar; value?: unknown };
        if (isMap(node)) {
          if (!flow && chance(0.12)) pair.key!.commentBefore = ` c${n++}`;
          walk(pair.value, flow);
          if (!flow && isScalar(pair.value) && chance(0.15)) (pair.value as Scalar).comment = ` c${n++}`;
        } else {
          if (!flow && chance(0.12)) (it as Scalar).commentBefore = ` c${n++}`;
          walk(it, flow);
          if (!flow && isScalar(it) && chance(0.12)) (it as Scalar).comment = ` c${n++}`;
        }
      }
    } else if (isScalar(node) && typeof node.value === "string") {
      node.type = pick(["PLAIN", "QUOTE_SINGLE", "QUOTE_DOUBLE"]) as Scalar["type"];
    }
  };
  walk(doc.contents, false);
  let text = doc.toString({ indentSeq: chance(0.7), lineWidth: 0 });
  if (chance(0.4)) text = text.replace(/ #(?= c\d)/g, () => " ".repeat(1 + Math.floor(rnd() * 4)) + "#");
  // Commented-out items after an item, at its column or inside it.
  const lines = text.split("\n");
  for (let k = 0; k < 2 && chance(0.5); k++) {
    const items = lines.map((l, i) => [i, /^( *)- /.exec(l)?.[1]] as const).filter(([, ind]) => ind !== undefined);
    if (!items.length) break;
    const [i, ind] = pick(items);
    let j = i + 1;
    while (j < lines.length - 1 && (lines[j].match(/^ */)![0].length > ind!.length || !lines[j].trim())) j++;
    lines.splice(j, 0, `${ind}${chance(0.5) ? "" : "  "}# c${n++} - old item`);
  }
  return lines.join("\n");
}

type P = (string | number)[];
function nodes(doc: Document.Parsed) {
  const out: { path: P; kind: "scalar" | "seq" | "map" }[] = [];
  const rec = (node: unknown, p: P) => {
    if (isAlias(node)) return;
    if (isScalar(node)) out.push({ path: p, kind: "scalar" });
    else if (isSeq(node)) {
      out.push({ path: p, kind: "seq" });
      (node as YAMLSeq).items.forEach((it, i) => rec(it, [...p, i]));
    } else if (isMap(node)) {
      out.push({ path: p, kind: "map" });
      for (const it of (node as YAMLMap).items) rec(it.value, [...p, String((it.key as Scalar).value)]);
    }
  };
  rec(doc.contents, []);
  return out;
}
const at = (o: any, p: P) => p.reduce((x, k) => x?.[k], o); // eslint-disable-line @typescript-eslint/no-explicit-any
const commentsOf = (t: string) => [...t.matchAll(/# c\d+/g)].map((m) => m[0]);
const commentLines = (t: string) => [...t.matchAll(/#.*$/gm)].map((m) => m[0]);

describe("random edits of randomly styled CVs", () => {
  it("keep the data right, never reformat, and keep every comment outside a deleted item", () => {
    const stats: Record<string, number> = {};
    for (let iter = 0; iter < 1000; iter++) {
      const text = genText();
      const doc = parse(text);
      const all = nodes(doc);
      const want = js(text);
      const op = pick(["set", "set", "insert", "move", "delete", "addSection"]);
      let out: string;
      let deleted: string | null = null;
      try {
        if (op === "set") {
          const t = pick(all.filter((x) => x.kind === "scalar" && x.path.length > 1));
          const v = str();
          const cur = at(want, t.path.slice(0, -1));
          const keepNumber = typeof cur[t.path[t.path.length - 1]] === "number" && String(Number(v)) === v;
          cur[t.path[t.path.length - 1]] = keepNumber ? Number(v) : v;
          out = setScalar(text, t.path, v);
        } else if (op === "addSection") {
          const s = newSection(pick(LAYOUTS));
          want.sections.push(s);
          out = addSection(text, s);
        } else {
          const t = pick(all.filter((x) => x.kind === "seq"));
          const arr = at(want, t.path) as unknown[];
          if (op === "insert") {
            const v = genEntry("entries");
            const i = Math.floor(rnd() * (arr.length + 1));
            arr.splice(i, 0, v);
            out = insertItem(text, t.path, v, i);
          } else if (op === "move") {
            if (arr.length < 2) continue;
            const f = Math.floor(rnd() * arr.length);
            const to = Math.floor(rnd() * arr.length);
            arr.splice(to, 0, arr.splice(f, 1)[0]);
            out = moveItem(text, t.path, f, to);
          } else {
            const i = Math.floor(rnd() * arr.length);
            arr.splice(i, 1);
            const r = (doc.getIn([...t.path, i], true) as { range?: number[] } | undefined)?.range;
            // The item's lines with the comments directly above, and those below it from its content's column.
            if (r) {
              const nl = text.indexOf("\n", r[2] - 1);
              const lines = text.slice(0, nl < 0 ? text.length : nl + 1).split("\n");
              let from = text.slice(0, r[0]).split("\n").length - 2;
              while (from > 0 && /^\s*#/.test(lines[from - 1])) from--;
              const col = r[0] - text.lastIndexOf("\n", r[0] - 1) - 1;
              const rest = text.slice(lines.join("\n").length).split("\n");
              let to = 0;
              while (to < rest.length && /^ *#/.test(rest[to]) && rest[to].indexOf("#") >= col) to++;
              deleted = [...lines.slice(Math.max(0, from)), ...rest.slice(0, to)].join("\n");
            }
            out = deleteAt(text, [...t.path, i]);
          }
        }
      } catch (e) {
        // A refusal is allowed; any other error is a bug.
        expect((e as Error).message, `${op} on\n${text}`).toBe(REFORMAT_MESSAGE);
        stats.refused = (stats.refused ?? 0) + 1;
        continue;
      }
      stats[op] = (stats[op] ?? 0) + 1;
      const re = parseDocument(out);
      expect(re.errors, `${op}\n${text}\n---\n${out}`).toEqual([]);
      expect(re.toJS(), `${op}\n${text}\n---\n${out}`).toEqual(want);
      const lost = commentsOf(text).filter((c) => !out.includes(c + "\n") && !out.includes(c + " ") && !out.endsWith(c));
      for (const c of lost) expect(deleted ?? "", `${op} lost ${c}\n${text}\n---\n${out}`).toContain(c);
    }
    expect(stats.refused ?? 0).toBeLessThan(50);
    for (const op of ["set", "insert", "move", "delete", "addSection"]) expect(stats[op], op).toBeGreaterThan(100);
  });
});

describe("adding keys and replacing items", () => {
  const cv = "version: 2\nname: X\nsections:\n  - title: Work  # jobs\n    layout: entries\n    entries:\n      - title: A\n        date: 2024\n        # what I did\n        bullets:\n          - B\n";
  it("adds a key where people write it and keeps comments", () => {
    const out = addKey(cv, ["sections", 0, "entries", 0, "location"], "Paris");
    expect(out).toBe(cv.replace("      - title: A\n", "      - title: A\n        location: Paris\n"));
    const note = addKey(cv, ["sections", 0, "entries", 0, "note"], "Hi");
    expect(note).toContain("        date: 2024\n        # what I did\n        note: Hi\n        bullets:\n");
  });
  it("adds a key with a list", () => {
    const out = addKey(cv, ["sections", 0, "entries", 0, "details"], ["Line"]);
    expect(out).toContain("        details:\n          - Line\n        bullets:\n");
    expect(parse(out).toJS().sections[0].entries[0].details).toEqual(["Line"]);
  });
  it("replaces a plain list item with a mapping", () => {
    const list = "version: 2\nname: X\nsections:\n  - title: L\n    layout: list\n    entries:\n      - One  # first\n      - Two\n";
    const out = replaceItem(list, ["sections", 0, "entries", 1], { text: "Two", bullets: ["Sub"] });
    expect(parse(out).toJS().sections[0].entries).toEqual(["One", { text: "Two", bullets: ["Sub"] }]);
    expect(out).toContain("- One  # first\n");
  });
});
