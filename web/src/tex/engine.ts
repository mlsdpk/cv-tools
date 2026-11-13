// pdfTeX in WebAssembly, shared by the tex worker and Node. Erasable TypeScript only, so Node runs it without a build.

/** The `manifest.json` that web/engine/build-bundle.mjs writes next to the assets. */
export interface Manifest {
  version: string;
  engine: { repo: string; tag: string; sourceCommit: string; pdftex: string; texliveYear: number };
  tree: { texliveYear: number; pdftex: string; files: number };
  glue: string;
  wasm: string;
  /** The font pack, fetched only when a compilation needs one of its files. */
  extras?: { pack: string; index: string };
  files: ManifestFile[];
}

export interface ManifestFile {
  name: string;
  bytes: number;
  sha256: string;
  rawBytes?: number;
  /** For a `.gz` file, the SHA256 after decompression, which the loader checks. */
  rawSha256?: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** `manifest`, then `download` while the files arrive, then `start`; `extras` while the font pack arrives. */
export type Stage = "manifest" | "download" | "start" | "extras";

export interface Progress {
  stage: Stage;
  loaded: number;
  total: number;
}

export interface LoadOptions {
  /** The directory of manifest.json, ending with a slash. */
  baseUrl: string;
  fetch?: FetchLike;
  importModule?: (url: string) => Promise<{ default: unknown }>;
  onProgress?: (p: Progress) => void;
}

/** Fetches the optional font pack (texmf-extra.tar.gz) on demand. */
export interface ExtrasSource {
  /** Base names of the files in the pack. */
  index(): Promise<Set<string>>;
  /** The pack's files, relative to the tree root, checked against the manifest. */
  load(onProgress?: (p: Progress) => void): Promise<Array<[string, Uint8Array]>>;
}

/** Everything an engine needs, downloaded, checked and decompressed. */
export interface Assets {
  manifest: Manifest;
  /** The Emscripten module factory from the glue. */
  factory: Factory;
  wasm: WebAssembly.Module;
  /** Files of the texmf tree, relative to the tree root (`texmf-dist/...`). */
  texmf: Array<[string, Uint8Array]>;
  format: Uint8Array;
  extras?: ExtrasSource;
}

export interface EngineOptions {
  /** Fixes `\today` and the PDF dates, as SOURCE_DATE_EPOCH does for the CLI; default the clock. */
  sourceDateEpoch?: number;
}

export interface CompileOptions {
  /** Another epoch than the live instance's replaces the instance (libc reads the environment once). */
  sourceDateEpoch?: number;
  main?: string;
  /** Reports the download of the font pack when this compilation needs it. */
  onProgress?: (p: Progress) => void;
}

export interface CompileResult {
  pdf: Uint8Array;
  log: string;
  /** Milliseconds in pdflatex (the last run when the font pack was loaded). */
  ms: number;
  extrasLoaded: boolean;
}

/** pdflatex reported an error in the document. `message` names it; `log` is the full TeX log. */
export class TexError extends Error {
  log: string;
  constructor(message: string, log: string) {
    super(message);
    this.name = "TexError";
    this.log = log;
  }
}

/** A failure of the engine itself; `missing-file`: a TeX file neither the bundle nor the font pack holds. */
export type EngineErrorCode = "download" | "integrity" | "start" | "crash" | "missing-file";

export class EngineError extends Error {
  code: EngineErrorCode;
  log: string;
  /** For `missing-file`: the files TeX could not find. */
  files: string[];
  constructor(code: EngineErrorCode, message: string, log = "", files: string[] = []) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.log = log;
    this.files = files;
  }
}

/** pdflatex arguments, the same as cv-tools' PDFLATEX_ARGS. */
export const PDFLATEX_FLAGS = ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error"];

const TEXLIVE = "/texlive";
const FORMAT = "/pdflatex.fmt";
const BASE_ENV: Record<string, string> = {
  TEXMFROOT: TEXLIVE,
  TEXMFDIST: `${TEXLIVE}/texmf-dist`,
  TEXMFSYSVAR: `${TEXLIVE}/texmf-var`,
  TEXMFSYSCONFIG: `${TEXLIVE}/texmf-config`,
  TEXMFVAR: `${TEXLIVE}/texmf-var`,
  TEXMFCONFIG: `${TEXLIVE}/texmf-config`,
  TEXMFLOCAL: `${TEXLIVE}/texmf-local`,
  TEXMFHOME: "/nonexistent",
  TEXMFCNF: `${TEXLIVE}:${TEXLIVE}/texmf-dist/web2c`,
  MKTEXTFM: "0",
  MKTEXPK: "0",
  MKTEXTEX: "0",
  MKTEXFMT: "0",
};

// ---------------------------------------------------------------------------
// Loading

function fileInfo(manifest: Manifest, name: string): ManifestFile {
  const f = manifest.files.find((x) => x.name === name);
  if (!f) throw new EngineError("integrity", `the engine manifest lists no ${name}; rebuild the engine bundle`);
  return f;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

async function verify(name: string, data: Uint8Array, want: string | undefined): Promise<void> {
  if (!want) throw new EngineError("integrity", `the engine manifest gives no SHA256 for ${name}; rebuild the engine bundle`);
  const got = await sha256Hex(data);
  if (got !== want) {
    throw new EngineError(
      "integrity",
      `the engine file ${name} is damaged or out of date (SHA256 ${got.slice(0, 12)}..., the manifest expects ${want.slice(0, 12)}...). ` +
        "Reload the page; if this persists, the site's engine files are broken.",
    );
  }
}

const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

/** A `.gz` asset, inflated up to twice, since some browsers keep the gzip encoding of a `.gz` URL. */
async function gunzipIfNeeded(name: string, raw: Uint8Array): Promise<Uint8Array> {
  let data = raw;
  for (let layer = 0; layer < 2 && isGzip(data); layer++) {
    try {
      data = await bytesOf(new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")));
    } catch (e) {
      throw new EngineError("integrity", `the engine file ${name} is damaged: it does not decompress (${String(e)})`);
    }
  }
  return data;
}

export async function loadAssets(options: LoadOptions): Promise<Assets> {
  const get: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const importModule = options.importModule ?? ((url: string) => import(/* @vite-ignore */ url));
  const base = options.baseUrl.endsWith("/") ? options.baseUrl : options.baseUrl + "/";
  const report = options.onProgress ?? (() => {});
  const fetchOk = async (name: string, query = "", init?: RequestInit): Promise<Response> => {
    let r: Response;
    try {
      r = await get(base + name + query, init);
    } catch (e) {
      throw new EngineError("download", `cannot download ${base + name}: ${String(e)}`);
    }
    if (!r.ok || !r.body) throw new EngineError("download", `cannot download ${base + name} (HTTP ${r.status})`);
    return r;
  };

  report({ stage: "manifest", loaded: 0, total: 0 });
  // The manifest names the current files and their hashes, so it is always revalidated.
  let manifest: Manifest;
  try {
    manifest = (await (await fetchOk("manifest.json", "", { cache: "no-cache" })).json()) as Manifest;
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw new EngineError("integrity", `the engine manifest ${base}manifest.json is not valid JSON (${String(e)})`);
  }
  if (!manifest.glue || !manifest.wasm || !Array.isArray(manifest.files)) {
    throw new EngineError("integrity", "the engine manifest is from an older build; rebuild the engine bundle");
  }
  const q = `?v=${manifest.version}`;
  const glueInfo = fileInfo(manifest, manifest.glue);
  const wasmInfo = fileInfo(manifest, manifest.wasm);
  const texmfInfo = fileInfo(manifest, "texmf.tar.gz");
  const formatInfo = fileInfo(manifest, "pdflatex.fmt");
  const total = glueInfo.bytes + (wasmInfo.rawBytes ?? wasmInfo.bytes) + (texmfInfo.rawBytes ?? 0) + formatInfo.bytes;
  let loaded = 0;
  const counter = () =>
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        loaded += chunk.byteLength;
        report({ stage: "download", loaded, total });
        ctl.enqueue(chunk);
      },
    });
  const counted = (bytes: Uint8Array): Uint8Array => {
    loaded += bytes.byteLength;
    report({ stage: "download", loaded, total });
    return bytes;
  };

  // Checked, then imported from the same URL: a strict CSP forbids importing bytes (eval, blob: URLs).
  const factoryP = fetchOk(manifest.glue, q)
    .then((r) => bytesOf(r.body!.pipeThrough(counter())))
    .then((b) => verify(manifest.glue, b, glueInfo.sha256))
    .then(async () => {
      let mod: { default: unknown };
      try {
        mod = await importModule(base + manifest.glue + q);
      } catch (e) {
        throw new EngineError("start", `cannot load the engine glue ${manifest.glue}: ${String(e)}`);
      }
      if (typeof mod.default !== "function") throw new EngineError("integrity", `${manifest.glue} does not export the busytex factory`);
      return mod.default as Factory;
    });

  // A plain .wasm compiles while it downloads and is used only when its hash matches.
  const wasmP = fetchOk(manifest.wasm, q).then(async (r) => {
    if (manifest.wasm.endsWith(".gz")) {
      const bytes = counted(await gunzipIfNeeded(manifest.wasm, await bytesOf(r.body!)));
      await verify(manifest.wasm, bytes, wasmInfo.rawSha256);
      return compileWasm(bytes);
    }
    const [forCompile, forHash] = r.body!.pipeThrough(counter()).tee();
    const compiled = WebAssembly.compileStreaming(new Response(forCompile, { headers: { "Content-Type": "application/wasm" } })).then(
      (m) => ({ m, e: null as unknown }),
      (e: unknown) => ({ m: null, e }),
    );
    await verify(manifest.wasm, await bytesOf(forHash), wasmInfo.sha256);
    const c = await compiled;
    if (!c.m) throw new EngineError("start", `cannot compile ${manifest.wasm}: ${String(c.e)}`);
    return c.m;
  });

  const texmfP = fetchOk("texmf.tar.gz", q)
    .then((r) => bytesOf(r.body!))
    .then((gz) => gunzipIfNeeded("texmf.tar.gz", gz))
    .then(async (tar) => {
      await verify("texmf.tar.gz", counted(tar), texmfInfo.rawSha256);
      return untarChecked("texmf.tar.gz", tar);
    });
  const formatP = fetchOk("pdflatex.fmt", q)
    .then((r) => bytesOf(r.body!.pipeThrough(counter())))
    .then(async (b) => {
      await verify("pdflatex.fmt", b, formatInfo.sha256);
      return b;
    });

  const [factory, wasm, texmf, format] = await Promise.all([factoryP, wasmP, texmfP, formatP]);
  report({ stage: "start", loaded: total, total });
  return { manifest, factory, wasm, texmf, format, extras: manifest.extras ? extrasSource(manifest, q, fetchOk) : undefined };
}

function extrasSource(
  manifest: Manifest,
  q: string,
  fetchOk: (name: string, query?: string, init?: RequestInit) => Promise<Response>,
): ExtrasSource {
  const { pack, index } = manifest.extras!;
  // Same origin as the rest of the bundle: both names are plain file names in the bundle directory.
  for (const n of [pack, index]) {
    if (n.includes("/") || n.includes(":")) throw new EngineError("integrity", `the engine manifest names an extras file outside the bundle: ${n}`);
  }
  let names: Promise<Set<string>> | null = null;
  let files: Promise<Array<[string, Uint8Array]>> | null = null;
  return {
    index() {
      names ??= fetchOk(index, q)
        .then((r) => bytesOf(r.body!))
        .then(async (b) => {
          await verify(index, b, fileInfo(manifest, index).sha256);
          return new Set((JSON.parse(new TextDecoder().decode(b)) as { files: string[] }).files);
        })
        .catch((e: unknown) => {
          names = null;
          throw e;
        });
      return names;
    },
    load(onProgress) {
      const info = fileInfo(manifest, pack);
      files ??= fetchOk(pack, q)
        .then(async (r) => {
          const total = info.rawBytes ?? info.bytes;
          let loaded = 0;
          const tar = await gunzipIfNeeded(
            pack,
            await bytesOf(
              r.body!.pipeThrough(
                new TransformStream<Uint8Array, Uint8Array>({
                  transform(chunk, ctl) {
                    loaded += chunk.byteLength;
                    onProgress?.({ stage: "extras", loaded: Math.min(loaded, total), total });
                    ctl.enqueue(chunk);
                  },
                }),
              ),
            ),
          );
          await verify(pack, tar, info.rawSha256);
          onProgress?.({ stage: "extras", loaded: total, total });
          return untarChecked(pack, tar);
        })
        .catch((e: unknown) => {
          files = null;
          throw e;
        });
      return files;
    },
  };
}

async function compileWasm(bytes: Uint8Array): Promise<WebAssembly.Module> {
  try {
    return await WebAssembly.compile(bytes as BufferSource);
  } catch (e) {
    throw new EngineError("start", `cannot compile the engine's WebAssembly: ${String(e)}`);
  }
}

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function untarChecked(name: string, tar: Uint8Array): Array<[string, Uint8Array]> {
  try {
    return untar(tar);
  } catch (e) {
    throw new EngineError("integrity", `the engine file ${name} is damaged: ${(e as Error).message}`);
  }
}

/** The regular files of a tar archive. Throws on a bad checksum or a truncated archive. */
export function untar(tar: Uint8Array): Array<[string, Uint8Array]> {
  const out: Array<[string, Uint8Array]> = [];
  const dec = new TextDecoder();
  const field = (off: number, len: number): string => {
    const raw = tar.subarray(off, off + len);
    const end = raw.indexOf(0);
    return dec.decode(end === -1 ? raw : raw.subarray(0, end));
  };
  let longName: string | null = null;
  let off = 0;
  for (;;) {
    if (off + 512 > tar.length) throw new Error(`the tar archive ends at byte ${tar.length} without an end-of-archive block`);
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    const want = parseInt(field(off + 148, 8).trim() || "-1", 8);
    if (sum !== want) throw new Error(`bad tar header checksum at byte ${off}`);
    const name = field(off, 100);
    const size = parseInt(field(off + 124, 12).trim() || "0", 8);
    const type = field(off + 156, 1);
    const prefix = field(off + 345, 155);
    if (!(size >= 0) || off + 512 + size > tar.length) throw new Error(`the tar entry ${name} runs past the end of the archive`);
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = dec.decode(data).replace(/\0+$/, "");
      continue;
    }
    const path = (longName ?? (prefix ? `${prefix}/${name}` : name)).replace(/^\.\//, "");
    longName = null;
    if (type === "0" || type === "") out.push([path, data]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Running

interface FSStream {
  fd: number;
}

interface EmscriptenFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string): Uint8Array;
  readFile(path: string, opts: { encoding: "utf8" }): string;
  readdir(path: string): string[];
  unlink(path: string): void;
  rmdir(path: string): void;
  chdir(path: string): void;
  close(stream: FSStream): void;
  isDir(mode: number): boolean;
  stat(path: string): { mode: number };
  analyzePath(path: string): { exists: boolean };
  streams: Array<FSStream | null | undefined>;
}

interface WasmExports {
  stackSave(): number;
  stackRestore(sp: number): void;
}

interface EmscriptenModule {
  FS: EmscriptenFS;
  HEAPU8: Uint8Array;
  ENV: Record<string, string | undefined>;
  asm: WasmExports;
  callMain(args: string[]): number;
}

/** The busytex module factory that the glue (busytex.module.js) exports. */
export type Factory = (opts: Record<string, unknown>) => Promise<EmscriptenModule>;

function mkdirp(FS: EmscriptenFS, path: string): void {
  let cur = "";
  for (const part of path.split("/").filter(Boolean)) {
    cur += "/" + part;
    if (!FS.analyzePath(cur).exists) FS.mkdir(cur);
  }
}

function rmrf(FS: EmscriptenFS, path: string): void {
  if (!FS.analyzePath(path).exists) return;
  if (!FS.isDir(FS.stat(path).mode)) {
    FS.unlink(path);
    return;
  }
  for (const name of FS.readdir(path)) if (name !== "." && name !== "..") rmrf(FS, `${path}/${name}`);
  FS.rmdir(path);
}

function writeTree(FS: EmscriptenFS, files: Array<[string, Uint8Array]>): void {
  for (const [path, data] of files) {
    const full = `${TEXLIVE}/${path}`;
    mkdirp(FS, full.slice(0, full.lastIndexOf("/")));
    FS.writeFile(full, data);
  }
}

interface Instance {
  mod: EmscriptenModule;
  epoch: number | undefined;
  /** Linear memory after start-up. */
  snapshot: Uint8Array;
  sp: number;
  out: string[];
}

/** Internal state, for tests and diagnostics. */
export interface EngineStats {
  /** One per SOURCE_DATE_EPOCH change or crash. */
  instancesCreated: number;
  live: boolean;
  stackPointer: number | null;
  /** 3 when only stdin, stdout and stderr are open. */
  openStreams: number | null;
  memoryBytes: number | null;
  extrasLoaded: boolean;
}

export interface Engine {
  manifest: Manifest;
  compile(files: Record<string, Uint8Array | string>, options?: CompileOptions): Promise<CompileResult>;
  /** Run busytex with any arguments in a fresh directory (to build the format). */
  run(
    args: string[],
    files?: Record<string, Uint8Array | string>,
    options?: { sourceDateEpoch?: number; read?: string[] },
  ): Promise<{ code: number; out: string; files: Record<string, Uint8Array> }>;
  stats(): EngineStats;
  release(): void;
}

/** One wasm instance serves every compilation; after each run its memory, stack and files are restored. */
export async function createEngine(assets: Assets, options: EngineOptions = {}): Promise<Engine> {
  let inst: Instance | null = null;
  let created = 0;
  let counter = 0;
  let extrasLoaded = false;
  // One run at a time, also when callers do not wait for each other.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const p = queue.then(job, job);
    queue = p.catch(() => {});
    return p;
  };

  async function instance(epoch: number | undefined): Promise<Instance> {
    if (inst && inst.epoch === epoch) return inst;
    inst = null; // release the old instance before creating the next, so at most one is live
    const out: string[] = [];
    const env: Record<string, string> = { ...BASE_ENV };
    if (epoch !== undefined) {
      env.SOURCE_DATE_EPOCH = String(Math.trunc(epoch));
      env.FORCE_SOURCE_DATE = "1";
    }
    // Emscripten's factory never settles when instantiateWasm fails asynchronously.
    let fail!: (e: unknown) => void;
    const failed = new Promise<never>((_, reject) => (fail = reject));
    failed.catch(() => {}); // an abort after start-up is reported by callMain instead
    let mod: EmscriptenModule;
    try {
      mod = await Promise.race([
        assets.factory({
          noInitialRun: true,
          thisProgram: "/bin/busytex",
          print: (s: string) => out.push(s),
          printErr: (s: string) => out.push(s),
          instantiateWasm(imports: WebAssembly.Imports, ok: (i: WebAssembly.Instance) => void) {
            WebAssembly.instantiate(assets.wasm, imports)
              .then(ok)
              .catch((e: unknown) => fail(e));
            return {};
          },
          onAbort: (what: unknown) => fail(new Error(`aborted: ${String(what)}`)),
          preRun: [
            (m: EmscriptenModule) => {
              Object.assign(m.ENV, env);
              // kpathsea locates the TeX tree from the program's own path.
              m.FS.mkdir("/bin");
              m.FS.writeFile("/bin/busytex", "");
            },
          ],
        }),
        failed,
      ]);
    } catch (e) {
      throw new EngineError("start", `cannot start the TeX engine: WebAssembly instantiation failed (${String(e)})`);
    }
    created++;
    const FS = mod.FS;
    writeTree(FS, assets.texmf);
    FS.writeFile(FORMAT, assets.format);
    mkdirp(FS, "/work");
    inst = { mod, epoch, snapshot: mod.HEAPU8.slice(), sp: mod.asm.stackSave(), out };
    return inst;
  }

  function reset(it: Instance): void {
    const heap = it.mod.HEAPU8;
    heap.fill(0, it.snapshot.length);
    heap.set(it.snapshot);
    // exit() unwinds with a JS exception, skipping the epilogues that pop the C stack; streams are not in memory.
    it.mod.asm.stackRestore(it.sp);
    const FS = it.mod.FS;
    for (const stream of FS.streams) {
      if (stream && stream.fd > 2) {
        try {
          FS.close(stream);
        } catch {
          // already closed
        }
      }
    }
  }

  async function exec(
    args: string[],
    files: Record<string, Uint8Array | string>,
    epoch: number | undefined,
    after: (FS: EmscriptenFS, dir: string) => void,
  ): Promise<{ code: number; out: string; ms: number }> {
    for (const name of Object.keys(files)) {
      if (name.includes("..") || name.startsWith("/") || name.includes("\\")) throw new Error(`bad file name ${name}`);
    }
    const it = await instance(epoch);
    const FS = it.mod.FS;
    const dir = `/work/${++counter}`;
    mkdirp(FS, dir);
    for (const [name, data] of Object.entries(files)) {
      const full = `${dir}/${name}`;
      mkdirp(FS, full.slice(0, full.lastIndexOf("/")));
      FS.writeFile(full, data);
    }
    FS.chdir(dir);
    it.out.length = 0;
    const t0 = performance.now();
    let code: number;
    try {
      code = it.mod.callMain(args);
    } catch (e) {
      inst = null; // the instance trapped and cannot run again
      throw new EngineError("crash", `the TeX engine crashed: ${String(e)}`, it.out.join("\n"));
    }
    const ms = performance.now() - t0;
    reset(it);
    const out = it.out.join("\n");
    try {
      after(FS, dir);
    } finally {
      FS.chdir("/");
      rmrf(FS, dir);
    }
    return { code, out, ms };
  }

  async function addExtras(onProgress?: (p: Progress) => void): Promise<void> {
    const files = await assets.extras!.load(onProgress);
    // Later instances get the files from assets.texmf; the live one gets them now.
    // The pack's ls-R lists the whole tree and replaces the bundle's.
    const byPath = new Map(assets.texmf);
    for (const [p, d] of files) byPath.set(p, d);
    assets.texmf = [...byPath];
    if (inst) writeTree(inst.mod.FS, files);
    extrasLoaded = true;
  }

  async function pdflatex(files: Record<string, Uint8Array | string>, options: CompileOptions) {
    const main = options.main ?? "cv.tex";
    const job = main.replace(/\.tex$/, "");
    const got: { pdf?: Uint8Array; log?: string } = {};
    const r = await exec(
      ["pdflatex", ...PDFLATEX_FLAGS, `-fmt=${FORMAT}`, main],
      files,
      options.sourceDateEpoch ?? defaultEpoch,
      (FS, dir) => {
        if (FS.analyzePath(`${dir}/${job}.log`).exists) got.log = FS.readFile(`${dir}/${job}.log`, { encoding: "utf8" });
        if (FS.analyzePath(`${dir}/${job}.pdf`).exists) got.pdf = FS.readFile(`${dir}/${job}.pdf`).slice();
      },
    );
    const log = got.log || r.out;
    const ok = r.code === 0 && !!got.pdf && got.pdf.length > 0;
    return { ok, pdf: got.pdf, log, out: r.out, code: r.code, ms: r.ms };
  }

  const defaultEpoch = options.sourceDateEpoch;

  return {
    manifest: assets.manifest,

    compile(files, options = {}) {
      return serial(async () => {
        let r = await pdflatex(files, options);
        let loadedNow = false;
        if (!r.ok && assets.extras && !extrasLoaded) {
          const missing = missingFiles(r.log + "\n" + r.out);
          if (missing.length) {
            const index = await assets.extras.index();
            if (missing.some((f) => candidates(f).some((c) => index.has(c)))) {
              await addExtras(options.onProgress);
              loadedNow = true;
              r = await pdflatex(files, options);
            }
          }
        }
        if (r.ok) return { pdf: r.pdf!, log: r.log, ms: r.ms, extrasLoaded: loadedNow };
        throw failure(r.log, r.out, r.code);
      });
    },

    run(args, files = {}, options = {}) {
      return serial(async () => {
        const got: Record<string, Uint8Array> = {};
        const r = await exec(args, files, options.sourceDateEpoch, (FS, dir) => {
          for (const name of options.read ?? []) {
            if (FS.analyzePath(`${dir}/${name}`).exists) got[name] = FS.readFile(`${dir}/${name}`).slice();
          }
        });
        return { code: r.code, out: r.out, files: got };
      });
    },

    stats() {
      return {
        instancesCreated: created,
        live: inst !== null,
        stackPointer: inst ? inst.mod.asm.stackSave() : null,
        openStreams: inst ? inst.mod.FS.streams.filter(Boolean).length : null,
        memoryBytes: inst ? inst.mod.HEAPU8.length : null,
        extrasLoaded,
      };
    },

    release() {
      inst = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Errors

/** Base names that a missing-file report may refer to (`foo` may be `foo.tex`). */
function candidates(name: string): string[] {
  const base = name.slice(name.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9]+$/.test(base) ? [base] : [base, `${base}.tex`];
}

/** TeX breaks log lines at max_print_line (79) characters; join them again. */
function unwrap(log: string): string {
  const out: string[] = [];
  let joining = false;
  for (const line of log.split(/\r?\n/)) {
    if (joining) out[out.length - 1] += line;
    else out.push(line);
    joining = line.length === 79;
  }
  return out.join("\n");
}

/** The files a TeX run reports as missing, as base names (a font as its `.tfm`). */
export function missingFiles(text: string): string[] {
  const log = unwrap(text);
  const found = new Set<string>();
  const add = (s: string) => found.add(s.slice(s.lastIndexOf("/") + 1));
  for (const m of log.matchAll(/^! .*?`([^'`\s]+)' not found/gm)) add(m[1]);
  for (const m of log.matchAll(/^! Font \S+=(\S+) at \S+ not loadable: Metric \(TFM\) file not found/gm)) add(`${m[1]}.tfm`);
  for (const m of log.matchAll(/^!\s*pdfTeX error:.*\(file (\S+?)\): cannot open/gm)) add(m[1]);
  for (const m of log.matchAll(/^! I can't find file `([^']+)'/gm)) add(m[1]);
  return [...found];
}

/** The error lines of a TeX log (lines starting with '!') and a little context, as in cv-tools' engine.py. */
export function logErrors(log: string, context = 3): string {
  const lines = log.split(/\r?\n/);
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (line.startsWith("!")) out.push(...lines.slice(i, i + 1 + context));
  });
  return (out.length ? out : lines.slice(-20)).join("\n");
}

// What web2c prints when it cannot load the format (damaged, truncated, or written by another binary).
const FORMAT_BROKEN = /Could not undump|Fatal format file error|I can't find the format file|made by different executable version|of \.fmt array at|---! \S+ (?:was written by|doesn't match)/;

function failure(log: string, out: string, code: number): Error {
  if (FORMAT_BROKEN.test(out) || FORMAT_BROKEN.test(log)) {
    return new EngineError(
      "integrity",
      "the TeX engine cannot load its format file pdflatex.fmt, which is damaged or was built for another engine. " +
        "Reload the page; if this persists, rebuild the engine bundle.",
      log || out,
    );
  }
  const missing = missingFiles(log);
  if (missing.length) {
    const names = missing.join(", ");
    return new EngineError(
      "missing-file",
      `The browser TeX engine lacks ${missing.length > 1 ? "the files" : "the file"} ${names}, which this document needs. ` +
        "This is a limit of the browser engine, not an error in the CV: the command line (cv-tools build), " +
        "which uses a full TeX Live installation, may build it.\n" +
        logErrors(log),
      log,
      missing,
    );
  }
  const head = code === 0 ? "pdflatex exited without writing a PDF:" : "pdflatex failed:";
  return new TexError(`${head}\n${logErrors(log)}`, log);
}
