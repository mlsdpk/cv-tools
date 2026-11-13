import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ENGINE_DIR, LOCK, OUT_DIR, builtManifest, sha256 } from "../lib/common.mjs";
import { COMPONENTS, detectComponents, texPackages, tlpdbPackages } from "../lib/licenses.mjs";
import { mapTree, texInfo } from "../lib/tree.mjs";
import { ARTIFACTS } from "./helpers.mjs";

const scratch = (name) => {
  const dir = join(ARTIFACTS, "build-test", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe("TeX Live layout", () => {
  test("rejects a Debian layout", () => {
    const vars = { version: "pdfTeX 3.141592653-2.6-1.40.25 (TeX Live 2023/Debian)", TEXMFROOT: "/usr/share/texlive", TEXMFDIST: "/usr/share/texlive/texmf-dist" };
    assert.throws(() => texInfo(vars), /has no tlpkg\/texlive\.tlpdb.*install-tl.*Debian/s);
  });

  test("rejects a TEXMFDIST outside TEXMFROOT", () => {
    const root = scratch("root");
    mkdirSync(join(root, "tlpkg"));
    writeFileSync(join(root, "tlpkg", "texlive.tlpdb"), "name x\n");
    const vars = { version: "pdfTeX (TeX Live 2026)", TEXMFROOT: root, TEXMFDIST: "/usr/share/texmf-dist" };
    assert.throws(() => texInfo(vars), /TEXMFDIST is '\/usr\/share\/texmf-dist'/);
  });

  test("rejects a file outside the trees", () => {
    const tex = { roots: [["/usr/share/texlive/texmf-dist", "texmf-dist"]] };
    assert.throws(() => mapTree(tex, ["/usr/share/texlive/texmf-dist/tex/a.sty", "/usr/share/texmf/tex/latex/b.sty"]), /outside the TeX Live trees.*b\.sty.*Debian/s);
  });

  test("rejects a missing or empty package database", () => {
    assert.throws(() => tlpdbPackages("/nonexistent/tlpkg/texlive.tlpdb"), /does not exist/);
    const dir = scratch("tlpdb");
    writeFileSync(join(dir, "texlive.tlpdb"), "\n");
    assert.throws(() => tlpdbPackages(join(dir, "texlive.tlpdb")), /lists no files/);
  });

  test("rejects unowned files and unlicensed fonts", () => {
    const latex = { name: "latex", license: "lppl1.3c", ctan: "/macros/latex" };
    const fonty = { name: "newfonts", license: "lppl", ctan: "" };
    const byFile = new Map([["texmf-dist/tex/latex/base/article.cls", latex], ["texmf-dist/fonts/tfm/new/x.tfm", fonty]]);
    assert.throws(() => texPackages({ treeFiles: ["texmf-dist/tex/latex/foo/foo.sty"], extraFiles: [], packagesByFile: byFile }), /not in the TeX Live package database/);
    assert.throws(() => texPackages({ treeFiles: ["texmf-dist/fonts/tfm/new/x.tfm"], extraFiles: [], packagesByFile: byFile }), /no font licence for newfonts/);
    const ok = texPackages({ treeFiles: ["texmf-dist/tex/latex/base/article.cls", "texmf-dist/ls-R", "texmf.cnf"], extraFiles: [], packagesByFile: byFile });
    assert.deepEqual(ok.map((p) => p.name), ["(generated)", "latex"]);
  });
});

describe("licences", () => {
  test("lists only linked components", () => {
    const wasm = readFileSync(join(OUT_DIR, builtManifest().wasm));
    const found = Object.fromEntries(detectComponents(wasm).map((c) => [c.name, c.linked]));
    assert.equal(found.pdfTeX, true);
    assert.equal(found.kpathsea, true);
    assert.equal(found.TECkit, false);
    assert.throws(() => detectComponents(Buffer.from("nothing here")), /does not contain pdfTeX/);
  });

  test("ships the licence texts unchanged", () => {
    const index = JSON.parse(readFileSync(join(ENGINE_DIR, "licenses", "index.json"), "utf8"));
    for (const name of ["GPL-2.0", "GPL-3.0", "LGPL-2.1", "LGPL-3.0", "OFL-1.1", "LPPL-1.3c"]) {
      assert.ok(index.files.some((f) => f.file === `texts/${name}.txt`), `${name} is vendored`);
    }
    for (const f of index.files) assert.equal(sha256(readFileSync(join(OUT_DIR, "licenses", f.file))), f.sha256, f.file);
    const gpl2 = readFileSync(join(OUT_DIR, "licenses", "texts", "GPL-2.0.txt"), "utf8");
    assert.match(gpl2, /GNU GENERAL PUBLIC LICENSE\s+Version 2, June 1991/);
    assert.ok(gpl2.length > 17000, "the full text, not a summary");
  });

  test("THIRD_PARTY.md lists package and font licences", () => {
    const md = readFileSync(join(OUT_DIR, "licenses", "THIRD_PARTY.md"), "utf8");
    const rows = (name) => md.split("\n").filter((l) => l.startsWith(`| ${name} |`));
    assert.match(rows("cm-super")[0], /\| gpl \(\[GPL-2\.0\.txt\]\(texts\/GPL-2\.0\.txt\)\) \| GPL-2\.0-or-later with a font embedding exception/);
    assert.match(rows("fontawesome")[0], /\| lppl1\.3c?.*\| OFL-1\.1 \(Font Awesome 4/);
    assert.match(rows("amsfonts")[0], /\| ofl .*\| OFL-1\.1 \(Copyright 1997, 2009 American Mathematical Society\)/);
    assert.match(rows("latex")[0], /\| lppl1\.3c .*\|  \| \d+ \| 0 \|/, "a package without fonts has no font licence");
    assert.equal(rows("TECkit").length, 0, "TECkit is not linked");
    assert.equal(rows("zziplib").length, 0, "zziplib is not linked");
    assert.equal(rows("pdfTeX").length, 1);
    assert.match(md, /The complete source of the engine is published with cv-tools, as the assets of the GitHub Release/);
    for (const s of LOCK.sources) assert.ok(md.includes(s.sha256), `${s.name} source is listed`);
    for (const [name, font] of Object.entries(COMPONENTS.fonts)) {
      if (rows(name).length) assert.ok(rows(name)[0].includes(font.license.split(" ")[0]));
    }
  });
});

describe("sources", () => {
  test("sources.json pins both source commits", () => {
    const sources = JSON.parse(readFileSync(join(OUT_DIR, "sources.json"), "utf8"));
    const versions = readFileSync(join(OUT_DIR, "licenses", "versions.txt"), "utf8");
    const busytex = sources.archives.find((s) => s.name === "busytex");
    const tl = sources.archives.find((s) => s.name === "texlive-source");
    assert.ok(busytex.url.includes(LOCK.sourceCommit));
    assert.ok(versions.includes(tl.url), "the texlive-source URL is the one versions.txt names");
    assert.ok(tl.url.includes(sources.texliveSourceCommit));
    for (const s of sources.archives) assert.match(s.sha256, /^[0-9a-f]{64}$/);
  });

  test("mirror-sources.mjs mirrors and rejects a wrong hash", async () => {
    const files = { "a.tar.gz": Buffer.from("archive a"), "b.tar.gz": Buffer.from("archive b") };
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      const data = files[req.url.slice(1)];
      if (!data) res.writeHead(404).end();
      else res.writeHead(200).end(data);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}/`;
    const dir = scratch("mirror");
    const lock = (shaB) => {
      const sources = Object.entries(files).map(([file, data]) => ({ name: file, url: base + file, file, bytes: data.length, sha256: sha256(data) }));
      if (shaB) sources[1].sha256 = shaB;
      writeFileSync(join(dir, "lock.json"), JSON.stringify({ tag: "t", sourceCommit: "c", sources }));
      return join(dir, "lock.json");
    };
    const run = (lockPath) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [join(ENGINE_DIR, "mirror-sources.mjs"), join(dir, "out"), "--lock", lockPath], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("close", (code) => resolve({ code, out }));
      });
    try {
      const first = await run(lock());
      assert.equal(first.code, 0, first.out);
      assert.equal(readFileSync(join(dir, "out", "a.tar.gz"), "utf8"), "archive a");
      assert.match(readFileSync(join(dir, "out", "SHA256SUMS"), "utf8"), new RegExp(`${sha256(files["b.tar.gz"])}  b\\.tar\\.gz`));
      const again = await run(lock());
      assert.equal(again.code, 0);
      assert.equal(hits, 2, "archives already mirrored are not downloaded again");
      rmSync(join(dir, "out", "b.tar.gz"));
      const bad = await run(lock("0".repeat(64)));
      assert.equal(bad.code, 1);
      assert.match(bad.out, /cannot mirror b\.tar\.gz.*SHA256/);
    } finally {
      server.close();
    }
  });
});

describe("manifest", () => {
  test("names the glue and the font pack", () => {
    const m = builtManifest();
    assert.equal(m.glue, "busytex.module.js");
    assert.deepEqual(m.extras, { pack: "texmf-extra.tar.gz", index: "texmf-extra.json" });
    for (const name of ["texmf.tar.gz", "texmf-extra.tar.gz"]) assert.match(m.files.find((f) => f.name === name).rawSha256, /^[0-9a-f]{64}$/);
    const index = JSON.parse(readFileSync(join(OUT_DIR, "texmf-extra.json"), "utf8")).files;
    assert.ok(index.includes("ecrm0900.tfm") && index.some((n) => n.endsWith(".pfb")), "the pack holds T1 metrics and Type 1 fonts the base lacks");
    assert.ok(index.every((n) => /\.(tfm|pfb)$/.test(n)), "the pack holds only fonts");
  });
});
