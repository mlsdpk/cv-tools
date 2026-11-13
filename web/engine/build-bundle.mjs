// Usage: node build-bundle.mjs [--wasm-gz] [--brotli]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants as zc, gzipSync } from "node:zlib";
import { CACHE_DIR, ENGINE_DIR, EPOCH, LOCK, OUT_DIR, REPO_DIR, createEngine, nodeEngine, releaseFile, sha256 } from "./lib/common.mjs";
import { detectComponents, licenseFiles, texPackages, thirdPartyMarkdown, tlpdbPackages } from "./lib/licenses.mjs";
import { addLsR, englishOnly, glueModule, gzip, kpseFind, lsR, mapTree, recorded, tar, texInfo, tool, treePath, trimMap } from "./lib/tree.mjs";

const WORK = join(CACHE_DIR, "build");
const WASM_GZ = process.argv.includes("--wasm-gz");
const BROTLI = process.argv.includes("--brotli");
const t0 = performance.now();
const step = (msg) => console.log(`build: ${msg} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
const FONT = /\.(tfm|pfb)$/;
const GLUE = "busytex.module.js";
const EXTRA_PACK = "texmf-extra.tar.gz";
const EXTRA_INDEX = "texmf-extra.json";

function python() {
  if (process.env.PYTHON) return process.env.PYTHON;
  for (const v of [".venv", "venv"]) {
    const p = join(REPO_DIR, v, "bin", "python");
    if (existsSync(p)) return p;
  }
  return "python3";
}

function sizes(files) {
  const cachePath = join(CACHE_DIR, "sizes.json");
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {}
  const rows = files.map(([name, data]) => {
    const h = sha256(data);
    cache[h] ??= {};
    cache[h].gzip ??= gzipSync(data, { level: 9 }).length;
    if (BROTLI) {
      cache[h].brotli ??= brotliCompressSync(data, {
        params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: data.length },
      }).length;
    }
    return { name, raw: data.length, ...cache[h] };
  });
  writeFileSync(cachePath, JSON.stringify(cache));
  return rows;
}

const fileEntry = (name, data, raw) => ({
  name,
  bytes: data.length,
  sha256: sha256(data),
  ...(raw ? { rawBytes: raw.length, rawSha256: sha256(raw) } : {}),
});

async function main() {
  const glue = releaseFile("busytex.js");
  const wasmBytes = releaseFile("busytex.wasm");
  const tex = texInfo();
  const packagesByFile = tlpdbPackages(tex.tlpdb);
  step(`${tex.version}, tree from ${tex.root}`);
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  const py = spawnSync(python(), ["-I", join(ENGINE_DIR, "coverage.py"), REPO_DIR, join(WORK, "cases")], { encoding: "utf8" });
  if (py.status !== 0) throw new Error(`coverage.py failed (Python ${python()}; set PYTHON to one with cv_tools installed):\n${py.stderr}`);
  const cases = JSON.parse(py.stdout);
  step(`${cases.base.length} coverage documents and ${cases.extras.length} font pack document`);

  const pdflatex = (dir) => recorded(dir, "pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "cv.tex"], "cv");
  const fmtLine = readFileSync(tool("kpsewhich", ["fmtutil.cnf"]), "utf8").split("\n").find((l) => /^pdflatex\s+pdftex\s/.test(l));
  if (!fmtLine) throw new Error("fmtutil.cnf has no pdflatex line");
  const iniArgs = fmtLine.trim().split(/\s+/).slice(3);
  const fmtDir = join(WORK, "fmt-native");
  mkdirSync(fmtDir);
  const fmtRun = recorded(fmtDir, "pdftex", ["-ini", "-interaction=nonstopmode", "-jobname=pdflatex", "-progname=pdflatex", ...iniArgs], "pdflatex");
  const union = async (dirs) => {
    const all = new Set();
    for (const inputs of await Promise.all(dirs.map(pdflatex))) for (const f of inputs) if (!f.endsWith(".fmt")) all.add(f);
    return all;
  };
  const [baseInputs, extraInputs, fmtInputs] = await Promise.all([union(cases.base), union(cases.extras), fmtRun]);
  step(`recorded ${baseInputs.size} document inputs, ${extraInputs.size} font pack inputs and ${fmtInputs.size} format inputs`);

  const runtime = mapTree(tex, baseInputs);
  const extraNative = mapTree(tex, extraInputs);
  const extra = new Map();
  for (const [rel, f] of extraNative) {
    if (runtime.has(rel)) continue;
    if (FONT.test(rel)) extra.set(rel, f);
    else runtime.set(rel, f);
  }
  const fmtFiles = mapTree(tex, fmtInputs);
  const tfmNames = (keys) => [...keys].filter((p) => p.endsWith(".tfm")).map((p) => basename(p, ".tfm"));
  const baseTfms = new Set([...tfmNames(runtime.keys()), ...tfmNames(fmtFiles.keys())]);
  const allTfms = new Set([...baseTfms, ...tfmNames(extra.keys())]);
  const mapRel = [...runtime.keys()].find((p) => p.endsWith("/pdftex.map"));
  if (!mapRel) throw new Error("no document read pdftex.map");
  const mapText = readFileSync(runtime.get(mapRel), "latin1");
  // One map serves both trees: an unloaded pack font fails on its .tfm before pdfTeX looks for its .pfb.
  const map = trimMap(mapText, allTfms);
  const baseMap = trimMap(mapText, baseTfms);
  const glyphs = kpseFind([...map.files]);
  for (const [name, f] of glyphs) {
    const rel = treePath(tex, f);
    if (rel === null) throw new Error(`${f} is outside the TeX Live trees`);
    if (baseMap.files.has(name) || !FONT.test(name)) {
      runtime.set(rel, f);
      extra.delete(rel);
    } else if (!runtime.has(rel)) extra.set(rel, f);
  }
  const tree = new Map([...runtime].map(([rel, f]) => [rel, readFileSync(f)]));
  tree.set(mapRel, Buffer.from(map.text, "latin1"));
  const treeFiles = [...tree.keys()].sort();
  addLsR(tree);
  const texmfTar = tar(tree);
  const extraTree = new Map([...extra].map(([rel, f]) => [rel, readFileSync(f)]));
  const extraFiles = [...extraTree.keys()].sort();
  if (extraFiles.some((p) => !p.startsWith("texmf-dist/"))) throw new Error("the font pack has files outside texmf-dist");
  // The pack's ls-R covers both trees because it replaces the base one on load.
  extraTree.set("texmf-dist/ls-R", lsR([...treeFiles, ...extraFiles], "texmf-dist"));
  const extraTar = tar(extraTree);
  const extraIndex = Buffer.from(JSON.stringify({ files: [...new Set(extraFiles.map((p) => basename(p)))].sort() }) + "\n");
  step(`base tree ${treeFiles.length} files, font pack ${extraFiles.length} files`);

  const glueJs = Buffer.from(glueModule(glue.toString("utf8"), { tag: LOCK.tag, sha256: LOCK.files["busytex.js"] }));
  const glueDir = join(WORK, "glue");
  mkdirSync(glueDir, { recursive: true });
  writeFileSync(join(glueDir, GLUE), glueJs);
  const factory = (await import(pathToFileURL(join(glueDir, GLUE)).href)).default;
  const fmtTree = new Map([...fmtFiles].map(([rel, f]) => [rel, readFileSync(f)]));
  const langRel = [...fmtTree.keys()].find((p) => p.endsWith("/language.dat"));
  if (!langRel) throw new Error("the format did not read language.dat");
  fmtTree.set(langRel, Buffer.from(englishOnly(fmtTree.get(langRel).toString("utf8"))));
  addLsR(fmtTree);
  const stub = { version: "build", engine: {}, tree: {}, glue: GLUE, wasm: "busytex.wasm", files: [] };
  const fmtEngine = await createEngine({ manifest: stub, factory, wasm: await WebAssembly.compile(wasmBytes), texmf: [...fmtTree], format: new Uint8Array(0) });
  const ini = await fmtEngine.run(
    ["pdftex", "-ini", "-interaction=nonstopmode", "-jobname=pdflatex", "-progname=pdflatex", ...iniArgs],
    {}, { sourceDateEpoch: EPOCH, read: ["pdflatex.fmt", "pdflatex.log"] },
  );
  if (ini.code !== 0 || !ini.files["pdflatex.fmt"]) {
    const log = ini.files["pdflatex.log"] ? Buffer.from(ini.files["pdflatex.log"]).toString() : ini.out;
    throw new Error(`the wasm engine could not build pdflatex.fmt:\n${log.slice(-3000)}`);
  }
  const fmt = Buffer.from(ini.files["pdflatex.fmt"]);
  step(`pdflatex.fmt built by the wasm engine (${fmt.length} bytes)`);

  // Check licences and sources before writing anything.
  const components = detectComponents(wasmBytes);
  const packages = texPackages({ treeFiles: [...new Set([...treeFiles, ...fmtFiles.keys()])], extraFiles, packagesByFile });
  const licenses = licenseFiles();
  const versions = releaseFile("versions.txt").toString("utf8");
  const tlCommit = /texlive-source\/archive\/([0-9a-f]{40})\.tar\.gz/.exec(versions)?.[1];
  const tlSource = LOCK.sources.find((s) => s.name === "texlive-source");
  if (!tlCommit || !tlSource?.url.includes(tlCommit)) throw new Error(`engine.lock.json's texlive-source does not match the commit in versions.txt (${tlCommit})`);
  if (!LOCK.sources.find((s) => s.name === "busytex")?.url.includes(LOCK.sourceCommit)) throw new Error("engine.lock.json's busytex source is not at sourceCommit");
  const sources = { tag: LOCK.tag, sourceCommit: LOCK.sourceCommit, texliveSourceCommit: tlCommit, archives: LOCK.sources };

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(join(OUT_DIR, "licenses"), { recursive: true });
  const wasmOut = WASM_GZ ? ["busytex.wasm.gz", gzip(wasmBytes), wasmBytes] : ["busytex.wasm", wasmBytes];
  const outputs = [
    [GLUE, glueJs],
    wasmOut,
    ["texmf.tar.gz", gzip(texmfTar), texmfTar],
    ["pdflatex.fmt", fmt],
    [EXTRA_PACK, gzip(extraTar), extraTar],
    [EXTRA_INDEX, extraIndex],
  ];
  for (const [name, data] of outputs) writeFileSync(join(OUT_DIR, name), data);
  writeFileSync(join(OUT_DIR, "sources.json"), JSON.stringify(sources, null, 2) + "\n");
  for (const name of ["LICENSE.TL", "LICENSE.CTAN", "versions.txt", "source-commit.txt"]) writeFileSync(join(OUT_DIR, "licenses", name), releaseFile(name));
  for (const [file, { data }] of licenses) {
    mkdirSync(dirname(join(OUT_DIR, "licenses", file)), { recursive: true });
    writeFileSync(join(OUT_DIR, "licenses", file), data);
  }
  writeFileSync(
    join(OUT_DIR, "licenses", "THIRD_PARTY.md"),
    thirdPartyMarkdown({ lock: LOCK, versions, components, packages, treeYear: tex.year, sources: LOCK.sources }),
  );
  const files = outputs.map(([name, data, raw]) => fileEntry(name, data, raw));
  const manifest = {
    version: sha256(files.map((f) => f.sha256).join("")).slice(0, 16),
    engine: {
      repo: LOCK.repo, tag: LOCK.tag, sourceCommit: LOCK.sourceCommit, pdftex: LOCK.pdftex, texliveYear: LOCK.texliveYear,
      wasmSha256: LOCK.files["busytex.wasm"], glueSha256: LOCK.files["busytex.js"],
    },
    tree: { texliveYear: tex.year, pdftex: tex.version, files: treeFiles.length, extraFiles: extraFiles.length },
    glue: GLUE,
    wasm: wasmOut[0],
    extras: { pack: EXTRA_PACK, index: EXTRA_INDEX },
    files,
    licenses: "licenses/THIRD_PARTY.md",
    sources: "sources.json",
  };
  writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  step(`wrote ${OUT_DIR} (${treeFiles.length} TeX files, ${extraFiles.length} in the font pack)`);

  const engine = await nodeEngine(OUT_DIR, { sourceDateEpoch: EPOCH });
  const input = (dir) => Object.fromEntries(["cv.tex", "resume.cls", "orcid.pdf"].map((n) => [n, readFileSync(join(dir, n))]));
  const r = await engine.compile(input(cases.base.find((c) => c.endsWith("synthetic"))));
  if (r.extrasLoaded) throw new Error("the synthetic document needed the font pack; the base tree is incomplete");
  step(`smoke test: synthetic document compiled in ${r.ms.toFixed(0)} ms (${r.pdf.length} bytes)`);
  const x = await engine.compile(input(cases.extras[0]));
  if (!x.extrasLoaded) throw new Error("the extras document did not load the font pack");
  step(`smoke test: extras document loaded the font pack and compiled in ${x.ms.toFixed(0)} ms`);

  const fmtKB = (n) => `${(n / 1024).toFixed(0)} KiB`.padStart(11);
  const rows = sizes([...outputs.map(([n, d]) => [n, d]), ["texmf.tar (unpacked)", texmfTar], ["texmf-extra.tar (unpacked)", extraTar]]);
  console.log("\nfile                        raw        gzip -9   brotli 11");
  for (const s of rows) console.log(`${s.name.padEnd(22)}${fmtKB(s.raw)}${fmtKB(s.gzip)}${s.brotli ? fmtKB(s.brotli) : "  (--brotli)"}`);
  const lic = [...licenses.values()].reduce((n, { data }) => n + data.length, 0);
  console.log(`licenses/ (texts and notices)  ${(lic / 1024).toFixed(0)} KiB; corresponding source archives (mirror-sources.mjs) ${(LOCK.sources.reduce((n, s) => n + s.bytes, 0) / 2 ** 20).toFixed(1)} MiB`);
}

main().catch((e) => {
  console.error(`build: ${e.stack || e.message}`);
  process.exit(1);
});
