import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEngine, loadAssets } from "../../src/tex/engine.ts";

export const ENGINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WEB_DIR = resolve(ENGINE_DIR, "..");
export const REPO_DIR = resolve(WEB_DIR, "..");
export const CACHE_DIR = join(ENGINE_DIR, ".cache");
export const OUT_DIR = join(WEB_DIR, "public", "engine");
export const LOCK = JSON.parse(readFileSync(join(ENGINE_DIR, "engine.lock.json"), "utf8"));
export const RELEASE_DIR = join(CACHE_DIR, "release", LOCK.tag);

/** 2026-01-01T00:00Z, the fixed date of builds and tests. */
export const EPOCH = 1767225600;

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export class Missing extends Error {}
export class Stale extends Error {}

export function releaseFile(name) {
  const want = LOCK.files[name];
  if (!want) throw new Error(`engine.lock.json pins no ${name}`);
  const path = join(RELEASE_DIR, name);
  if (!existsSync(path)) throw new Missing(`${path} is missing; run 'npm --prefix web/engine run fetch'`);
  const data = readFileSync(path);
  if (sha256(data) !== want) throw new Error(`${path} does not match its SHA256 in engine.lock.json; run fetch again`);
  return data;
}

const REBUILD = "rebuild the bundle with 'npm --prefix web/engine run build'";

/** Throws when the bundle is missing or stale; `lock: null` skips the staleness check. */
export function builtManifest(dir = OUT_DIR, { lock = LOCK } = {}) {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) throw new Missing(`${path} is missing; ${REBUILD}`);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  for (const f of manifest.files ?? []) {
    const p = join(dir, f.name);
    if (!existsSync(p)) throw new Missing(`${p} is missing; ${REBUILD}`);
  }
  if (lock) {
    const stale = (why) => new Stale(`the engine bundle in ${dir} is stale: ${why}; ${REBUILD}`);
    if (manifest.engine?.tag !== lock.tag) throw stale(`it was built for ${manifest.engine?.tag ?? "an unknown engine"}, engine.lock.json pins ${lock.tag}`);
    if (manifest.engine?.wasmSha256 !== lock.files["busytex.wasm"] || manifest.engine?.glueSha256 !== lock.files["busytex.js"]) {
      throw stale("its busytex.wasm or busytex.js is not the one engine.lock.json pins");
    }
    const wasm = manifest.files.find((f) => f.name === manifest.wasm);
    const want = wasm?.rawSha256 ?? wasm?.sha256;
    if (want !== lock.files["busytex.wasm"]) throw stale(`its manifest lists a ${manifest.wasm} that is not the pinned one`);
    if (!manifest.wasm.endsWith(".gz") && sha256(readFileSync(join(dir, manifest.wasm))) !== want) throw stale(`${manifest.wasm} on disk is not the pinned one`);
  }
  return manifest;
}

/** A fetch() that serves files from a local directory. */
export function fileFetch(dir, requests = null) {
  return async (url) => {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop());
    requests?.push(name);
    const path = join(dir, name);
    if (!existsSync(path)) return new Response(null, { status: 404 });
    return new Response(readFileSync(path));
  };
}

/** The engine over a bundle directory, loaded as the worker loads it. */
export async function nodeEngine(dir = OUT_DIR, { onProgress, sourceDateEpoch, requests, lock = dir === OUT_DIR ? LOCK : null } = {}) {
  builtManifest(dir, { lock });
  const baseUrl = pathToFileURL(dir).href + "/";
  const assets = await loadAssets({ baseUrl, fetch: fileFetch(dir, requests), onProgress });
  return createEngine(assets, { sourceDateEpoch });
}

export { createEngine, loadAssets };
