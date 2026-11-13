// The tex worker. No eval and no SharedArrayBuffer, so the site needs no COOP/COEP and a strict CSP works.

import { createEngine, EngineError, loadAssets, TexError, type Engine } from "./engine";
import type { Request, Response } from "./protocol";

interface WorkerScope {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: Response, options?: { transfer?: Transferable[] }): void;
}

const scope = globalThis as unknown as WorkerScope;
let engine: Promise<Engine> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function send(message: Response, transfer: Transferable[] = []): void {
  scope.postMessage(message, { transfer });
}

function sendError(id: number, err: unknown, prefix = ""): void {
  if (err instanceof TexError) send({ id, type: "error", code: "tex", message: err.message, log: err.log });
  else if (err instanceof EngineError) send({ id, type: "error", code: err.code, message: prefix + err.message, log: err.log });
  else send({ id, type: "error", code: "internal", message: prefix + String(err), log: "" });
}

async function init(id: number, baseUrl: string, sourceDateEpoch?: number): Promise<void> {
  const t0 = performance.now();
  // The wasm instance is created by the first compilation, not here.
  engine ??= loadAssets({ baseUrl, onProgress: (progress) => send({ id, type: "progress", progress }) }).then((a) =>
    createEngine(a, { sourceDateEpoch }),
  );
  try {
    const e = await engine;
    send({
      id,
      type: "ready",
      info: { tag: e.manifest.engine.tag, texliveYear: e.manifest.tree.texliveYear, ms: performance.now() - t0 },
    });
  } catch (err) {
    engine = null;
    sendError(id, err, "cannot start the TeX engine: ");
  }
}

async function compile(id: number, files: Record<string, Uint8Array | string>, sourceDateEpoch?: number): Promise<void> {
  if (!engine) {
    send({ id, type: "error", code: "internal", message: "the TeX engine is not initialized", log: "" });
    return;
  }
  try {
    const r = await (await engine).compile(files, {
      sourceDateEpoch,
      // The client restarts its watchdog on progress, so a slow font pack download is not taken for a loop.
      onProgress: (progress) => send({ id, type: "progress", progress }),
    });
    send({ id, type: "result", pdf: r.pdf, log: r.log, ms: r.ms, extrasLoaded: r.extrasLoaded }, [r.pdf.buffer as ArrayBuffer]);
  } catch (err) {
    sendError(id, err);
  }
}

scope.onmessage = ({ data }) => {
  const job =
    data.type === "init" ? () => init(data.id, data.baseUrl, data.sourceDateEpoch) : () => compile(data.id, data.files, data.sourceDateEpoch);
  queue = queue.then(job, job);
};
