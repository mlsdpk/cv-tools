#!/usr/bin/env node
// Writes Pyodide, the wheels, the example, the schema and the licences to web/public/ or $CV_ASSETS_OUT.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { woff2 } from "./woff2.mjs";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(WEB, "..");
const PUBLIC = process.env.CV_ASSETS_OUT ? resolve(process.env.CV_ASSETS_OUT) : join(WEB, "public");
const CACHE = join(WEB, ".cache");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const log = (...a) => console.log("[assets]", ...a);

function fresh(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

// Cached under web/.cache by the expected hash.
async function download(url, expected) {
  mkdirSync(CACHE, { recursive: true });
  const cached = join(CACHE, expected);
  if (existsSync(cached)) {
    const buf = readFileSync(cached);
    if (sha256(buf) === expected) return buf;
  }
  log("download", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== expected) throw new Error(`${url}: SHA256 ${got}, expected ${expected}`);
  writeFileSync(cached, buf);
  return buf;
}

/** Stored and deflated entries only. */
export function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out[name] = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function wheelLicenses(name, buf) {
  const files = readZip(buf);
  const texts = Object.entries(files)
    .filter(([f]) => /\.dist-info\/(licenses\/.*|LICEN[CS]E.*|COPYING.*)$/i.test(f))
    .map(([f, b]) => `==> ${f} <==\n${b.toString("utf8").trim()}\n`);
  if (texts.length) writeFileSync(join(PUBLIC, "licenses", "python", `${name}.txt`), texts.join("\n"));
  return texts.length > 0;
}

function wheelLicenseName(buf) {
  const files = readZip(buf);
  const meta = Object.entries(files).find(([f]) => /\.dist-info\/METADATA$/.test(f));
  if (!meta) return "";
  const text = meta[1].toString("utf8").split(/\r?\n\r?\n/)[0];
  const expr = /^License-Expression: (.+)$/m.exec(text);
  if (expr) return expr[1].trim();
  const lic = /^License: (.+)$/m.exec(text);
  if (lic && lic[1].length < 60) return lic[1].trim();
  const cls = /^Classifier: License :: (?:OSI Approved :: )?(.+)$/m.exec(text);
  return cls ? cls[1].trim() : "";
}

/** The reStructuredText section titled `title`, without trailing link targets. */
export function rstSection(text, title) {
  const lines = text.split(/\r?\n/);
  const isRule = (l) => /^([=\-~^*#+"'`])\1{2,}\s*$/.test(l ?? "");
  const isHeading = (i) => lines[i].trim() !== "" && !isRule(lines[i]) && isRule(lines[i + 1]);
  const levels = [];
  lines.forEach((_, i) => {
    if (isHeading(i) && !levels.includes(lines[i + 1][0])) levels.push(lines[i + 1][0]);
  });
  const start = lines.findIndex((l, i) => l.trim() === title && isHeading(i));
  if (start < 0) throw new Error(`no section "${title}"`);
  const level = levels.indexOf(lines[start + 1][0]);
  let end = start + 2;
  while (end < lines.length && !(isHeading(end) && levels.indexOf(lines[end + 1][0]) <= level)) end++;
  const body = lines.slice(start, end);
  while (body.length && (body[body.length - 1].trim() === "" || /^\.\. _[^:]+:\s*$/.test(body[body.length - 1]))) body.pop();
  return body.join("\n") + "\n";
}

export function leadingComment(text) {
  const m = /\/\*([\s\S]*?)\*\//.exec(text);
  if (!m) throw new Error("no /* */ comment");
  return m[1].split(/\r?\n/).map((l) => l.replace(/^\s*\*+ ?/, "").trimEnd()).join("\n").trim() + "\n";
}

/** Windows-platform strings of an OpenType name table, by nameID. */
export function otfNames(buf) {
  const tables = buf.readUInt16BE(4);
  for (let i = 0; i < tables; i++) {
    const rec = 12 + 16 * i;
    if (buf.toString("latin1", rec, rec + 4) !== "name") continue;
    const off = buf.readUInt32BE(rec + 8);
    const count = buf.readUInt16BE(off + 2);
    const strings = off + buf.readUInt16BE(off + 4);
    const names = {};
    for (let j = 0; j < count; j++) {
      const r = off + 6 + 12 * j;
      const [platform, , , id, len, at] = [0, 2, 4, 6, 8, 10].map((k) => buf.readUInt16BE(r + k));
      if (platform !== 3 || id in names) continue;
      names[id] = Buffer.from(buf.subarray(strings + at, strings + at + len)).swap16().toString("utf16le");
    }
    return names;
  }
  throw new Error("no name table");
}

/** Returns the `notices` list of assets.json. */
export async function writeLicenses(out) {
  const pins = JSON.parse(readFileSync(join(WEB, "scripts", "wheels.json"), "utf8"));
  const pyodideVersion = JSON.parse(readFileSync(join(WEB, "node_modules", "pyodide", "package.json"), "utf8")).version;
  const lock = JSON.parse(readFileSync(join(WEB, "node_modules", "pyodide", "pyodide-lock.json"), "utf8"));
  const { notices: core, fonts } = pins;
  if (core.pyodide !== pyodideVersion || core.python !== lock.info.python) {
    throw new Error(
      `wheels.json "notices" is for Pyodide ${core.pyodide} (Python ${core.python}), but Pyodide ${pyodideVersion} ` +
        `(Python ${lock.info.python}) is installed: review the libraries linked into its core and update the pins`,
    );
  }
  const dir = join(out, "licenses");
  mkdirSync(dir, { recursive: true });
  fresh(join(dir, "pyodide-core"));
  fresh(join(dir, "fonts"));
  const notices = [];
  const add = (component, license, file, group) => {
    if (!statSync(join(dir, file)).size) throw new Error(`${file} is empty`);
    notices.push({ component, license, file: `licenses/${file}`, group });
  };

  const own = readFileSync(join(REPO, "LICENSE"), "utf8");
  if (!/^MIT License/.test(own)) throw new Error("LICENSE is not the MIT licence");
  writeFileSync(join(dir, "cv-tools.txt"), own);
  add("cv-tools", "MIT", "cv-tools.txt", "cv-tools");

  // The npm package does not ship Pyodide's licence.
  writeFileSync(join(dir, "pyodide.txt"), await download(pins.pyodideLicense.url, pins.pyodideLicense.sha256));
  add(`Pyodide ${pyodideVersion}`, "MPL-2.0", "pyodide.txt", "python");
  for (const c of core.components) {
    const parts = [];
    for (const src of c.sources) {
      let text = (await download(src.url, src.sha256)).toString("utf8");
      if (src.rst) text = rstSection(text, src.rst);
      if (src.comment) text = leadingComment(text);
      parts.push(c.sources.length > 1 ? `==> ${src.url} <==\n${text.trim()}\n` : text);
    }
    writeFileSync(join(dir, c.file), parts.join("\n"));
    add(c.component, c.license, c.file, "python");
  }

  const cmu = readFileSync(join(WEB, "node_modules", fonts.cmUnicode.file));
  if (sha256(cmu) !== fonts.cmUnicode.sha256) throw new Error(`${fonts.cmUnicode.file}: SHA256 ${sha256(cmu)}, expected ${fonts.cmUnicode.sha256}`);
  writeFileSync(join(dir, "fonts", "cm-unicode-OFL.txt"), cmu);
  add("Computer Modern Unicode (cm-unicode)", "OFL-1.1", "fonts/cm-unicode-OFL.txt", "fonts");

  const fa = fonts.fontAwesome;
  const names = otfNames(await download(fa.font.url, fa.font.sha256));
  const ofl = (await download(fa.ofl.url, fa.ofl.sha256)).toString("utf8");
  if (!names[0]) throw new Error("FontAwesome.otf has no copyright string");
  writeFileSync(
    join(dir, "fonts", "FontAwesome-4-OFL.txt"),
    `Font Awesome 4 by ${names[9] ?? "Dave Gandy"}, ${names[11] ?? "http://fontawesome.io"}\n` +
      `FontAwesome.otf (${names[5] ?? "version unknown"}) of the fontawesome LaTeX package,\n${fa.font.url}\n\n` +
      `${names[0]}\n\n` +
      "This Font Software is licensed under the SIL Open Font License, Version 1.1.\n" +
      "This license is copied below, and is also available with a FAQ at:\nhttps://openfontlicense.org\n\n" +
      "-----------------------------------------------------------\n\n" +
      ofl,
  );
  add("FontAwesome 4", "OFL-1.1", "fonts/FontAwesome-4-OFL.txt", "fonts");

  const lmm = await latinModernMath();
  writeFileSync(join(dir, "fonts", "latinmodern-math-GUST.txt"), lmm.license);
  add("Latin Modern Math 1.959 (GUST e-foundry)", "LicenseRef-GUST-Font-License", "fonts/latinmodern-math-GUST.txt", "fonts");
  return notices;
}

async function latinModernMath() {
  const pin = JSON.parse(readFileSync(join(WEB, "scripts", "wheels.json"), "utf8")).fonts.latinModernMath;
  const files = readZip(await download(pin.url, pin.sha256));
  const font = files[pin.font];
  const license = files[pin.license];
  if (!font || sha256(font) !== pin.fontSha256) throw new Error(`${pin.font}: missing or not the pinned file`);
  if (!license || sha256(license) !== pin.licenseSha256) throw new Error(`${pin.license}: missing or not the pinned file`);
  return { font, license };
}

/** src/fonts.css loads this face only for FONT_RANGES. */
export async function writePreviewFonts(out) {
  fresh(join(out, "fonts"));
  const { font } = await latinModernMath();
  writeFileSync(join(out, "fonts", "latinmodern-math.woff2"), woff2(font));
}

function findWheel(dir) {
  const whl = readdirSync(dir).filter((f) => /^cv_tools-.*\.whl$/.test(f)).sort();
  return whl.length ? join(dir, whl[whl.length - 1]) : null;
}

// $CV_TOOLS_WHEEL (a file or a directory) wins; otherwise build with $CV_TOOLS_PYTHON, .venv or python3.
function cvToolsWheel() {
  const env = process.env.CV_TOOLS_WHEEL;
  if (env) {
    const path = statSync(env).isDirectory() ? findWheel(env) : env;
    if (!path) throw new Error(`CV_TOOLS_WHEEL=${env}: no cv_tools wheel found`);
    return path;
  }
  const python =
    process.env.CV_TOOLS_PYTHON ||
    [join(REPO, ".venv", "bin", "python"), join(REPO, ".venv", "Scripts", "python.exe")].find(existsSync) ||
    "python3";
  const out = mkdtempSync(join(tmpdir(), "cv-tools-wheel-"));
  log("build cv_tools wheel with", python);
  execFileSync(python, ["-m", "pip", "wheel", REPO, "-w", out, "--no-deps", "-q"], { stdio: "inherit" });
  const path = findWheel(out);
  if (!path) throw new Error("pip wheel produced no cv_tools wheel");
  return path;
}

async function main() {
  const pyodidePkg = JSON.parse(readFileSync(join(WEB, "node_modules", "pyodide", "package.json"), "utf8"));
  const version = pyodidePkg.version;
  const lock = JSON.parse(readFileSync(join(WEB, "node_modules", "pyodide", "pyodide-lock.json"), "utf8"));
  const pins = JSON.parse(readFileSync(join(WEB, "scripts", "wheels.json"), "utf8"));
  const pyDir = join(PUBLIC, "pyodide");
  fresh(pyDir);
  fresh(join(PUBLIC, "licenses"));
  mkdirSync(join(PUBLIC, "licenses", "python"), { recursive: true });
  mkdirSync(join(PUBLIC, "licenses", "npm"), { recursive: true });

  for (const f of ["pyodide.mjs", "pyodide.mjs.map", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip"]) {
    copyFileSync(join(WEB, "node_modules", "pyodide", f), join(pyDir, f));
  }

  const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, "-");
  const byName = new Map(Object.entries(lock.packages).map(([k, v]) => [norm(k), [k, v]]));
  const wanted = new Map();
  const visit = (name) => {
    const hit = byName.get(norm(name));
    if (!hit) throw new Error(`Pyodide ${version} has no package ${name}`);
    if (wanted.has(hit[0])) return;
    wanted.set(hit[0], hit[1]);
    hit[1].depends.forEach(visit);
  };
  pins.pyodide.forEach(visit);

  const licenses = [];
  const packages = {};
  for (const [key, pkg] of wanted) {
    const buf = await download(`https://cdn.jsdelivr.net/pyodide/v${version}/full/${pkg.file_name}`, pkg.sha256);
    writeFileSync(join(pyDir, pkg.file_name), buf);
    packages[key] = pkg;
    wheelLicenses(pkg.name, buf);
    licenses.push({ name: pkg.name, version: pkg.version, license: wheelLicenseName(buf), source: "Pyodide distribution" });
  }

  for (const w of pins.pypi) {
    const buf = await download(w.url, w.sha256);
    const file = w.url.split("/").pop();
    writeFileSync(join(pyDir, file), buf);
    packages[norm(w.name)] = {
      name: w.name, version: w.version, file_name: file, install_dir: "site", sha256: w.sha256,
      package_type: "package", imports: w.imports, depends: w.depends, unvendored_tests: false, tool: {},
    };
    wheelLicenses(w.name, buf);
    licenses.push({ name: w.name, version: w.version, license: wheelLicenseName(buf), source: "PyPI" });
  }

  const wheelPath = cvToolsWheel();
  const wheel = readFileSync(wheelPath);
  const wheelFile = wheelPath.split(/[\\/]/).pop();
  const cvVersion = wheelFile.split("-")[1];
  writeFileSync(join(pyDir, wheelFile), wheel);
  packages["cv-tools"] = {
    name: "cv-tools", version: cvVersion, file_name: wheelFile, install_dir: "site", sha256: sha256(wheel),
    package_type: "package", imports: ["cv_tools"],
    depends: ["pyyaml", "jinja2", "pybtex", "jsonschema", "ruamel-yaml", "latexcodec"], unvendored_tests: false, tool: {},
  };
  writeFileSync(join(pyDir, "pyodide-lock.json"), JSON.stringify({ info: lock.info, packages }, null, 1));

  const notices = await writeLicenses(PUBLIC);

  const npmPkgs = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8")).dependencies;
  const npm = [];
  const extra = ["@codemirror/autocomplete", "@lezer/common", "@lezer/highlight", "@lezer/lr", "@lezer/yaml", "style-mod", "w3c-keyname", "crelt"];
  for (const name of [...Object.keys(npmPkgs), ...extra]) {
    const dir = join(WEB, "node_modules", name);
    if (!existsSync(dir)) continue;
    const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const lic = readdirSync(dir).find((f) => /^(LICEN[CS]E|COPYING|OFL)/i.test(f));
    const file = name.replace("/", "__") + ".txt";
    if (lic) copyFileSync(join(dir, lic), join(PUBLIC, "licenses", "npm", file));
    if (!npm.some((p) => p.name === name)) npm.push({ name, version: meta.version, license: meta.license, file: lic ? file : null });
  }

  await writePreviewFonts(PUBLIC);
  fresh(join(PUBLIC, "example"));
  copyFileSync(join(REPO, "examples", "cv.yaml"), join(PUBLIC, "example", "cv.yaml"));
  for (const f of readdirSync(join(REPO, "examples")).filter((f) => f.endsWith(".bib"))) {
    copyFileSync(join(REPO, "examples", f), join(PUBLIC, "example", f));
  }
  fresh(join(PUBLIC, "schema"));
  copyFileSync(join(REPO, "src", "cv_tools", "schema", "cv-v2.schema.json"), join(PUBLIC, "schema", "v2.json"));

  const manifest = {
    pyodide: version,
    python: lock.info.python,
    cvTools: { version: cvVersion, file: wheelFile, sha256: sha256(wheel) },
    example: readdirSync(join(PUBLIC, "example")).sort(),
    python_packages: licenses.sort((a, b) => a.name.localeCompare(b.name)),
    npm_packages: npm.sort((a, b) => a.name.localeCompare(b.name)),
    notices,
  };
  writeFileSync(join(PUBLIC, "assets.json"), JSON.stringify(manifest, null, 1));
  const size = readdirSync(pyDir).reduce((n, f) => n + statSync(join(pyDir, f)).size, 0);
  log(`pyodide ${version} (Python ${lock.info.python}), ${Object.keys(packages).length} packages, ${(size / 1e6).toFixed(1)} MB`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
