// Builds web/public/engine/licenses/ and its THIRD_PARTY.md.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_DIR, sha256 } from "./common.mjs";

const SITE = JSON.parse(readFileSync(join(ENGINE_DIR, "..", "site.config.json"), "utf8"));

/** The GitHub Release that engine-sources.yml publishes the engine's source to. */
export function sourcesRelease(tag) {
  const name = SITE.engineSourcesTagPrefix + tag;
  const base = `https://github.com/${SITE.repository}/releases`;
  return { tag: name, page: `${base}/tag/${name}`, asset: (file) => `${base}/download/${name}/${encodeURIComponent(file)}` };
}

export const LICENSES_DIR = join(ENGINE_DIR, "licenses");
export const COMPONENTS = JSON.parse(readFileSync(join(ENGINE_DIR, "components.json"), "utf8"));

/** Maps each file in tlpkg/texlive.tlpdb to its package. */
export function tlpdbPackages(tlpdbPath) {
  if (!tlpdbPath || !existsSync(tlpdbPath)) {
    throw new Error(
      `the TeX Live package database ${tlpdbPath || "(none)"} does not exist, so the licence table cannot be built. ` +
        "Use a TeX Live installed with TUG's install-tl; distribution packages (Debian, Ubuntu) do not ship it.",
    );
  }
  const byFile = new Map();
  let pkg = null;
  let inFiles = false;
  for (const line of readFileSync(tlpdbPath, "utf8").split("\n")) {
    if (line === "") {
      pkg = null;
      continue;
    }
    if (line.startsWith("name ")) {
      pkg = { name: line.slice(5), license: "", ctan: "" };
      inFiles = false;
    } else if (!pkg) {
      continue;
    } else if (line.startsWith("catalogue-license ")) pkg.license = line.slice(18);
    else if (line.startsWith("catalogue-ctan ")) pkg.ctan = line.slice(15);
    else if (line.startsWith("runfiles ")) inFiles = true;
    else if (line.startsWith(" ") && inFiles) byFile.set(line.trim().split(" ")[0], pkg);
    else inFiles = false;
  }
  if (byFile.size === 0) throw new Error(`${tlpdbPath} lists no files; it is not a TeX Live package database`);
  return byFile;
}

export function licenseFiles(dir = LICENSES_DIR) {
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  const files = new Map();
  for (const f of index.files) {
    const data = readFileSync(join(dir, f.file));
    if (sha256(data) !== f.sha256) throw new Error(`${join(dir, f.file)} does not match its SHA256 in licenses/index.json`);
    files.set(f.file, { data, from: f.from });
  }
  return files;
}

/** Marks each component `linked` when one of its markers is in the wasm. */
export function detectComponents(wasm, components = COMPONENTS.components) {
  const haystack = Buffer.isBuffer(wasm) ? wasm : Buffer.from(wasm);
  const out = components.map((c) => ({ ...c, linked: c.markers.length === 0 || c.markers.some((m) => haystack.includes(m)) }));
  const missing = out.filter((c) => c.required && !c.linked).map((c) => c.name);
  if (missing.length) throw new Error(`busytex.wasm does not contain ${missing.join(", ")}; update web/engine/components.json for this engine`);
  return out;
}

const FONT_FILE = /\.(tfm|pfb|otf|ttf|enc|vf|afm)$/;
// Written by install-tl, tlmgr or this build, so absent from the package database.
const GENERATED = /^texmf\.cnf$|^texmf-(var|config)\/|(^|\/)ls-R$/;
const CATALOGUE_TEXTS = [
  [/^lppl/, "texts/LPPL-1.3c.txt"],
  [/^gpl3/, "texts/GPL-3.0.txt"],
  [/^gpl/, "texts/GPL-2.0.txt"],
  [/^lgpl/, "texts/LGPL-2.1.txt"],
  [/^ofl/, "texts/OFL-1.1.txt"],
];

/** Groups bundled files by package; throws on an unknown file or a font without a licence. */
export function texPackages({ treeFiles, extraFiles, packagesByFile, fonts = COMPONENTS.fonts }) {
  const groups = new Map();
  const unknown = [];
  const add = (f, where) => {
    const pkg = packagesByFile.get(f);
    if (!pkg && !GENERATED.test(f)) unknown.push(f);
    const key = pkg ? pkg.name : "(generated)";
    if (!groups.has(key)) groups.set(key, { pkg, base: 0, extra: 0, fontFiles: 0 });
    const g = groups.get(key);
    g[where]++;
    if (FONT_FILE.test(f)) g.fontFiles++;
  };
  for (const f of treeFiles) add(f, "base");
  for (const f of extraFiles) add(f, "extra");
  if (unknown.length) {
    throw new Error(
      `${unknown.length} bundled file(s) are not in the TeX Live package database, for example ${unknown.slice(0, 3).join(", ")}; ` +
        "the licence table would be incomplete",
    );
  }
  const noFontLicence = [...groups].filter(([name, g]) => g.pkg && g.fontFiles && !fonts[name]).map(([name]) => name);
  if (noFontLicence.length) throw new Error(`no font licence for ${noFontLicence.join(", ")}; add it to "fonts" in web/engine/components.json`);
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, g]) => ({ name, ...g, font: g.fontFiles ? fonts[name] : null }));
}

const link = (file) => `[${file.replace(/^.*\//, "")}](${file})`;

export function thirdPartyMarkdown({ lock, versions, components, packages, treeYear, sources }) {
  const repo = `https://github.com/${lock.repo}`;
  const linked = components.filter((c) => c.linked);
  const lines = [
    "# Third-party components of the cv-tools web engine",
    "",
    "The cv-tools web app compiles CVs with pdfTeX compiled to WebAssembly.",
    "cv-tools' own code is MIT licensed. The engine and the TeX files below keep their own licences,",
    "whose full texts are in this directory. This file is generated by `web/engine/build-bundle.mjs`.",
    "",
    "## Engine (busytex.wasm, busytex.module.js)",
    "",
    `- Release: [${lock.tag}](${repo}/releases/tag/${lock.tag}), SHA256 of the archive \`${lock.archive.sha256}\``,
    `- Build scripts at commit [${lock.sourceCommit}](${repo}/tree/${lock.sourceCommit})`,
    `- ${lock.pdftex}`,
    "- Versions the release pins (`versions.txt`):",
    "",
    "```",
    versions.trim(),
    "```",
    "",
    "### Corresponding source",
    "",
    `The complete source of the engine is published with cv-tools, as the assets of the GitHub Release [${sourcesRelease(lock.tag).tag}](${sourcesRelease(lock.tag).page})`,
    "(with `SHA256SUMS` and `sources.json`). Each archive is also at its upstream URL:",
    "",
    "| Archive | Contents | SHA256 | Upstream |",
    "| --- | --- | --- | --- |",
    ...sources.map((s) => `| [${s.file}](${sourcesRelease(lock.tag).asset(s.file)}) | ${s.what} | \`${s.sha256}\` | [upstream](${s.url}) |`),
    "",
    "### Components linked into busytex.wasm",
    "",
    "| Component | Licence | Licence texts and notices | Source |",
    "| --- | --- | --- | --- |",
    ...linked.map((c) => `| ${c.name} | ${c.license} | ${[...(c.texts ?? []), ...(c.notices ?? [])].map(link).join(", ")} | ${c.source} |`),
    "",
    `## TeX files (texmf.tar.gz, texmf-extra.tar.gz, pdflatex.fmt), TeX Live ${treeYear}`,
    "",
    "`texmf.tar.gz` holds the files that cv-tools documents read. `texmf-extra.tar.gz`, which the",
    "engine downloads only when a document needs it, holds more Computer Modern fonts (cm-super).",
    "The format `pdflatex.fmt` is built from the LaTeX kernel and hyphenation files of the same",
    "TeX Live release and is counted with the bundle. A package's font files (metrics, Type 1 fonts,",
    "encodings) are under the font licence, the rest under the package licence of the TeX Catalogue.",
    "",
    "| Package | Package licence (TeX Catalogue) | Font licence | Files in the bundle | Files in the font pack | CTAN |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const p of packages) {
    const catalogue = p.pkg?.license || (p.pkg ? "see TeX Live" : "configuration written by the TeX Live installer (texmf.cnf, pdftexconfig.tex, fmtutil.cnf) and files this build generates (ls-R, the trimmed pdftex.map, language.dat); TeX Live's licence, LICENSE.TL");
    const text = CATALOGUE_TEXTS.find(([re]) => re.test(p.pkg?.license ?? ""))?.[1];
    const font = p.font ? `${p.font.license}${[...p.font.texts, ...p.font.notices].length ? ": " + [...p.font.texts, ...p.font.notices].map(link).join(", ") : ""}` : "";
    const ctan = p.pkg?.ctan ? `[ctan.org/pkg/${p.pkg.name}](https://ctan.org/pkg/${p.pkg.name})` : "";
    lines.push(`| ${p.name} | ${catalogue}${text ? ` (${link(text)})` : ""} | ${font} | ${p.base} | ${p.extra} | ${ctan} |`);
  }
  lines.push(
    "",
    "## Licence texts in this directory",
    "",
    "`texts/` holds the full licences (GPL-2.0, GPL-3.0, LGPL-2.1, LGPL-3.0, LPPL-1.3c, OFL-1.1) and `notices/`",
    "the copyright notices and permissive licences of individual components, each copied from the",
    "component's source (see `web/engine/licenses/index.json` in the cv-tools repository).",
    "`LICENSE.TL` and `LICENSE.CTAN` are TeX Live's own licence statements from the release.",
    "",
  );
  return lines.join("\n");
}
