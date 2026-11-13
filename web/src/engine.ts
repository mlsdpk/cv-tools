// The pdfTeX engine as the app uses it ("@tex-client" is src/tex/client.ts, or src/texStub.ts with CV_TEX_STUB=1).
import * as tex from "@tex-client";
import { BASE_URL, ENGINE_DIR } from "./site";

tex.configure({ baseUrl: new URL(ENGINE_DIR, BASE_URL).href });

declare const __TEX_STUB__: boolean;
export const ENGINE_IS_STUB: boolean = __TEX_STUB__;

export type EngineState =
  | { kind: "idle" }
  /** `stage` is "manifest", "download", "start" or "extras" (the font pack). */
  | { kind: "loading"; stage: string; loaded: number; total: number }
  | { kind: "compiling" }
  | { kind: "ready"; ms?: number }
  | { kind: "error"; message: string };

export interface CompileOutput {
  pdf: Uint8Array;
  log: string;
  ms: number;
}

/** `code` is the tex client's error code ("tex", "timeout", "missing-file", "integrity", ...). */
export interface EngineFailure extends Error {
  code?: string;
  log?: string;
}

type Progress = { stage?: string; loaded?: number; total?: number };

function progressState(p: unknown): EngineState {
  const o = (p ?? {}) as Progress;
  return { kind: "loading", stage: typeof o.stage === "string" ? o.stage : "download", loaded: Number(o.loaded ?? 0), total: Number(o.total ?? 0) };
}

export function failureMessage(e: unknown): string {
  const err = e as EngineFailure;
  const msg = err instanceof Error ? err.message : String(e);
  switch (err?.code) {
    case "tex":
      return `pdfLaTeX stopped with an error: ${msg}`;
    case "timeout":
      return msg; // the client explains the watchdog and the likely cause
    case "missing-file":
      return `the TeX engine of this site lacks a file the CV needs: ${msg}`;
    case "integrity":
      return `the TeX engine files are damaged or from another version (${msg}). Reload the page; if that does not help, clear this site's data`;
    case "download":
      return `the TeX engine could not be downloaded: ${msg}`;
    default:
      return msg;
  }
}

export class Engine {
  private initPromise: Promise<void> | null = null;
  private running = 0;
  state: EngineState = { kind: "idle" };

  constructor(private onState: (s: EngineState) => void) {}

  private set(s: EngineState) {
    this.state = s;
    this.onState(s);
  }

  init(): Promise<void> {
    this.initPromise ??= (async () => {
      this.set({ kind: "loading", stage: "manifest", loaded: 0, total: 0 });
      try {
        await (tex.init as unknown as (cb: (p: unknown) => void) => Promise<unknown>)((p) => this.set(progressState(p)));
        this.set({ kind: "ready" });
      } catch (e) {
        this.initPromise = null;
        this.set({ kind: "error", message: failureMessage(e) });
        throw e;
      }
    })();
    return this.initPromise;
  }

  private async run(files: Record<string, Uint8Array>, coalesce: boolean): Promise<CompileOutput | null> {
    await this.init();
    this.running++;
    this.set({ kind: "compiling" });
    try {
      const out = (await (tex.compile as (f: Record<string, Uint8Array>, o: object) => Promise<CompileOutput>)(files, {
        ...(coalesce ? { coalesce: true } : {}),
        onProgress: (p: unknown) => this.set(progressState(p)),
      })) as CompileOutput;
      if (!out.pdf || out.pdf.length === 0) throw Object.assign(new Error("pdfLaTeX did not produce a PDF"), { log: out.log ?? "", code: "tex" });
      this.set({ kind: "ready", ms: out.ms });
      return { pdf: out.pdf, log: out.log ?? "", ms: out.ms ?? 0 };
    } catch (e) {
      if ((e as EngineFailure).code === "superseded") return null;
      this.set({ kind: "error", message: failureMessage(e) });
      throw e;
    } finally {
      this.running--;
    }
  }

  /** Compile for the PDF preview: a newer call replaces a queued one, which resolves to null. */
  preview(files: Record<string, Uint8Array>): Promise<CompileOutput | null> {
    return this.run(files, true);
  }

  /** For a download: never replaced. */
  async compile(files: Record<string, Uint8Array>): Promise<CompileOutput> {
    return (await this.run(files, false))!;
  }

  get busy(): boolean {
    return this.running > 0 || this.state.kind === "loading";
  }
}

/** The last lines of a TeX log that explain an error (from the first "!" line). */
export function logExcerpt(log: string, lines = 12): string {
  const all = log.split(/\r?\n/);
  const i = all.findIndex((l) => l.startsWith("!"));
  const part = i >= 0 ? all.slice(i, i + lines) : all.slice(-lines);
  return part.join("\n").trim();
}
