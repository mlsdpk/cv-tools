// The wasm engine must match native pdflatex pixel for pixel at 150 dpi.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { EPOCH, builtManifest, nodeEngine } from "../lib/common.mjs";
import { ARTIFACTS, CV_TOOLS, PYTHON, cases, cliCase, differingPixels, links, rasterize, requireTool } from "./helpers.mjs";

const timings = [];
let engine;
const requests = [];

before(async () => {
  builtManifest();
  requireTool("pdftoppm", ["-v"]);
  requireTool(CV_TOOLS);
  requireTool(PYTHON, ["-I", "-c", "import pypdf"]);
  mkdirSync(ARTIFACTS, { recursive: true });
  const t0 = performance.now();
  engine = await nodeEngine(undefined, { sourceDateEpoch: EPOCH, requests });
  timings.push(["engine ready (load, check, decompress)", performance.now() - t0]);
});

after(() => {
  console.log("\nNode parity timings (ms):");
  for (const [what, ms] of timings) console.log(`  ${what.padEnd(56)} ${ms.toFixed(0)}`);
});

describe("parity with the CLI (native pdflatex)", () => {
  let first = true;
  for (const c of cases()) {
    test(c.name, async () => {
      const cli = cliCase(c);
      const t0 = performance.now();
      const r = await engine.compile(cli.files);
      const wall = performance.now() - t0;
      timings.push([`${c.name}${first ? " (first compile, starts the instance)" : ""}${r.extrasLoaded ? " (loads the font pack)" : ""}`, wall]);
      first = false;
      const wasmPdf = join(cli.dir, "wasm.pdf");
      writeFileSync(wasmPdf, r.pdf);

      const native = rasterize(join(cli.dir, "native.pdf"), join(cli.dir, "native"));
      const wasm = rasterize(wasmPdf, join(cli.dir, "wasm"));
      assert.ok(native.length > 0, "pdftoppm rendered no pages");
      assert.equal(wasm.length, native.length, "page count");
      if (c.name === "engine-long") assert.ok(native.length >= 10, `the long fixture has ${native.length} pages, fewer than 10`);
      native.forEach((page, i) => assert.equal(differingPixels(page, wasm[i]), 0, `pixels differ on page ${i + 1}`));

      const l = links(join(cli.dir, "native.pdf"), wasmPdf);
      assert.deepEqual(l[wasmPdf], l[join(cli.dir, "native.pdf")], "links");
    });
  }

  test("fetches the font pack once", () => {
    assert.equal(requests.filter((n) => n === "texmf-extra.tar.gz").length, 1);
    assert.ok(engine.stats().extrasLoaded);
  });
});
