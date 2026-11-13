// Usage: node mirror-sources.mjs <dir> [--lock <engine.lock.json>]
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LOCK } from "./lib/common.mjs";

async function fileSha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function download(source, dest) {
  const part = dest + ".part";
  try {
    const res = await fetch(source.url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const hash = createHash("sha256");
    await pipeline(Readable.fromWeb(res.body).on("data", (chunk) => hash.update(chunk)), createWriteStream(part));
    const got = hash.digest("hex");
    if (got !== source.sha256) throw new Error(`SHA256 ${got}, engine.lock.json pins ${source.sha256}`);
    renameSync(part, dest);
  } catch (e) {
    rmSync(part, { force: true });
    throw new Error(`cannot mirror ${source.name} from ${source.url}: ${e.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--lock");
  const lock = at === -1 ? LOCK : JSON.parse(readFileSync(args.splice(at, 2)[1], "utf8"));
  const dir = args[0];
  if (!dir || !lock.sources?.length) throw new Error("usage: node mirror-sources.mjs <dir> [--lock <engine.lock.json with sources>]");
  const out = resolve(dir);
  mkdirSync(out, { recursive: true });
  for (const s of lock.sources) {
    const dest = join(out, s.file);
    if (existsSync(dest) && (await fileSha256(dest)) === s.sha256) {
      console.log(`mirror-sources: ${s.file} is up to date`);
      continue;
    }
    console.log(`mirror-sources: downloading ${s.url}`);
    await download(s, dest);
  }
  writeFileSync(join(out, "SHA256SUMS"), lock.sources.map((s) => `${s.sha256}  ${s.file}\n`).join(""));
  writeFileSync(
    join(out, "sources.json"),
    JSON.stringify({ tag: lock.tag, sourceCommit: lock.sourceCommit, archives: lock.sources }, null, 2) + "\n",
  );
  const total = lock.sources.reduce((n, s) => n + s.bytes, 0);
  console.log(`mirror-sources: ${lock.sources.length} archives (${(total / 2 ** 20).toFixed(1)} MiB) in ${out}`);
}

main().catch((e) => {
  console.error(`mirror-sources: ${e.message}`);
  process.exit(1);
});
