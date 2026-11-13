// Versions the asset directories, stamps each page with the build id and writes dist/sw.js.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Plugin, ResolvedConfig } from "vite";

/** Never cached by the service worker. */
export const SKIP = /(\.map|\.woff|\.DS_Store)$|^licenses\/|^engine[^/]*\/(licenses|sources)\/|^sw\.js$|^test\//;
/** Precached in the background after the app has loaded. */
export const LAZY = /^(engine[^/]*\/|pyodide[^/]*\/|assets\/pdf\.worker|fonts\/latinmodern-math)/;
/** Cached on first use only, since most CVs never need them. */
export const NO_WARM = /^engine[^/]*\/texmf-extra\.tar\.gz$|^fonts\/latinmodern-math\.woff2$/;

export interface ManifestEntry {
  url: string;
  rev: string;
  /** Hash of a .gz file's content, since a server may send it with Content-Encoding: gzip. */
  rawRev?: string;
  lazy: boolean;
  warm: boolean;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export function finishSite(out: string, template: string, rename: Record<string, string> = {}): { build: string; manifest: ManifestEntry[] } {
  for (const [from, to] of Object.entries(rename)) {
    const target = to.replace(/\/$/, "");
    if (target !== from && existsSync(join(out, from))) renameSync(join(out, from), join(out, target));
  }
  const rels = walk(out)
    .map((p) => relative(out, p).split("\\").join("/"))
    .filter((rel) => !SKIP.test(rel))
    .sort();
  const pages = rels.filter((r) => /^[^/]+\.html$/.test(r));
  const entry = (rel: string): ManifestEntry => {
    const data = readFileSync(join(out, rel));
    const e: ManifestEntry = { url: rel === "index.html" ? "./" : rel, rev: sha(data).slice(0, 16), lazy: LAZY.test(rel), warm: !NO_WARM.test(rel) };
    if (rel.endsWith(".gz")) e.rawRev = sha(gunzipSync(data)).slice(0, 16);
    return e;
  };
  const assets = rels.filter((r) => !pages.includes(r)).map(entry);
  const unstamped = (p: string) => readFileSync(join(out, p), "utf8").replace(/\n\s*<meta name="cv-build"[^>]*>/g, "");
  const build = sha(JSON.stringify(assets) + pages.map(unstamped).join("\0")).slice(0, 12);
  for (const p of pages) {
    const file = join(out, p);
    const html = readFileSync(file, "utf8").replace(/\n\s*<meta name="cv-build"[^>]*>/g, "");
    writeFileSync(file, html.replace(/<head>/i, `<head>\n    <meta name="cv-build" content="${build}" />`));
  }
  const manifest = [...assets, ...pages.map(entry)].sort((a, b) => a.url.localeCompare(b.url));
  writeFileSync(join(out, "sw.js"), template.replace("self.__MANIFEST__", JSON.stringify(manifest)).replace("self.__BUILD__", JSON.stringify(build)));
  return { build, manifest };
}

export function serviceWorker(options: { rename?: Record<string, string> } = {}): Plugin {
  let config: ResolvedConfig;
  return {
    name: "cv-tools-service-worker",
    apply: "build",
    configResolved(c) {
      config = c;
    },
    closeBundle() {
      const out = resolve(config.root, config.build.outDir);
      finishSite(out, readFileSync(resolve(config.root, "src/sw.js"), "utf8"), options.rename);
    },
  };
}
