// Main-thread API for the tex worker. compile() rejects with a TexCompileError whose `code` says why.

import type { Progress } from "./engine";
import type { EngineInfo, ErrorCode, Request, Response } from "./protocol";

export type { EngineInfo, ErrorCode, Progress };

export interface CompileResult {
  pdf: Uint8Array;
  log: string;
  ms: number;
  /** True when this compilation downloaded the font pack (texmf-extra) and ran pdflatex again. */
  extrasLoaded: boolean;
}

export class TexCompileError extends Error {
  log: string;
  code: ErrorCode;
  constructor(message: string, log: string, code: ErrorCode) {
    super(message);
    this.name = "TexCompileError";
    this.log = log;
    this.code = code;
  }
  /** pdflatex reported an error in the document (not an engine failure or a stopped run). */
  get tex(): boolean {
    return this.code === "tex";
  }
}

/** The default watchdog: a compilation that runs longer is stopped and the worker restarted. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface TexClientOptions {
  /** The engine directory. Default `engine/` under the page's base URL. */
  baseUrl?: string;
  worker?: () => Worker;
  /** For reproducible PDFs (tests); a different epoch per compile replaces the 64 MiB wasm instance. Default the clock. */
  sourceDateEpoch?: number;
  timeoutMs?: number;
}

export interface ClientCompileOptions {
  /** Live preview: a newer compilation with the same key replaces a queued one ("superseded"). */
  coalesce?: boolean | string;
  timeoutMs?: number;
  sourceDateEpoch?: number;
  /** Reports the download of the font pack when this compilation needs it. */
  onProgress?: (p: Progress) => void;
}

type Pending = {
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
  onProgress?: (p: Progress) => void;
};

type Job = {
  files: Record<string, Uint8Array | string>;
  options: ClientCompileOptions;
  key: string | null;
  resolve: (r: CompileResult) => void;
  reject: (e: Error) => void;
};

export class TexClient {
  private worker: Worker | null = null;
  private readonly options: TexClientOptions;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private ready: Promise<EngineInfo> | null = null;
  private initProgress?: (p: Progress) => void;
  private sourceDateEpoch: number | undefined;
  private readonly jobs: Job[] = [];
  private running: Job | null = null;

  constructor(options: TexClientOptions = {}) {
    this.options = options;
    this.sourceDateEpoch = options.sourceDateEpoch;
  }

  /** Repeated calls share the first; `sourceDateEpoch` is read by the first call only. */
  init(onProgress?: (p: Progress) => void, options: { sourceDateEpoch?: number } = {}): Promise<EngineInfo> {
    if (!this.ready) {
      if (options.sourceDateEpoch !== undefined) this.sourceDateEpoch = options.sourceDateEpoch;
      if (onProgress) this.initProgress = onProgress;
    }
    this.ready ??= this.request(
      { id: 0, type: "init", baseUrl: this.baseUrl(), sourceDateEpoch: this.sourceDateEpoch },
      (p) => this.initProgress?.(p),
    ).then(
      (r) => (r as Extract<Response, { type: "ready" }>).info,
      (e: unknown) => {
        this.ready = null;
        throw e;
      },
    );
    return this.ready;
  }

  /** One pdflatex pass, after the compilations queued before it. */
  compile(files: Record<string, Uint8Array | string>, options: ClientCompileOptions = {}): Promise<CompileResult> {
    const key = options.coalesce === undefined || options.coalesce === false ? null : options.coalesce === true ? "default" : options.coalesce;
    return new Promise<CompileResult>((resolve, reject) => {
      if (key !== null) {
        for (let i = this.jobs.length - 1; i >= 0; i--) {
          if (this.jobs[i].key !== key) continue;
          const [old] = this.jobs.splice(i, 1);
          old.reject(new TexCompileError("a newer compilation replaced this one", "", "superseded"));
        }
      }
      this.jobs.push({ files, options, key, resolve, reject });
      void this.pump();
    });
  }

  /** Stop the worker; pending and queued calls reject with code "stopped". */
  terminate(): void {
    const stopped = () => new TexCompileError("the TeX worker was stopped", "", "stopped");
    for (const job of this.jobs.splice(0)) job.reject(stopped());
    this.reset(stopped());
  }

  private async pump(): Promise<void> {
    if (this.running || this.jobs.length === 0) return;
    const job = this.jobs.shift()!;
    this.running = job;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.init();
      const ms = job.options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.reset(timeoutError(ms));
          // Start the new worker now, so the next compilation does not wait for it.
          this.init().catch(() => {});
        }, ms);
      };
      arm();
      const r = (await this.request(
        { id: 0, type: "compile", files: job.files, sourceDateEpoch: job.options.sourceDateEpoch ?? this.sourceDateEpoch },
        (p) => {
          arm(); // a font pack download is progress, not a loop
          job.options.onProgress?.(p);
        },
      )) as Extract<Response, { type: "result" }>;
      job.resolve({ pdf: r.pdf, log: r.log, ms: r.ms, extrasLoaded: r.extrasLoaded });
    } catch (e) {
      job.reject(e as Error);
    } finally {
      clearTimeout(timer);
      this.running = null;
    }
    void this.pump();
  }

  private reset(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  private baseUrl(): string {
    const ref = typeof document !== "undefined" ? document.baseURI : undefined;
    return new URL(this.options.baseUrl ?? "engine/", ref).href;
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = this.options.worker
      ? this.options.worker()
      : new Worker(new URL("./tex.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<Response>) => {
      if (this.worker !== w) return;
      const msg = e.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === "progress") {
        p.onProgress?.(msg.progress);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === "error") p.reject(new TexCompileError(msg.message, msg.log, msg.code));
      else p.resolve(msg);
    };
    w.onerror = (e: ErrorEvent) => {
      if (this.worker !== w) return;
      this.reset(new TexCompileError(`the TeX worker failed: ${e.message}`, "", "internal"));
    };
    this.worker = w;
    return w;
  }

  private request(req: Request, onProgress?: (p: Progress) => void): Promise<Response> {
    const w = this.start();
    const id = this.nextId++;
    return new Promise<Response>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      w.postMessage({ ...req, id });
    });
  }
}

function timeoutError(ms: number): TexCompileError {
  return new TexCompileError(
    `The TeX engine did not finish within ${ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`}, so it was stopped and restarted. ` +
      "The likely cause is an infinite loop in raw LaTeX (a {latex: ...} value or a .bib field).",
    "",
    "timeout",
  );
}

let shared: TexClient | null = null;
let sharedOptions: TexClientOptions = {};

/** Options for the shared engine (for example its `baseUrl`); call before the first init or compile. */
export function configure(options: TexClientOptions): void {
  sharedOptions = options;
  shared?.terminate();
  shared = null;
}

function client(): TexClient {
  shared ??= new TexClient(sharedOptions);
  return shared;
}

export function init(onProgress?: (p: Progress) => void, options?: { sourceDateEpoch?: number }): Promise<EngineInfo> {
  return client().init(onProgress, options);
}

export function compile(files: Record<string, Uint8Array | string>, options?: ClientCompileOptions): Promise<CompileResult> {
  return client().compile(files, options);
}
