// The py bridge in the real Pyodide the build serves (public/pyodide). Skips without `npm run assets`.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const PYODIDE = fileURLToPath(new URL("../../public/pyodide/", import.meta.url));
const ready = existsSync(PYODIDE + "pyodide-lock.json");
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

type Fn = (...args: string[]) => string;
let call: (name: string, ...args: unknown[]) => Record<string, unknown>;

describe.skipIf(!ready)("py bridge in Pyodide", () => {
  beforeAll(async () => {
    const { loadPyodide } = await import(/* @vite-ignore */ PYODIDE + "pyodide.mjs");
    const py = await loadPyodide({ indexURL: PYODIDE, stdout: () => {}, stderr: () => {} });
    await py.loadPackage(["cv-tools-cli"], { messageCallback: () => {} });
    py.runPython(read("../../src/py/bridge.py"));
    call = (name, ...args) => JSON.parse((py.globals.get(name) as Fn)(...args.map((a) => JSON.stringify(a))));
  }, 120_000);

  const yaml = read("../../../examples/cv.yaml");
  const files = { "publications.bib": read("../../../examples/publications.bib") };

  it("validates the example", () => {
    expect(call("validate", yaml, files)).toMatchObject({ ok: true, format: "v2", diagnostics: [], bibs: ["publications.bib"] });
  });

  it("reports schema errors with line and column", () => {
    const r = call("validate", yaml.replace("layout: entries-inline", "layout: entrie"), files);
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toEqual([expect.objectContaining({ file: "cv.yaml", line: 15, col: 13, severity: "error" })]);
  });

  it("reports characters pdfLaTeX cannot print", () => {
    const r = call("validate", yaml.replace("name: John Doe", "name: John 😀 Doe"), files);
    expect(r.ok).toBe(false);
    expect((r.diagnostics as { message: string; line: number }[])[0]).toMatchObject({ line: 4 });
    expect((r.diagnostics as { message: string }[])[0].message).toMatch(/U\+1F600/);
  });

  it("names a missing .bib file", () => {
    const r = call("validate", yaml, {});
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.diagnostics)).toMatch(/publications\.bib/);
  });

  it("detects v1 files and migrates them", () => {
    const v1 = read("../../../examples/v1/cv.yaml");
    expect(call("validate", v1, files)).toMatchObject({ ok: false, format: "v1" });
    const m = call("migrate", v1);
    expect(m.ok).toBe(true);
    expect(m.text).toMatch(/^version: 2$/m);
    expect(call("validate", m.text, files)).toMatchObject({ ok: true });
  });

  it("renders the LaTeX source and support files", () => {
    const r = call("render_tex", yaml, files);
    expect(r.ok).toBe(true);
    expect(r.tex).toMatch(/\\documentclass/);
    expect(Object.keys(r.files as object).sort()).toEqual(["orcid.pdf", "resume.cls"]);
  });

  it("renders the HTML preview, or says it is unavailable", () => {
    const r = call("render_html", yaml, files);
    if (r.unavailable) return;
    expect(r.ok).toBe(true);
    expect(r.html).toMatch(/data-path="sections\.0\.entries\.0\.date"/);
    expect(typeof r.css).toBe("string");
  });

  it("returns the JSON Schema", () => {
    expect((call("schema").schema as { $schema: string }).$schema).toMatch(/2020-12/);
  });

  it("ignores .bib names that leave the work directory", () => {
    expect(call("validate", yaml, { ...files, "../../etc/x.bib": "x", "/abs.bib": "y" })).toMatchObject({ ok: true });
  });
});
