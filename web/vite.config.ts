/// <reference types="vitest/config" />
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { serviceWorker } from "./scripts/sw-plugin";
import { BASE, COFFEE, CSP, ENGINE_SOURCES_TAG_PREFIX, REPOSITORY, SCHEMA_URL, SITE_URL } from "./scripts/site.mjs";

const ROOT = import.meta.dirname;
const PUBLIC = resolve(ROOT, "public");

// The pdfTeX stand-in is opt-in (CV_TEX_STUB=1); the e2e tests reject it unless CV_E2E_ALLOW_STUB=1.
const useStub = process.env.CV_TEX_STUB === "1";

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** So a directory's URL changes with its content. */
function dirHash(dir: string): string {
  const h = createHash("sha256");
  for (const f of files(dir).sort()) h.update(relative(dir, f)).update("\0").update(readFileSync(f));
  return h.digest("hex").slice(0, 10);
}

function pyodideBytes(): number {
  return files(resolve(PUBLIC, "pyodide"))
    .filter((f) => !f.endsWith(".map"))
    .reduce((n, f) => n + statSync(f).size, 0);
}

/** Not in dev, where Vite injects inline styles and scripts. */
function contentSecurityPolicy(): Plugin {
  return {
    name: "cv-tools-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" }],
    },
  };
}

export default defineConfig(({ command }) => {
  const build = command === "build";
  // Content-named directories: an old page never gets a new build's files.
  const dirs = build
    ? { pyodide: `pyodide-${dirHash(resolve(PUBLIC, "pyodide"))}/`, engine: `engine-${dirHash(resolve(PUBLIC, "engine"))}/` }
    : { pyodide: "pyodide/", engine: "engine/" };
  return {
    base: BASE,
    resolve: { alias: { "@tex-client": resolve(ROOT, useStub ? "src/texStub.ts" : "src/tex/client.ts") } },
    define: {
      __TEX_STUB__: JSON.stringify(useStub),
      __PYODIDE_DIR__: JSON.stringify(dirs.pyodide),
      __ENGINE_DIR__: JSON.stringify(dirs.engine),
      __PYODIDE_BYTES__: JSON.stringify(build ? pyodideBytes() : 0),
      __SITE__: JSON.stringify({ url: SITE_URL, schemaUrl: SCHEMA_URL, repository: REPOSITORY, engineSourcesTagPrefix: ENGINE_SOURCES_TAG_PREFIX, coffee: COFFEE }),
    },
    worker: { format: "es" },
    build: {
      target: "es2022",
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        input: { main: resolve(ROOT, "index.html"), about: resolve(ROOT, "about.html") },
      },
    },
    plugins: [contentSecurityPolicy(), serviceWorker({ rename: { pyodide: dirs.pyodide, engine: dirs.engine } })],
    test: {
      include: ["test/unit/**/*.test.ts"],
      environment: "node",
      testTimeout: 60000,
    },
  };
});
