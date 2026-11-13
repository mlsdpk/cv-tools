import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import {
  addSection,
  deleteAt,
  formatPath,
  fromDataPath,
  getValue,
  insertItem,
  looksLikeV1,
  moveItem,
  newEntry,
  newSection,
  parse,
  pathAt,
  rangeOf,
  referencedBibs,
  setScalar,
  toDataPath,
  YamlEditError,
} from "../../src/yamlDoc";

const EXAMPLE = readFileSync(new URL("../../../examples/cv.yaml", import.meta.url), "utf8");
const V1 = readFileSync(new URL("../../../examples/v1/cv.yaml", import.meta.url), "utf8");

const CV = `# top comment
version: 2
name: John Doe  # the name

contact:
  - - url: https://example.org
    - orcid: 0000-0000-0000-0000
  - - johndoe@email.com

sections:
  - title: Education   # edu
    layout: entries-inline
    entries:
      # the first school
      - title: Fictional University
        date: 2021 - 2024
        note: '**Magna Cum Laude**'
        details:
          - "Thesis: *Quantum*"

      - title: Second School
        date: 2018 - 2021

  # experience follows
  - title: Experience
    layout: entries
    entries:
      - title: Tech Inc.
        date: 2024 - Present
        bullets:
          - Built things.   # trailing
          - Led a team.

  - newpage

  - title: Awards
    layout: list
    entries: [Dean's List, Best Paper]

  - title: Publications
    layout: publications
    bib: publications.bib
`;

const js = (text: string) => parseDocument(text).toJS();
/** Lines that differ between two texts (by position), for "only this changed" checks. */
const changedLines = (a: string, b: string) => {
  const la = a.split("\n");
  const lb = b.split("\n");
  const out: string[] = [];
  for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) out.push(`${i + 1}: ${la[i]} -> ${lb[i]}`);
  return out;
};

describe("path formats", () => {
  it("formats like cv-tools messages", () => {
    expect(formatPath(["sections", 0, "entries", 1, "date"])).toBe("sections[0].entries[1].date");
    expect(formatPath([])).toBe("");
    expect(formatPath(["contact", 0, 1, "url"])).toBe("contact[0][1].url");
  });
  it("round-trips data-path", () => {
    const p = ["sections", 2, "entries", 0, "date"];
    expect(toDataPath(p)).toBe("sections.2.entries.0.date");
    expect(fromDataPath("sections.2.entries.0.date")).toEqual(p);
    expect(fromDataPath("contact.0.1.url")).toEqual(["contact", 0, 1, "url"]);
    expect(fromDataPath("")).toEqual([]);
    expect(fromDataPath("a.01")).toEqual(["a", "01"]);
  });
});

describe("pathAt and rangeOf", () => {
  const doc = parse(CV);
  const at = (needle: string, delta = 0) => pathAt(doc, CV, CV.indexOf(needle) + delta);

  it("finds scalars inside entries", () => {
    expect(at("2021 - 2024")).toEqual(["sections", 0, "entries", 0, "date"]);
    expect(at("Second School")).toEqual(["sections", 0, "entries", 1, "title"]);
    expect(at("Led a team")).toEqual(["sections", 1, "entries", 0, "bullets", 1]);
    expect(at("Thesis")).toEqual(["sections", 0, "entries", 0, "details", 0]);
  });
  it("names the value when the cursor is on a key", () => {
    expect(at("date: 2021")).toEqual(["sections", 0, "entries", 0, "date"]);
    expect(at("name:")).toEqual(["name"]);
    expect(at("entries:\n      #")).toEqual(["sections", 0, "entries"]);
  });
  it("handles nested contact lines and flow lists", () => {
    expect(at("https://example.org")).toEqual(["contact", 0, 0, "url"]);
    expect(at("0000-0000")).toEqual(["contact", 0, 1, "orcid"]);
    expect(at("johndoe@")).toEqual(["contact", 1, 0]);
    expect(at("Best Paper")).toEqual(["sections", 3, "entries", 1]);
    expect(at("newpage")).toEqual(["sections", 2]);
  });
  it("counts the dash and the trailing comment as part of the item", () => {
    expect(at("- title: Tech")).toEqual(["sections", 1, "entries", 0]);
    expect(at("# trailing")).toEqual(["sections", 1, "entries", 0, "bullets", 0]);
    expect(at("# the name")).toEqual(["name"]);
  });
  it("returns the root outside any node", () => {
    expect(pathAt(doc, CV, 0)).toEqual([]);
    expect(pathAt(parse(""), "", 0)).toEqual([]);
  });
  it("maps paths to source ranges and back", () => {
    for (const path of [
      ["name"],
      ["sections", 0, "entries", 0, "date"],
      ["sections", 1, "entries", 0, "bullets", 1],
      ["contact", 0, 1, "orcid"],
      ["sections", 3, "entries", 0],
    ]) {
      const r = rangeOf(doc, path)!;
      expect(r).not.toBeNull();
      expect(pathAt(doc, CV, r.valueFrom)).toEqual(path);
    }
    const r = rangeOf(doc, ["sections", 0, "entries", 0, "date"])!;
    expect(CV.slice(r.valueFrom, r.valueTo)).toBe("2021 - 2024");
    expect(CV.slice(r.from, r.to)).toBe("date: 2021 - 2024");
  });
  it("falls back to the closest existing ancestor", () => {
    const r = rangeOf(doc, ["sections", 0, "entries", 0, "subtitle"])!;
    expect(CV.slice(r.valueFrom, r.valueFrom + 6)).toBe("title:");
    expect(rangeOf(doc, ["nothing"])).toBeNull();
  });
});

describe("setScalar", () => {
  it("changes only the edited value and keeps comments and quotes", () => {
    const out = setScalar(CV, ["sections", 0, "entries", 0, "date"], "2020 - 2024");
    expect(changedLines(CV, out)).toEqual(["16:         date: 2021 - 2024 ->         date: 2020 - 2024"]);
    const q = setScalar(CV, ["sections", 0, "entries", 0, "note"], "**Summa Cum Laude**");
    expect(changedLines(CV, q)).toEqual(["17:         note: '**Magna Cum Laude**' ->         note: '**Summa Cum Laude**'"]);
  });
  it("keeps a trailing comment", () => {
    const out = setScalar(CV, ["name"], "Jane Roe");
    expect(out).toContain("name: Jane Roe  # the name\n");
    const b = setScalar(CV, ["sections", 1, "entries", 0, "bullets", 0], "Built more things.");
    expect(b).toContain("- Built more things.   # trailing\n");
    expect(changedLines(CV, b)).toHaveLength(1);
  });
  it("quotes text that would read back as another type or break the syntax", () => {
    for (const v of ["true", "2024", "null", "~", "", "a: b", "# not a comment", "- x", "[x]", "x #y", "'q'", "@at", "1e3", "0x1F"]) {
      const out = setScalar(CV, ["sections", 0, "entries", 0, "date"], v);
      expect(js(out).sections[0].entries[0].date, v).toBe(v);
      expect(changedLines(CV, out), v).toHaveLength(1);
    }
  });
  it("writes multi-line text as a block scalar", () => {
    const out = setScalar(CV, ["sections", 0, "entries", 0, "date"], "line one\nline two");
    expect(js(out).sections[0].entries[0].date).toBe("line one\nline two");
    expect(out).toContain("date: |-\n          line one\n          line two\n        note:");
  });
  it("edits inside flow lists and nested contact lines", () => {
    const f = setScalar(CV, ["sections", 3, "entries", 1], "Best Paper, 2023");
    expect(js(f).sections[3].entries[1]).toBe("Best Paper, 2023");
    expect(f).toContain("entries: [Dean's List, \"Best Paper, 2023\"]");
    const c = setScalar(CV, ["contact", 0, 0, "url"], "https://example.com/x");
    expect(changedLines(CV, c)).toEqual(["6:   - - url: https://example.org ->   - - url: https://example.com/x"]);
  });
  it("keeps numbers numbers when the new text is a number", () => {
    const text = "version: 2\nname: X\nsections:\n  - title: T\n    layout: dated\n    entries:\n      - date: 2023\n        text: hi\n";
    const out = setScalar(text, ["sections", 0, "entries", 0, "date"], "2024");
    expect(js(out).sections[0].entries[0].date).toBe(2024);
    const s = setScalar(text, ["sections", 0, "entries", 0, "date"], "May 2024");
    expect(js(s).sections[0].entries[0].date).toBe("May 2024");
  });
  it("adds a missing key at the end of its mapping", () => {
    const out = setScalar(CV, ["sections", 0, "entries", 1, "subtitle"], "BSc");
    expect(js(out).sections[0].entries[1].subtitle).toBe("BSc");
    expect(out).toContain("        date: 2018 - 2021\n        subtitle: BSc\n\n  # experience follows");
    expect(changedLines(CV, out).length).toBeGreaterThan(0);
  });
  it("edits raw LaTeX inside {latex: ...}", () => {
    const text = "version: 2\nname: {latex: '\\textsc{X}'}\n";
    const out = setScalar(text, ["name", "latex"], "\\textsc{Y}");
    expect(js(out).name).toEqual({ latex: "\\textsc{Y}" });
  });
  it("keeps a file without a final newline that way", () => {
    const out = setScalar("version: 2\nname: A", ["name"], "B");
    expect(out).toBe("version: 2\nname: B");
  });
  it("handles non-ASCII and astral characters", () => {
    const out = setScalar(CV, ["name"], "Zoë 😀 Ω");
    expect(js(out).name).toBe("Zoë 😀 Ω");
  });
  it("refuses to edit broken YAML", () => {
    expect(() => setScalar("a: [\n", ["a"], "x")).toThrow(YamlEditError);
  });
  it("edits every scalar of the example without touching other lines", () => {
    const doc = parse(EXAMPLE);
    const paths: (string | number)[][] = [];
    const walk = (node: unknown, path: (string | number)[]) => {
      const v = node as { items?: unknown[]; value?: unknown };
      if (node && typeof node === "object" && "items" in v) {
        (v.items as { key?: { value: string }; value?: unknown }[]).forEach((it, i) => {
          if (it && typeof it === "object" && "key" in it) walk(it.value, [...path, String(it.key!.value)]);
          else walk(it, [...path, i]);
        });
      } else if (path.length && path[path.length - 1] !== "version" && path[path.length - 1] !== "layout") paths.push(path);
    };
    walk(doc.contents, []);
    expect(paths.length).toBeGreaterThan(40);
    for (const path of paths) {
      const out = setScalar(EXAMPLE, path, "Edited *text* here");
      const want = js(EXAMPLE);
      let cur = want;
      for (const p of path.slice(0, -1)) cur = cur[p];
      cur[path[path.length - 1]] = "Edited *text* here";
      expect(js(out), formatPath(path)).toEqual(want);
      expect(changedLines(EXAMPLE, out).length, formatPath(path)).toBe(1);
    }
  });
});

describe("list items", () => {
  it("moves an entry with its comments, keeping blank lines in place", () => {
    const out = moveItem(CV, ["sections", 0, "entries"], 0, 1);
    expect(js(out).sections[0].entries.map((e: { title: string }) => e.title)).toEqual(["Second School", "Fictional University"]);
    expect(out).toContain("    entries:\n      - title: Second School\n        date: 2018 - 2021\n\n      # the first school\n      - title: Fictional University");
  });
  it("moves sections and leaves everything else as written", () => {
    const out = moveItem(CV, ["sections"], 3, 0);
    expect(js(out).sections.map((s: { title?: string } | string) => (typeof s === "string" ? s : s.title))).toEqual([
      "Awards", "Education", "Experience", "newpage", "Publications",
    ]);
    expect(out).toContain("# top comment\nversion: 2\nname: John Doe  # the name\n");
    expect(out).toContain("  # experience follows\n  - title: Experience");
    expect(out.split("\n").length).toBe(CV.split("\n").length);
    // Moving back restores the text exactly.
    expect(moveItem(out, ["sections"], 0, 3)).toBe(CV);
  });
  it("is a no-op for the same position and rejects bad indices", () => {
    expect(moveItem(CV, ["sections"], 1, 1)).toBe(CV);
    expect(() => moveItem(CV, ["sections"], 0, 9)).toThrow(YamlEditError);
    expect(() => moveItem(CV, ["name"], 0, 1)).toThrow(YamlEditError);
  });
  it("inserts an entry below another one", () => {
    const out = insertItem(CV, ["sections", 1, "entries"], newEntry("entries"), 1);
    expect(js(out).sections[1].entries[1]).toEqual({ title: "" });
    expect(out).toContain("          - Led a team.\n      - title: \"\"\n\n  - newpage");
  });
  it("inserts at the start and at the end", () => {
    const first = insertItem(CV, ["sections", 0, "entries"], { title: "Zero" }, 0);
    expect(js(first).sections[0].entries[0]).toEqual({ title: "Zero" });
    expect(first).toContain("    entries:\n      - title: Zero\n\n      # the first school\n");
    const last = insertItem(CV, ["sections", 1, "entries", 0, "bullets"], "Third.");
    expect(js(last).sections[1].entries[0].bullets).toEqual(["Built things.", "Led a team.", "Third."]);
    expect(last).toContain("          - Led a team.\n          - Third.\n");
  });
  it("inserts into flow lists through the fallback", () => {
    const out = insertItem(CV, ["sections", 3, "entries"], "Another", 1);
    expect(js(out).sections[3].entries).toEqual(["Dean's List", "Another", "Best Paper"]);
    expect(out).toContain("# experience follows");
    expect(out).toContain("# trailing");
  });
  it("deletes an entry and its comment", () => {
    const out = deleteAt(CV, ["sections", 0, "entries", 0]);
    expect(js(out).sections[0].entries).toEqual([{ title: "Second School", date: "2018 - 2021" }]);
    expect(out).not.toContain("the first school");
    expect(out).toContain("    entries:\n      - title: Second School\n");
  });
  it("deletes the last item without eating the next section", () => {
    const out = deleteAt(CV, ["sections", 4]);
    expect(js(out).sections).toHaveLength(4);
    expect(out.endsWith("    entries: [Dean's List, Best Paper]\n")).toBe(true);
  });
  it("deletes the only item, leaving an empty list", () => {
    const out = deleteAt(CV, ["sections", 1, "entries", 0]);
    expect(js(out).sections[1].entries).toEqual([]);
    expect(out).toContain("# top comment");
  });
  it("deletes a mapping key with only its lines", () => {
    const out = deleteAt(CV, ["sections", 0, "entries", 0, "note"]);
    expect(changedLines(CV, out)[0]).toContain("note:");
    expect(out.split("\n").length).toBe(CV.split("\n").length - 1);
    const d = deleteAt(CV, ["sections", 0, "entries", 0, "details"]);
    expect(js(d).sections[0].entries[0].details).toBeUndefined();
    expect(d.split("\n").length).toBe(CV.split("\n").length - 2);
    expect(() => deleteAt(CV, ["nope"])).toThrow(YamlEditError);
  });
  it("works on nested contact lines through the fallback", () => {
    const out = moveItem(CV, ["contact", 0], 0, 1);
    expect(js(out).contact[0]).toEqual([{ orcid: "0000-0000-0000-0000" }, { url: "https://example.org" }]);
    expect(out).toContain("# experience follows");
  });
});

describe("sections", () => {
  it("adds a section of each layout at the end", () => {
    for (const layout of ["entries", "entries-inline", "list", "pairs", "dated", "text", "publications"] as const) {
      const out = addSection(CV, newSection(layout, "Added"));
      const s = js(out).sections;
      expect(s[s.length - 1].layout).toBe(layout);
      expect(s[s.length - 1].title).toBe("Added");
      expect(out.startsWith(CV)).toBe(true);
      expect(out.slice(CV.length)).toMatch(/^\n  - title: Added\n    layout: /);
    }
  });
  it("creates the sections list when missing", () => {
    const out = addSection("version: 2\nname: X\n", newSection("text", "About"));
    expect(js(out)).toEqual({ version: 2, name: "X", sections: [{ title: "About", layout: "text", entries: [""] }] });
  });
  it("lists the referenced .bib files", () => {
    expect(referencedBibs(CV)).toEqual(["publications.bib"]);
    expect(referencedBibs(EXAMPLE)).toEqual(["publications.bib"]);
    expect(referencedBibs("a: [")).toEqual([]);
  });
});

describe("misc", () => {
  it("reads values", () => {
    expect(getValue(CV, ["sections", 0, "entries", 0, "note"])).toBe("**Magna Cum Laude**");
    expect(getValue(CV, ["sections", 3, "entries"])).toEqual(["Dean's List", "Best Paper"]);
    expect(getValue(CV, ["missing"])).toBeUndefined();
  });
  it("detects v1 files", () => {
    expect(looksLikeV1(V1)).toBe(true);
    expect(looksLikeV1(EXAMPLE)).toBe(false);
    expect(looksLikeV1("version: 1\n")).toBe(true);
    expect(looksLikeV1("- a\n")).toBe(false);
  });
});
