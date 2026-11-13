// Messages between client.ts (main thread) and tex.worker.ts.

import type { EngineErrorCode, Progress } from "./engine";

export type Request =
  | { id: number; type: "init"; baseUrl: string; sourceDateEpoch?: number }
  | { id: number; type: "compile"; files: Record<string, Uint8Array | string>; sourceDateEpoch?: number };

export interface EngineInfo {
  tag: string;
  texliveYear: number;
  /** Milliseconds from init to a ready engine. */
  ms: number;
}

/** `tex`: an error in the document; an EngineErrorCode: the engine failed; `internal`: a bug. */
export type ErrorCode = "tex" | EngineErrorCode | "timeout" | "superseded" | "stopped" | "internal";

export type Response =
  | { id: number; type: "progress"; progress: Progress }
  | { id: number; type: "ready"; info: EngineInfo }
  | { id: number; type: "result"; pdf: Uint8Array; log: string; ms: number; extrasLoaded: boolean }
  | { id: number; type: "error"; code: ErrorCode; message: string; log: string };
