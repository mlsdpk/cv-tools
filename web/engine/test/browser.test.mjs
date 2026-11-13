// Served without COOP/COEP; .ts files are type-stripped as Node does, and extensionless imports resolve to .ts as in Vite.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, normalize } from "node:path";
import { after, before, describe, test } from "node:test";
import { gzipSync } from "node:zlib";
import { chromium, webkit } from "playwright";
import { EPOCH, OUT_DIR, WEB_DIR, builtManifest, nodeEngine } from "../lib/common.mjs";
import { ARTIFACTS, CV_TOOLS, LINK_ERROR_WASM, bundleCopy, cases, requireTool, resign, texSources } from "./helpers.mjs";

const SITE = join(ARTIFACTS, "site");
export const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".gz": "application/gzip",
  ".fmt": "application/octet-stream",
};

// A module, because the CSP blocks inline scripts.
const TEST_JS = `
import { TexClient } from "./tex/client.ts";
const clients = new Map();
const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
const decode = (files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, fromB64(v)]));
const err = (e) => ({ name: e.name, code: e.code, tex: e.tex, message: e.message, log: e.log.length });
let evalBlocked = false;
try { new Function("return 1")(); } catch { evalBlocked = true; }
window.texTest = {
  evalBlocked,
  make(key, options) { clients.get(key)?.terminate(); clients.set(key, new TexClient(options)); },
  async init(key) {
    const t0 = performance.now();
    const progress = [];
    const info = await clients.get(key).init((p) => progress.push(p));
    return { info, ms: performance.now() - t0, progress: progress.length, last: progress.at(-1),
             crossOriginIsolated: self.crossOriginIsolated };
  },
  async compile(key, files, options = {}) {
    const t0 = performance.now();
    try {
      const r = await clients.get(key).compile(decode(files), options);
      return { pdf: toB64(r.pdf), ms: r.ms, wall: performance.now() - t0, extrasLoaded: r.extrasLoaded };
    } catch (e) { return { error: err(e), wall: performance.now() - t0 }; }
  },
  workerEvalBlocked() {
    return new Promise((resolve) => {
      const w = new Worker(new URL("./evalcheck.js", import.meta.url), { type: "module" });
      w.onmessage = (e) => { resolve(e.data); w.terminate(); };
      w.onerror = () => resolve("worker failed");
    });
  },
  async coalesce(key, slow, small) {
    const c = clients.get(key);
    const run = (files, options) => c.compile(decode(files), options).then((r) => new TextDecoder().decode(r.pdf.subarray(0, 5)), (e) => "rejected:" + e.code);
    const all = [run(slow, { coalesce: true }), run(small, { coalesce: true }), run(small), run(small, { coalesce: true }), run(small, { coalesce: true })];
    return Promise.all(all);
  },
};
window.texTestReady = true;
`;

function writeSite() {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(join(SITE, "tex"), { recursive: true });
  writeFileSync(join(SITE, "index.html"), '<!doctype html>\n<meta charset="utf-8">\n<title>tex worker test</title>\n<script type="module" src="./test.js"></script>\n');
  writeFileSync(join(SITE, "test.js"), TEST_JS);
  writeFileSync(join(SITE, "evalcheck.js"), 'let blocked = false;\ntry { new Function("return 1")(); } catch { blocked = true; }\npostMessage(blocked);\n');
  const src = join(WEB_DIR, "src", "tex");
  for (const f of readdirSync(src).filter((f) => f.endsWith(".ts"))) {
    writeFileSync(join(SITE, "tex", f), stripTypeScriptTypes(readFileSync(join(src, f), "utf8"), { mode: "strip" }));
  }
}

// Routes: / and /csp/ (with the CSP header), /engine/ and /<variant>/engine/.
function serve(variants) {
  const log = [];
  const gzCache = new Map();
  const server = createServer((req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    log.push(path);
    const headers = {};
    if (path.startsWith("/csp/")) {
      headers["Content-Security-Policy"] = CSP;
      path = path.slice(4);
    }
    let file;
    let encode = false;
    const m = /^\/([\w-]+)\/engine\/(.*)$/.exec(path);
    if (path.startsWith("/engine/")) file = join(OUT_DIR, path.slice(8));
    else if (m && variants[m[1]]) {
      file = join(variants[m[1]].dir, m[2]);
      encode = variants[m[1]].gzipEncoded?.includes(m[2]) ?? false;
    } else file = join(SITE, path === "/" ? "index.html" : path);
    if (!extname(file) && existsSync(file + ".ts")) file += ".ts";
    if (path.includes("..") || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, headers).end();
      return;
    }
    let body = readFileSync(file);
    if (encode) {
      if (!gzCache.has(file)) gzCache.set(file, gzipSync(body));
      body = gzCache.get(file);
      headers["Content-Encoding"] = "gzip";
    }
    res.writeHead(200, { ...headers, "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Content-Length": body.length });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, log })));
}

const b64 = (u8) => Buffer.from(u8).toString("base64");
const encodeFiles = (files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, b64(v)]));
const texFile = (tex) => ({ "cv.tex": Buffer.from(tex).toString("base64") });
const ARTICLE = (body) => `\\documentclass[11pt]{article}\\begin{document}${body}\\end{document}\n`;
let http;
let base;
const reference = new Map(); // case -> Node engine { files, pdf }
const timings = [];
let variants;

before(async () => {
  builtManifest();
  requireTool(CV_TOOLS);
  writeSite();
  const wasm = readFileSync(join(OUT_DIR, "busytex.wasm"));
  const wasmGz = bundleCopy("browser-wasm-gz", (d) => {
    const m = resign(d, "busytex.wasm.gz", gzipSync(wasm), wasm);
    m.wasm = "busytex.wasm.gz";
    m.files = m.files.filter((f) => f.name !== "busytex.wasm");
    writeFileSync(join(d, "manifest.json"), JSON.stringify(m));
  });
  variants = {
    gzenc: { dir: OUT_DIR, gzipEncoded: ["busytex.wasm"] },
    wasmgz: { dir: wasmGz },
    wasmgzenc: { dir: wasmGz, gzipEncoded: ["busytex.wasm.gz"] },
    linkerr: { dir: bundleCopy("browser-link-error", (d) => resign(d, "busytex.wasm", LINK_ERROR_WASM)) },
  };
  http = await serve(variants);
  base = `http://127.0.0.1:${http.server.address().port}/`;
  const engine = await nodeEngine(undefined, { sourceDateEpoch: EPOCH });
  for (const c of cases()) {
    const files = texSources(c);
    reference.set(c.name, { files, pdf: (await engine.compile(files)).pdf });
  }
});

after(() => {
  http?.server.close();
  console.log("\nBrowser timings (ms):");
  for (const [what, ms] of timings) console.log(`  ${what.padEnd(64)} ${ms.toFixed(0)}`);
});

for (const browserType of [chromium, webkit]) {
  const name = browserType.name();
  describe(name, () => {
    let browser;
    const pages = {};
    const page = async (path) => {
      if (pages[path]) return pages[path];
      const p = await browser.newPage();
      const headers = [];
      p.on("response", (r) => headers.push(r.headers()));
      p.on("pageerror", (e) => console.error(`${name} page error: ${e.message}`));
      await p.goto(base + path);
      await p.waitForFunction(() => window.texTest !== undefined && window.texTestReady === true);
      assert.ok(headers.every((h) => !h["cross-origin-opener-policy"] && !h["cross-origin-embedder-policy"]));
      pages[path] = p;
      return p;
    };
    const run = (p, fn, ...args) => p.evaluate(([f, a]) => window.texTest[f](...a), [fn, args]);
    const refFiles = (n) => encodeFiles(reference.get(n).files);

    before(async () => {
      try {
        browser = await browserType.launch();
      } catch (e) {
        throw new Error(`cannot start Playwright ${name}; install it with 'npx --prefix web/engine playwright install chromium webkit'\n${e.message}`);
      }
    });
    after(async () => browser?.close());

    test("starts without cross-origin isolation", async () => {
      const p = await page("");
      await run(p, "make", "main", { sourceDateEpoch: EPOCH });
      const r = await run(p, "init", "main");
      timings.push([`${name}: init (download from localhost, check, compile wasm)`, r.ms]);
      assert.equal(r.crossOriginIsolated, false);
      assert.equal(r.info.tag, builtManifest().engine.tag);
      assert.ok(r.progress > 0);
      assert.equal(r.last.loaded, r.last.total);
    });

    test("matches the Node engine's PDF bytes", async () => {
      const p = await page("");
      http.log.length = 0;
      let n = 0;
      for (const [caseName, ref] of reference) {
        const r = await run(p, "compile", "main", encodeFiles(ref.files));
        assert.ok(!r.error, `${caseName}: ${r.error?.message}`);
        timings.push([`${name}: ${caseName}${n++ === 0 ? " (first compile, starts the instance)" : ""}${r.extrasLoaded ? " (loads the font pack)" : ""}`, r.wall]);
        assert.ok(Buffer.from(r.pdf, "base64").equals(Buffer.from(ref.pdf)), `${caseName}: PDF bytes differ from Node`);
      }
      assert.equal(http.log.filter((l) => l === "/engine/texmf-extra.tar.gz").length, 1);
    });

    test("rejects with tex and missing-file codes", async () => {
      const p = await page("");
      const tex = await run(p, "compile", "main", texFile(ARTICLE("\\nosuchcommand")));
      assert.equal(tex.error.name, "TexCompileError");
      assert.equal(tex.error.code, "tex");
      assert.equal(tex.error.tex, true);
      assert.match(tex.error.message, /Undefined control sequence/);
      assert.ok(tex.error.log > 0);
      const missing = await run(p, "compile", "main", texFile("\\documentclass[11pt]{article}\\usepackage{tikz}\\begin{document}x\\end{document}"));
      assert.equal(missing.error.code, "missing-file");
      assert.equal(missing.error.tex, false);
      assert.match(missing.error.message, /browser TeX engine lacks the file tikz\.sty/);
    });

    test("the watchdog stops an infinite loop", async () => {
      const p = await page("");
      const r = await run(p, "compile", "main", texFile(ARTICLE("\\def\\x{\\x}\\x")), { timeoutMs: 3000 });
      timings.push([`${name}: infinite loop until the watchdog fires (3 s)`, r.wall]);
      assert.equal(r.error?.code, "timeout");
      assert.match(r.error.message, /infinite loop in raw LaTeX/);
      assert.ok(r.wall < 10000);
      const ok = await run(p, "compile", "main", refFiles("example"));
      timings.push([`${name}: next compile (restarts the worker)`, ok.wall]);
      assert.ok(Buffer.from(ok.pdf, "base64").equals(Buffer.from(reference.get("example").pdf)));
    });

    test("coalesces queued previews", async () => {
      const p = await page("");
      const out = await run(p, "coalesce", "main", refFiles("engine-long"), refFiles("example"));
      assert.deepEqual(out, ["%PDF-", "rejected:superseded", "%PDF-", "rejected:superseded", "%PDF-"]);
    });

    test("rejects an uninstantiable wasm without hanging", async () => {
      const p = await page("");
      await run(p, "make", "linkerr", { baseUrl: "/linkerr/engine/", sourceDateEpoch: EPOCH });
      const r = await run(p, "compile", "linkerr", texFile(ARTICLE("x")));
      assert.equal(r.error?.code, "start");
      assert.match(r.error.message, /instantiat/i);
      assert.ok(r.wall < 15000);
    });

    for (const [variant, what] of [
      ["gzenc", "busytex.wasm sent with Content-Encoding: gzip"],
      ["wasmgz", "busytex.wasm.gz"],
      ["wasmgzenc", "busytex.wasm.gz sent with Content-Encoding: gzip"],
    ]) {
      test(`${what} gives the same PDF`, async () => {
        const p = await page("");
        await run(p, "make", variant, { baseUrl: `/${variant}/engine/`, sourceDateEpoch: EPOCH });
        const t0 = performance.now();
        await run(p, "init", variant);
        const r = await run(p, "compile", variant, refFiles("example"));
        timings.push([`${name}: ${what}, init and first compile`, performance.now() - t0]);
        assert.ok(!r.error, r.error?.message);
        assert.ok(Buffer.from(r.pdf, "base64").equals(Buffer.from(reference.get("example").pdf)));
        assert.ok(http.log.includes(`/${variant}/engine/${variant === "gzenc" ? "busytex.wasm" : "busytex.wasm.gz"}`));
      });
    }

    test("runs under the CSP", async () => {
      const p = await page("csp/");
      assert.equal(await p.evaluate(() => window.texTest.evalBlocked), true, "the CSP is in force on the page (eval is blocked)");
      assert.equal(await p.evaluate(() => window.texTest.workerEvalBlocked()), true, "the CSP is in force in a worker (eval is blocked)");
      await run(p, "make", "csp", { baseUrl: "/csp/engine/", sourceDateEpoch: EPOCH });
      const r = await run(p, "compile", "csp", refFiles("example"));
      assert.ok(!r.error, r.error?.message);
      assert.ok(Buffer.from(r.pdf, "base64").equals(Buffer.from(reference.get("example").pdf)));
      assert.ok(http.log.includes("/csp/tex/tex.worker.ts"), "the worker script came with the CSP header");
    });
  });
}
