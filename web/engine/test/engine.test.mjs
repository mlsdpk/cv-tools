import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { EPOCH, OUT_DIR, REPO_DIR, Stale, builtManifest, nodeEngine, sha256 } from "../lib/common.mjs";
import { EngineError, TexError, missingFiles, untar } from "../../src/tex/engine.ts";
import { tar } from "../lib/tree.mjs";
import { CV_TOOLS, FIXTURES, LINK_ERROR_WASM, bundleCopy, requireTool, resign, texSources } from "./helpers.mjs";

const ARTICLE = (body) => `\\documentclass[11pt]{article}\\begin{document}${body}\\end{document}\n`;
const timings = [];
let example;
let extrasCase;

before(() => {
  builtManifest();
  requireTool(CV_TOOLS);
  example = texSources({ name: "example", yaml: join(REPO_DIR, "examples", "cv.yaml") });
  extrasCase = texSources({ name: "engine-extras-t1-sizes", yaml: join(FIXTURES, "extras-t1-sizes", "cv.yaml") });
});

after(() => {
  console.log("\nNode engine timings (ms):");
  for (const [what, ms] of timings) console.log(`  ${what.padEnd(60)} ${ms.toFixed(0)}`);
});

const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const rejectsWith = (code, pattern) => (e) => {
  assert.ok(e instanceof EngineError, `expected an EngineError, got ${e?.name}: ${e?.message}`);
  assert.equal(e.code, code, e.message);
  if (pattern) assert.match(e.message, pattern);
  return true;
};

describe("instance lifetime and dates", () => {
  test("starts one instance lazily and reuses it", async () => {
    const engine = await nodeEngine(undefined, { sourceDateEpoch: EPOCH });
    assert.equal(engine.stats().live, false);
    assert.equal(engine.stats().instancesCreated, 0);
    const a = await engine.compile(example);
    const t0 = performance.now();
    const b = await engine.compile(example);
    timings.push(["example, warm compile", performance.now() - t0]);
    assert.ok(same(a.pdf, b.pdf), "repeated compiles give the same bytes");
    assert.equal(engine.stats().instancesCreated, 1);
  });

  test("creation and per-compile epochs agree", async () => {
    const fixed = await nodeEngine(undefined, { sourceDateEpoch: EPOCH });
    const plain = await nodeEngine();
    const a = await fixed.compile(example);
    const b = await plain.compile(example, { sourceDateEpoch: EPOCH });
    assert.ok(same(a.pdf, b.pdf));
  });

  test("a new epoch replaces the instance", async () => {
    const engine = await nodeEngine();
    const files = { "cv.tex": ARTICLE("\\the\\year") };
    const clock = await engine.compile(files);
    assert.match(clock.log, new RegExp(`Output written on cv\\.pdf`));
    const fixed = await engine.compile(files, { sourceDateEpoch: EPOCH });
    assert.ok(!same(clock.pdf, fixed.pdf), "the PDF dates differ");
    const s = engine.stats();
    assert.equal(s.instancesCreated, 2);
    assert.equal(s.live, true);
  });
});

describe("errors", () => {
  let engine;
  before(async () => {
    engine = await nodeEngine(undefined, { sourceDateEpoch: EPOCH });
  });

  test("a TeX error rejects with a TexError", async () => {
    await assert.rejects(
      engine.compile({ "cv.tex": ARTICLE("\\nosuchcommand") }),
      (e) => e instanceof TexError && /^! Undefined control sequence\./m.test(e.message) && /nosuchcommand/.test(e.message) && e.log.length > 0,
    );
    const r = await engine.compile(example);
    assert.ok(r.pdf.length > 1000, "the engine still works after a failure");
  });

  test("a missing file rejects with missing-file", async () => {
    await assert.rejects(
      engine.compile({ "cv.tex": ARTICLE("\\usepackage{tikz}x").replace("\\begin{document}\\usepackage{tikz}", "\\usepackage{tikz}\\begin{document}") }),
      rejectsWith("missing-file", /browser TeX engine lacks the file tikz\.sty.*not an error in the CV.*cv-tools build/s),
    );
    // ecssdc10 exists only as METAFONT source.
    await assert.rejects(
      engine.compile({ "cv.tex": ARTICLE("{\\fontencoding{T1}\\fontseries{sbc}\\sffamily x}") }),
      (e) => rejectsWith("missing-file", /ecssdc10\.tfm/)(e) && e.files.includes("ecssdc10.tfm"),
    );
  });

  test("missingFiles parses LaTeX, font and pdfTeX messages", () => {
    const log = [
      "! LaTeX Error: File `tikz.sty' not found.",
      "! Font T1/cmr/m/n/9=ecrm0900 at 9.0pt not loadable: Metric (TFM) file not found.",
      "!pdfTeX error: pdflatex (file sfrm0900.pfb): cannot open Type 1 font file for reading",
      "! I can't find file `foo'.",
    ].join("\n");
    assert.deepEqual(missingFiles(log).sort(), ["ecrm0900.tfm", "foo", "sfrm0900.pfb", "tikz.sty"]);
    // TeX breaks log lines after 79 characters.
    const long = "! Font T1/cmss/sbc/n/10.95=ecssdc10 at 10.95pt not loadable: Metric (TFM) file not found.";
    assert.deepEqual(missingFiles(`${long.slice(0, 79)}\n${long.slice(79)}\n`), ["ecssdc10.tfm"]);
  });
});

describe("font pack (texmf-extra)", () => {
  test("loads the pack once and retries", async () => {
    const requests = [];
    const progress = [];
    const engine = await nodeEngine(undefined, { sourceDateEpoch: EPOCH, requests });
    const t0 = performance.now();
    const r = await engine.compile(extrasCase, { onProgress: (p) => progress.push(p) });
    timings.push(["font pack: first compile (fails, loads the pack, compiles again)", performance.now() - t0]);
    assert.equal(r.extrasLoaded, true);
    assert.deepEqual(requests.filter((n) => n.startsWith("texmf-extra")), ["texmf-extra.json", "texmf-extra.tar.gz"]);
    assert.equal(progress.at(-1).stage, "extras");
    assert.equal(progress.at(-1).loaded, progress.at(-1).total);
    const t1 = performance.now();
    const again = await engine.compile(extrasCase);
    timings.push(["font pack: next compile", performance.now() - t1]);
    assert.equal(again.extrasLoaded, false);
    assert.ok(same(r.pdf, again.pdf));
    assert.equal(requests.filter((n) => n === "texmf-extra.tar.gz").length, 1);
    await engine.compile(extrasCase, { sourceDateEpoch: EPOCH + 86400 });
    assert.equal(requests.filter((n) => n === "texmf-extra.tar.gz").length, 1);
  });

  test("rejects a damaged pack", async () => {
    const dir = bundleCopy("extra-damaged", (d) => {
      const b = readFileSync(join(d, "texmf-extra.tar.gz"));
      b[b.length >> 1] ^= 0xff;
      writeFileSync(join(d, "texmf-extra.tar.gz"), b);
    });
    const engine = await nodeEngine(dir, { sourceDateEpoch: EPOCH });
    await assert.rejects(engine.compile(extrasCase), rejectsWith("integrity", /texmf-extra\.tar\.gz/));
  });
});

describe("integrity of the bundle", () => {
  const flip = (name) => (d) => {
    const b = readFileSync(join(d, name));
    b[b.length >> 1] ^= 0xff;
    writeFileSync(join(d, name), b);
  };

  test("rejects a flipped byte in pdflatex.fmt", async () => {
    await assert.rejects(nodeEngine(bundleCopy("fmt-flipped", flip("pdflatex.fmt"))), rejectsWith("integrity", /pdflatex\.fmt is damaged/));
  });

  test("rejects a wasm with the wrong hash", async () => {
    await assert.rejects(nodeEngine(bundleCopy("wasm-flipped", flip("busytex.wasm"))), rejectsWith("integrity", /busytex\.wasm is damaged/));
  });

  test("rejects a changed glue before importing it", async () => {
    const dir = bundleCopy("glue-changed", (d) => writeFileSync(join(d, "busytex.module.js"), "export default 1;\n"));
    await assert.rejects(nodeEngine(dir), rejectsWith("integrity", /busytex\.module\.js is damaged/));
  });

  test("rejects a truncated texmf.tar.gz", async () => {
    const dir = bundleCopy("tar-gz-truncated", (d) => {
      const b = readFileSync(join(d, "texmf.tar.gz"));
      writeFileSync(join(d, "texmf.tar.gz"), b.subarray(0, b.length >> 1));
    });
    await assert.rejects(nodeEngine(dir), rejectsWith("integrity", /texmf\.tar\.gz is damaged/));
  });

  test("rejects a re-signed truncated tar", async () => {
    const dir = bundleCopy("tar-truncated", (d) => {
      const raw = gunzipSync(readFileSync(join(d, "texmf.tar.gz")));
      const cut = raw.subarray(0, 512 * 40 + 100);
      resign(d, "texmf.tar.gz", gzipSync(cut), cut);
    });
    await assert.rejects(nodeEngine(dir), rejectsWith("integrity", /texmf\.tar\.gz is damaged: .*(end|past)/));
  });

  test("a re-signed damaged format is an integrity error", async () => {
    const dir = bundleCopy("fmt-resigned", (d) => {
      const b = readFileSync(join(d, "pdflatex.fmt"));
      b.fill(0x55, 4096, 8192);
      resign(d, "pdflatex.fmt", b);
    });
    const engine = await nodeEngine(dir, { sourceDateEpoch: EPOCH });
    await assert.rejects(engine.compile({ "cv.tex": ARTICLE("x") }), rejectsWith("integrity", /pdflatex\.fmt/));
  });

  test("untar checks checksums and the end block", () => {
    const good = tar(new Map([["a/b.txt", Buffer.from("hello")]]));
    assert.deepEqual(untar(good).map(([p]) => p), ["a/b.txt"]);
    const bad = Buffer.from(good);
    bad[0] ^= 1;
    assert.throws(() => untar(bad), /checksum/);
    assert.throws(() => untar(good.subarray(0, 1024)), /end-of-archive/);
  });
});

describe("start-up failures", () => {
  test("rejects an uninstantiable wasm without hanging", async () => {
    const dir = bundleCopy("wasm-link-error", (d) => resign(d, "busytex.wasm", LINK_ERROR_WASM));
    const engine = await nodeEngine(dir);
    const t0 = performance.now();
    await assert.rejects(engine.compile({ "cv.tex": ARTICLE("x") }), rejectsWith("start", /instantiat/i));
    assert.ok(performance.now() - t0 < 10000);
    assert.equal(engine.stats().live, false);
  });

  test("rejects a wasm that does not compile", async () => {
    const dir = bundleCopy("wasm-garbage", (d) => resign(d, "busytex.wasm", Buffer.from("not wasm at all")));
    await assert.rejects(nodeEngine(dir), rejectsWith("start", /compile/));
  });
});

describe("state between compilations", () => {
  test("200 compilations leave no state behind", async () => {
    const engine = await nodeEngine(undefined, { sourceDateEpoch: EPOCH });
    const good = { "cv.tex": ARTICLE("Hello \\today, $x^2$.") };
    const texError = { "cv.tex": ARTICLE("\\nosuchcommand") };
    const missing = { "cv.tex": ARTICLE("x").replace("\\begin{document}", "\\usepackage{tikz}\\begin{document}") };
    const first = await engine.compile(good);
    const s0 = engine.stats();
    assert.equal(s0.openStreams, 3, "only stdin, stdout and stderr are open");
    const t0 = performance.now();
    let failures = 0;
    for (let i = 0; i < 200; i++) {
      if (i % 2 === 0) {
        const r = await engine.compile(good);
        assert.ok(same(r.pdf, first.pdf), `compile ${i}: the PDF changed`);
      } else {
        await assert.rejects(engine.compile(i % 4 === 1 ? texError : missing));
        failures++;
      }
      const s = engine.stats();
      assert.equal(s.stackPointer, s0.stackPointer, `compile ${i}: the stack pointer moved`);
      assert.equal(s.openStreams, s0.openStreams, `compile ${i}: open file streams grew`);
    }
    timings.push(["200 compilations, 100 failing", performance.now() - t0]);
    assert.equal(failures, 100);
    assert.equal(engine.stats().instancesCreated, 1);
  });
});

describe("stale bundle", () => {
  test("asks to rebuild a stale bundle", () => {
    const tag = bundleCopy("stale-tag", (d) => {
      const m = JSON.parse(readFileSync(join(d, "manifest.json"), "utf8"));
      m.engine.tag = "busytex-latex-2025-01-01-000000000000";
      writeFileSync(join(d, "manifest.json"), JSON.stringify(m));
    });
    assert.throws(() => builtManifest(tag), (e) => e instanceof Stale && /rebuild the bundle/.test(e.message));
    const wasm = bundleCopy("stale-wasm", (d) => resign(d, "busytex.wasm", LINK_ERROR_WASM));
    assert.throws(() => builtManifest(wasm), (e) => e instanceof Stale && /rebuild the bundle/.test(e.message));
    const disk = bundleCopy("stale-disk", (d) => writeFileSync(join(d, "busytex.wasm"), LINK_ERROR_WASM));
    assert.throws(() => builtManifest(disk), (e) => e instanceof Stale && /rebuild the bundle/.test(e.message));
    assert.equal(builtManifest(OUT_DIR).engine.wasmSha256, sha256(readFileSync(join(OUT_DIR, "busytex.wasm"))));
  });
});

describe("busytex.wasm.gz", () => {
  test("gives the same PDF", async () => {
    const dir = bundleCopy("wasm-gz", (d) => {
      const wasm = readFileSync(join(d, "busytex.wasm"));
      const m = resign(d, "busytex.wasm.gz", gzipSync(wasm), wasm);
      m.wasm = "busytex.wasm.gz";
      m.files = m.files.filter((f) => f.name !== "busytex.wasm");
      writeFileSync(join(d, "manifest.json"), JSON.stringify(m));
    });
    const progress = [];
    const gzEngine = await nodeEngine(dir, { sourceDateEpoch: EPOCH, onProgress: (p) => progress.push(p) });
    const plain = await nodeEngine(undefined, { sourceDateEpoch: EPOCH });
    const a = await gzEngine.compile(example);
    const b = await plain.compile(example);
    assert.ok(same(a.pdf, b.pdf));
    const last = progress.at(-1);
    assert.equal(last.stage, "start");
    assert.equal(last.loaded, last.total);
  });

  test("still loads when the browser leaves the server's gzip encoding on", async () => {
    const dir = bundleCopy("wasm-gz-twice", (d) => {
      const wasm = readFileSync(join(d, "busytex.wasm"));
      const m = resign(d, "busytex.wasm.gz", gzipSync(gzipSync(wasm)), wasm);
      m.wasm = "busytex.wasm.gz";
      m.files = m.files.filter((f) => f.name !== "busytex.wasm");
      writeFileSync(join(d, "manifest.json"), JSON.stringify(m));
    });
    const engine = await nodeEngine(dir, { sourceDateEpoch: EPOCH });
    const plain = await nodeEngine(undefined, { sourceDateEpoch: EPOCH });
    assert.ok(same((await engine.compile(example)).pdf, (await plain.compile(example)).pdf));
  });
});
