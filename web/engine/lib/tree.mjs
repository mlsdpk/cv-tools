import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, posix } from "node:path";
import { gzipSync } from "node:zlib";
import { EPOCH } from "./common.mjs";

/** Installation trees only and a fixed date; mktex* would write into the cwd. */
export const ENV = {
  ...process.env,
  PATH: [process.env.TEXBIN, "/Library/TeX/texbin", process.env.PATH].filter(Boolean).join(delimiter),
  TEXMFHOME: "/nonexistent",
  TEXMFVAR: "/nonexistent",
  TEXMFCONFIG: "/nonexistent",
  MKTEXTFM: "0",
  MKTEXPK: "0",
  MKTEXTEX: "0",
  SOURCE_DATE_EPOCH: String(EPOCH),
  FORCE_SOURCE_DATE: "1",
};

export const tool = (cmd, args, opts = {}) => execFileSync(cmd, args, { env: ENV, encoding: "utf8", ...opts }).trim();
const kpseVar = (name) => tool("kpsewhich", [`-var-value=${name}`]);

const LAYOUT_HELP =
  "The engine bundle needs a TeX Live installed with TUG's install-tl (or TeX-Live/setup-texlive-action), " +
  "whose trees all live under one TEXMFROOT next to tlpkg/texlive.tlpdb. Distribution packages such as " +
  "Debian's or Ubuntu's texlive-* split the tree (/usr/share/texlive, /usr/share/texmf, /etc/texmf, " +
  "/var/lib/texmf) and leave out the package database, so neither the tree nor the licence table can be built from them.";

/** `vars` replaces kpsewhich in tests. */
export function texInfo(vars = null) {
  const get = vars ? (n) => vars[n] ?? "" : kpseVar;
  let version;
  if (vars) version = vars.version;
  else {
    try {
      version = tool("pdftex", ["--version"]).split("\n")[0];
    } catch {
      throw new Error("pdftex was not found; install TeX Live or set TEXBIN to its bin directory");
    }
  }
  const year = Number(/TeX Live (\d{4})/.exec(version)?.[1]);
  if (!year) throw new Error(`cannot read the TeX Live year from '${version}'`);
  const root = get("TEXMFROOT").replace(/\/$/, "");
  const tlpdb = join(root, "tlpkg", "texlive.tlpdb");
  if (!root || !existsSync(tlpdb)) throw new Error(`TeX Live at '${root}' has no tlpkg/texlive.tlpdb. ${LAYOUT_HELP}`);
  const real = (p) => (existsSync(p) ? realpathSync(p) : p);
  const dist = get("TEXMFDIST").replace(/\/$/, "");
  if (real(dist) !== real(join(root, "texmf-dist"))) {
    throw new Error(`TEXMFDIST is '${dist}', not '${root}/texmf-dist'. ${LAYOUT_HELP}`);
  }
  // Longest prefix first.
  const roots = [
    ["TEXMFROOT", ""], ["TEXMFDIST", "texmf-dist"], ["TEXMFSYSVAR", "texmf-var"],
    ["TEXMFSYSCONFIG", "texmf-config"], ["TEXMFLOCAL", "texmf-local"],
  ].flatMap(([v, target]) => {
    const value = get(v);
    if (!value || !existsSync(value)) return [];
    return [...new Set([value, realpathSync(value)])].map((p) => [p.replace(/\/$/, ""), target]);
  }).sort((a, b) => b[0].length - a[0].length);
  return { version, year, roots, root, tlpdb };
}

export function treePath(tex, file) {
  for (const [prefix, target] of tex.roots) {
    if (file.startsWith(prefix + "/")) return posix.join(target, file.slice(prefix.length + 1));
  }
  return null;
}

export function mapTree(tex, files) {
  const out = new Map();
  const outside = [];
  for (const f of files) {
    const rel = treePath(tex, f);
    if (rel === null) outside.push(f);
    else out.set(rel, f);
  }
  if (outside.length) {
    throw new Error(
      `${outside.length} file(s) TeX read are outside the TeX Live trees (${tex.roots.map((r) => r[0]).join(", ")}), ` +
        `for example ${outside.slice(0, 3).join(", ")}. ${LAYOUT_HELP}`,
    );
  }
  return out;
}

/** Runs a TeX command with -recorder and returns the files it read. */
export async function recorded(dir, cmd, args, job) {
  const r = await new Promise((resolve, reject) => {
    const child = spawn(cmd, ["-recorder", ...args], { cwd: dir, env: ENV, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, out }));
  });
  const log = existsSync(join(dir, `${job}.log`)) ? readFileSync(join(dir, `${job}.log`), "latin1") : r.out;
  if (r.status !== 0) {
    const errs = log.split("\n").flatMap((l, i, a) => (l.startsWith("!") ? a.slice(i, i + 4) : []));
    throw new Error(`${cmd} failed in ${dir}:\n${(errs.length ? errs : log.split("\n").slice(-20)).join("\n")}`);
  }
  const inputs = new Set();
  for (const line of readFileSync(join(dir, `${job}.fls`), "utf8").split("\n")) {
    if (!line.startsWith("INPUT ")) continue;
    const f = line.slice(6);
    if (isAbsolute(f) && !f.startsWith(dir + "/") && statSync(f).isFile()) inputs.add(f);
  }
  return inputs;
}

export function trimMap(text, tfms) {
  const keep = [];
  const files = new Set();
  for (const line of text.split("\n")) {
    const t = line.trim().split(/\s+/);
    if (!t[0] || line.startsWith("%") || line.startsWith("#") || !tfms.has(t[0])) continue;
    keep.push(line);
    for (const tok of t.slice(1)) {
      const m = /^<+\[?(.+)$/.exec(tok);
      if (m) files.add(m[1]);
    }
  }
  return { text: keep.join("\n") + "\n", files };
}

export function kpseFind(names) {
  const found = new Map();
  if (!names.length) return found;
  const out = spawnSync("kpsewhich", names, { env: ENV, encoding: "utf8", maxBuffer: 64 << 20 }).stdout;
  for (const p of out.split("\n").filter(Boolean)) found.set(basename(p), p);
  const missing = names.filter((n) => !found.has(n));
  if (missing.length) throw new Error(`kpsewhich cannot find ${missing.join(", ")}`);
  return found;
}

/** English stays language 0 as in the full format, so line breaks match. */
export function englishOnly(text) {
  const keep = new Set(["english", "dumylang", "nohyphenation"]);
  let current = null;
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("%")) continue;
    if (!line.startsWith("=")) current = line.split(/\s+/)[0];
    if (keep.has(current)) out.push(line);
  }
  if (!out.length || !out[0].startsWith("english")) throw new Error("language.dat does not start with english");
  return out.join("\n") + "\n";
}

export function lsR(paths, top) {
  const dirs = new Map([["", new Set()]]);
  for (const p of paths) {
    if (!p.startsWith(top + "/")) continue;
    const parts = p.slice(top.length + 1).split("/");
    for (let i = 0; i < parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      if (!dirs.has(d)) dirs.set(d, new Set());
      dirs.get(d).add(parts[i]);
    }
  }
  dirs.get("").add("ls-R");
  const lines = ["% ls-R -- filename database for kpathsea; do not change this line."];
  for (const d of [...dirs.keys()].sort()) lines.push(d ? `./${d}:` : "./:", ...[...dirs.get(d)].sort(), "");
  return Buffer.from(lines.join("\n") + "\n");
}

export function addLsR(tree) {
  const tops = new Set(["texmf-dist", "texmf-var", "texmf-config"]);
  for (const p of tree.keys()) if (p.startsWith("texmf-local/")) tops.add("texmf-local");
  const paths = [...tree.keys()];
  for (const top of tops) tree.set(`${top}/ls-R`, lsR(paths, top));
}

/** Reproducible ustar: fixed owner, mode and date, sorted paths. */
export function tar(tree) {
  const blocks = [];
  for (const [path, data] of [...tree].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const h = Buffer.alloc(512);
    let name = path;
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const cut = path.lastIndexOf("/");
      prefix = path.slice(0, cut);
      name = path.slice(cut + 1);
      if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`path too long for tar: ${path}`);
    }
    h.write(name, 0);
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    h.write(prefix, 345);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** Clears the OS byte so every platform writes the same bytes. */
export function gzip(data) {
  const gz = gzipSync(data, { level: 9 });
  gz[9] = 0xff;
  return gz;
}

// Hiding the runtime globals makes the glue take its worker path everywhere. The
// unref'd setInterval stops its dependency watcher keeping Node alive after a failed start.
export function glueModule(glue, { tag, sha256 }) {
  return [
    `// The Emscripten glue of busytex ${tag} (busytex.js, SHA256 ${sha256}),`,
    "// wrapped as an ES module by web/engine/build-bundle.mjs. Do not edit.",
    "const unrefInterval = (f, ms, ...args) => {",
    "  const id = globalThis.setInterval(f, ms, ...args);",
    '  if (id && typeof id === "object" && typeof id.unref === "function") id.unref();',
    "  return id;",
    "};",
    "const busytexFactory = ((importScripts, process, window, document, self, module, exports, define, require, __filename, setInterval) => {",
    glue.replace(/\s+$/, ""),
    "return busytex;",
    "})(function () {}, undefined, undefined, undefined, { location: { href: import.meta.url } }, undefined, undefined, undefined, undefined, undefined, unrefInterval);",
    "export default busytexFactory;",
    "",
  ].join("\n");
}
