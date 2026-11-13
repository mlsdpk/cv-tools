// Main-thread client of the py worker. Calls run one at a time; a watchdog restarts the worker when one hangs.
import type { Files, HtmlResult, MigrateResult, PyApi, Request, Response, SchemaResult, TexResult, ValidateResult, VersionResult } from "./protocol";

export type PyProgress = (stage: string, done: number, total: number) => void;

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class PyTimeoutError extends Error {
  constructor(seconds: number) {
    super(`cv-tools took longer than ${seconds} s on this CV and was restarted. A YAML file with deeply nested aliases can do this.`);
    this.name = "PyTimeoutError";
  }
}

export interface PyClientOptions {
  timeoutMs?: number;
  /** Bytes the first start downloads, or 0 when unknown. */
  totalBytes?: number;
  onRestart?: () => void;
  worker?: () => Worker;
}

export class PyClient {
  private worker!: Worker;
  private next = 1;
  private pending = new Map<number, Pending>();
  private onProgress: PyProgress = () => {};
  private booting!: Promise<void>;
  /** Calls wait here, so the watchdog times only the call that runs. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The first start; later restarts by the watchdog do not replace it. */
  readonly ready: Promise<void>;
  restarts = 0;

  constructor(
    private root: string,
    onProgress?: PyProgress,
    private options: PyClientOptions = {},
  ) {
    if (onProgress) this.onProgress = onProgress;
    this.start();
    this.ready = this.booting;
  }

  private start() {
    const w = this.options.worker ? this.options.worker() : new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "cv-tools-python" });
    this.worker = w;
    w.onmessage = (event: MessageEvent<Response>) => {
      if (this.worker !== w) return;
      const msg = event.data;
      if (msg.type === "progress") {
        this.onProgress(msg.stage, msg.done, msg.total);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === "result") p.resolve(msg.value);
      else p.reject(new Error(msg.message));
    };
    w.onerror = (e) => {
      if (this.worker !== w) return;
      const err = new Error(`py worker failed: ${e.message}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    this.booting = this.send({ type: "init", root: this.root, totalBytes: this.options.totalBytes ?? 0 }).then(() => undefined);
    this.booting.catch(() => {});
  }

  private send(req: DistributiveOmit<Request, "id">): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id });
    });
  }

  /** Pending and later calls reject. */
  terminate() {
    this.worker.terminate();
    const err = new Error("the py worker was stopped");
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private restart() {
    this.worker.onmessage = null;
    this.worker.terminate();
    const err = new Error("the py worker was restarted");
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.restarts++;
    this.start();
    this.options.onRestart?.();
  }

  private call<T>(method: keyof PyApi, ...args: unknown[]): Promise<T> {
    const run = async () => {
      await this.booting;
      const ms = this.options.timeoutMs ?? 20_000;
      const worker = this.worker;
      let timer = 0;
      try {
        return (await Promise.race([
          this.send({ type: "call", method, args }),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new PyTimeoutError(Math.round(ms / 1000)));
              if (this.worker === worker) this.restart();
            }, ms) as unknown as number;
          }),
        ])) as T;
      } finally {
        clearTimeout(timer);
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  validate(text: string, files: Files) {
    return this.call<ValidateResult>("validate", text, files);
  }
  renderTex(text: string, files: Files) {
    return this.call<TexResult>("renderTex", text, files);
  }
  renderHtml(text: string, files: Files) {
    return this.call<HtmlResult>("renderHtml", text, files);
  }
  migrate(text: string) {
    return this.call<MigrateResult>("migrate", text);
  }
  schema() {
    return this.call<SchemaResult>("schema");
  }
  version() {
    return this.call<VersionResult>("version");
  }
}
