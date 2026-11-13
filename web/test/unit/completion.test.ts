import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { keysAt, schemaCompletion, valuesAt } from "../../src/completion";

const schema = JSON.parse(readFileSync(new URL("../../../src/cv_tools/schema/cv-v2.schema.json", import.meta.url), "utf8"));
const EXAMPLE = readFileSync(new URL("../../../examples/cv.yaml", import.meta.url), "utf8");

function complete(text: string, explicit = true) {
  const pos = text.indexOf("|");
  const doc = text.replace("|", "");
  const state = EditorState.create({ doc });
  const result = schemaCompletion(() => schema)(new CompletionContext(state, pos, explicit));
  return result ? result.options.map((o) => o.label) : null;
}

describe("schema completion", () => {
  it("lists top-level keys", () => {
    expect(keysAt(schema, {}, []).map((k) => k.key)).toEqual(expect.arrayContaining(["version", "name", "date", "contact", "sections"]));
  });
  it("lists the keys of a section's layout", () => {
    const data = { sections: [{ title: "T", layout: "entries", entries: [{}] }] };
    const entry = keysAt(schema, data, ["sections", 0, "entries", 0]).map((k) => k.key);
    expect(entry).toEqual(expect.arrayContaining(["title", "date", "subtitle", "note", "location", "details", "bullets"]));
    const section = keysAt(schema, data, ["sections", 0]).map((k) => k.key);
    expect(section).toEqual(expect.arrayContaining(["title", "layout", "entries", "description"]));
    expect(section).not.toContain("bib");
    const pubs = keysAt(schema, { sections: [{ layout: "publications" }] }, ["sections", 0]).map((k) => k.key);
    expect(pubs).toEqual(expect.arrayContaining(["bib", "highlight"]));
  });
  it("lists layout values", () => {
    expect(valuesAt(schema, { sections: [{ layout: "x" }] }, ["sections", 0, "layout"])).toContain("entries-inline");
  });
  it("completes keys in the editor, leaving out keys already present", () => {
    const text = EXAMPLE.replace("        date: August 2018 - May 2021\n", "        date: August 2018 - May 2021\n        |\n");
    const labels = complete(text)!;
    expect(labels).toContain("note");
    expect(labels).toContain("bullets");
    expect(labels).not.toContain("subtitle");
    expect(labels).not.toContain("layout");
    expect(complete(text.replace("|", "no|"), false)).toContain("note");
  });
  it("completes a new list item's keys and layout values", () => {
    const text = "version: 2\nname: X\nsections:\n  - title: T\n    layout: |\n";
    expect(complete(text)).toEqual(expect.arrayContaining(["entries", "pairs", "publications"]));
    const item = "version: 2\nname: X\nsections:\n  - |\n";
    expect(complete(item)).toEqual(expect.arrayContaining(["title", "layout"]));
  });
});
