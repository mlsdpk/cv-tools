// Missing prerequisites throw so that tests fail instead of skipping.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_DIR, OUT_DIR, REPO_DIR, sha256 } from "../lib/common.mjs";
import { ENV } from "../lib/tree.mjs";

export const ARTIFACTS = join(ENGINE_DIR, "test", "_artifacts");

export const TEX_ENV = ENV;

function venvBin(name) {
  for (const v of [".venv", "venv"]) {
    const p = join(REPO_DIR, v, "bin", name);
    if (existsSync(p)) return p;
  }
  return name;
}
export const CV_TOOLS = process.env.CV_TOOLS || venvBin("cv-tools");
export const PYTHON = process.env.PYTHON || venvBin("python");

export function requireTool(cmd, args = ["--version"]) {
  const r = spawnSync(cmd, args, { env: TEX_ENV, encoding: "utf8" });
  if (r.error || r.status !== 0) throw new Error(`${cmd} is required for this test but cannot run (${r.error?.message ?? r.stderr})`);
}

export const FIXTURES = join(ENGINE_DIR, "test", "fixtures");

export function cases() {
  const dir = join(REPO_DIR, "tests", "fixtures", "v2");
  const list = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort().map((f) => ({ name: `fixture-${f.slice(0, -5)}`, yaml: join(dir, f) }));
  list.push({ name: "example", yaml: join(REPO_DIR, "examples", "cv.yaml") }, { name: "example-v1", yaml: join(REPO_DIR, "examples", "v1", "cv.yaml") });
  if (list.length < 3) throw new Error(`no fixtures found in ${dir}`);
  const own = readdirSync(FIXTURES).filter((d) => existsSync(join(FIXTURES, d, "cv.yaml"))).sort();
  if (own.length < 10) throw new Error(`the engine fixtures in ${FIXTURES} are missing`);
  for (const d of own) list.push({ name: `engine-${d}`, yaml: join(FIXTURES, d, "cv.yaml") });
  return list;
}

/** Builds a case with the CLI, both as a native PDF and as TeX sources. */
export function cliCase(c) {
  const dir = join(ARTIFACTS, c.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  const run = (args) => {
    const r = spawnSync(CV_TOOLS, args, { env: TEX_ENV, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`cv-tools ${args.join(" ")} failed:\n${r.stderr}${r.stdout}`);
  };
  run(["build", c.yaml, "--engine", "pdflatex", "-o", join(dir, "native.pdf")]);
  run(["build", c.yaml, "--tex-only", "-o", join(dir, "src", "cv.tex")]);
  const files = {};
  for (const f of readdirSync(join(dir, "src"))) files[f] = new Uint8Array(readFileSync(join(dir, "src", f)));
  if (!files["cv.tex"]) throw new Error(`cv-tools --tex-only wrote no cv.tex for ${c.name}`);
  return { dir, files, native: readFileSync(join(dir, "native.pdf")) };
}

export function texSources(c) {
  const dir = join(ARTIFACTS, "sources", c.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(CV_TOOLS, ["build", c.yaml, "--tex-only", "-o", join(dir, "cv.tex")], { env: TEX_ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cv-tools --tex-only failed for ${c.name}:\n${r.stderr}`);
  return Object.fromEntries(readdirSync(dir).map((f) => [f, new Uint8Array(readFileSync(join(dir, f)))]));
}

/** PDF pages as 150 dpi PPM buffers. */
export function rasterize(pdfPath, prefix) {
  execFileSync("pdftoppm", ["-r", "150", pdfPath, prefix]);
  const dir = prefix.slice(0, prefix.lastIndexOf("/"));
  const base = prefix.slice(prefix.lastIndexOf("/") + 1);
  return readdirSync(dir).filter((f) => f.startsWith(base + "-") && f.endsWith(".ppm")).sort().map((f) => readFileSync(join(dir, f)));
}

function ppm(buf) {
  const header = buf.subarray(0, 64).toString("latin1");
  const m = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(header);
  if (!m) throw new Error("not a binary PPM");
  return { w: +m[1], h: +m[2], data: buf.subarray(m[0].length) };
}

/** Infinity when the page sizes differ. */
export function differingPixels(a, b) {
  const pa = ppm(a);
  const pb = ppm(b);
  if (pa.w !== pb.w || pa.h !== pb.h) return Infinity;
  let n = 0;
  for (let i = 0; i < pa.data.length; i += 3) {
    if (pa.data[i] !== pb.data[i] || pa.data[i + 1] !== pb.data[i + 1] || pa.data[i + 2] !== pb.data[i + 2]) n++;
  }
  return n;
}

export function links(...pdfs) {
  const r = spawnSync(PYTHON, ["-I", join(ENGINE_DIR, "test", "links.py"), ...pdfs], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`links.py failed (Python ${PYTHON} needs pypdf):\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

export function bundleCopy(name, mutate = () => {}) {
  const dir = join(ARTIFACTS, "bundles", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(OUT_DIR, dir, { recursive: true });
  mutate(dir);
  return dir;
}

/** Replaces a bundle file and updates the manifest so it passes the integrity check. */
export function resign(dir, name, data, raw = null) {
  writeFileSync(join(dir, name), data);
  const path = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const entry = { name, bytes: data.length, sha256: sha256(data), ...(raw ? { rawBytes: raw.length, rawSha256: sha256(raw) } : {}) };
  const i = manifest.files.findIndex((f) => f.name === name);
  if (i === -1) manifest.files.push(entry);
  else manifest.files[i] = entry;
  manifest.version = sha256(manifest.files.map((f) => f.sha256).join("")).slice(0, 16);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Imports env.zzz, which the glue lacks, so instantiation throws a LinkError. */
export const LINK_ERROR_WASM = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 2, 11, 1, 3, 0x65, 0x6e, 0x76, 3, 0x7a, 0x7a, 0x7a, 0, 0]);

export function readCase(dir) {
  return Object.fromEntries(readdirSync(dir).map((f) => [f, new Uint8Array(readFileSync(join(dir, f)))]));
}
