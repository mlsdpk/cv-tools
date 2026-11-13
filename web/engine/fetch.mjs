// Usage: node fetch.mjs [--force]
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import { CACHE_DIR, LOCK, RELEASE_DIR, sha256 } from "./lib/common.mjs";
import { untar } from "../src/tex/engine.ts";

const force = process.argv.includes("--force");
const names = Object.keys(LOCK.files);

function cached() {
  return names.every((n) => {
    const p = join(RELEASE_DIR, n);
    return existsSync(p) && sha256(readFileSync(p)) === LOCK.files[n];
  });
}

async function download(dest) {
  const errors = [];
  for (const url of LOCK.archive.urls) {
    const part = dest + ".part";
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const hash = createHash("sha256");
      const counted = Readable.fromWeb(res.body).on("data", (chunk) => hash.update(chunk));
      await pipeline(counted, createWriteStream(part));
      const got = hash.digest("hex");
      if (got !== LOCK.archive.sha256) throw new Error(`SHA256 ${got}, expected ${LOCK.archive.sha256}`);
      renameSync(part, dest);
      console.log(`fetch: downloaded ${url}`);
      return;
    } catch (e) {
      rmSync(part, { force: true });
      errors.push(`${url}: ${e.message}`);
    }
  }
  throw new Error(`cannot download ${LOCK.archive.name}:\n  ${errors.join("\n  ")}`);
}

async function main() {
  if (!force && cached()) {
    console.log(`fetch: ${LOCK.tag} is in ${RELEASE_DIR}`);
    return;
  }
  const dlDir = join(CACHE_DIR, "download");
  mkdirSync(dlDir, { recursive: true });
  const archive = join(dlDir, LOCK.archive.name);
  if (force || !existsSync(archive) || sha256(readFileSync(archive)) !== LOCK.archive.sha256) {
    rmSync(archive, { force: true });
    await download(archive);
  }
  const top = `${LOCK.tag}/`;
  const found = new Map();
  for (const [path, data] of untar(gunzipSync(readFileSync(archive)))) {
    const name = path.startsWith(top) ? path.slice(top.length) : null;
    if (name && names.includes(name)) found.set(name, data);
  }
  rmSync(RELEASE_DIR, { recursive: true, force: true });
  mkdirSync(RELEASE_DIR, { recursive: true });
  for (const name of names) {
    const data = found.get(name);
    if (!data) throw new Error(`${LOCK.archive.name} has no ${top}${name}`);
    if (sha256(data) !== LOCK.files[name]) throw new Error(`${name} in the archive does not match engine.lock.json`);
    writeFileSync(join(RELEASE_DIR, name), data);
  }
  console.log(`fetch: extracted ${names.join(", ")} into ${RELEASE_DIR}`);
}

main().catch((e) => {
  console.error(`fetch: ${e.message}`);
  process.exit(1);
});
