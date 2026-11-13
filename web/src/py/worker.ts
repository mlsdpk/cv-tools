// The py worker: Pyodide with the cv_tools wheel, from the site's own files.
/// <reference lib="webworker" />
import type { PyodideAPI } from "pyodide";
import bridge from "./bridge.py?raw";
import type { PyApi, Request, Response } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;
declare const __PYODIDE_DIR__: string;
const PYODIDE_DIR = __PYODIDE_DIR__;

const BRIDGE: Record<keyof PyApi, string> = {
  validate: "validate",
  renderTex: "render_tex",
  renderHtml: "render_html",
  migrate: "migrate",
  schema: "schema",
  version: "version",
};

let ready: Promise<PyodideAPI> | null = null;

function post(msg: Response) {
  self.postMessage(msg);
}

function progress(stage: string, done: number, total: number) {
  post({ type: "progress", stage, done, total });
}

/** Counts downloaded bytes for the progress line. */
function countDownloads(totalBytes: number): () => void {
  const original = self.fetch;
  let loaded = 0;
  let last = 0;
  self.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    if (!res.body) return res;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        const now = performance.now();
        if (now - last > 200) {
          last = now;
          progress("download", loaded, Math.max(totalBytes, loaded));
        }
        controller.enqueue(chunk);
      },
    });
    return new Response(res.body.pipeThrough(counter), { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return () => {
    self.fetch = original;
    progress("download", loaded, Math.max(totalBytes, loaded));
  };
}

async function boot(root: string, totalBytes: number): Promise<PyodideAPI> {
  const indexURL = new URL(PYODIDE_DIR, root).href;
  progress("download", 0, totalBytes);
  const done = countDownloads(totalBytes);
  const { loadPyodide } = (await import(/* @vite-ignore */ indexURL + "pyodide.mjs")) as typeof import("pyodide");
  let py: PyodideAPI;
  try {
    py = await loadPyodide({ indexURL, stdout: () => {}, stderr: () => {} });
    await py.loadPackage(["cv-tools"], { messageCallback: () => {}, errorCallback: (m) => console.warn(m) });
  } finally {
    done();
  }
  progress("start", 0, 1);
  py.runPython(bridge);
  // Import everything once, so the first validation is not slow.
  py.runPython("import cv_tools.api, cv_tools.validate, cv_tools.migrate, cv_tools.render.latex");
  // Compile the HTML templates before the first real render.
  py.runPython(`
try:
    from cv_tools import api as _api
    if hasattr(_api, "render_html"):
        _api.render_html(_api.loads("version: 2\\nname: Warm Up\\n", "warm.yaml"))
except Exception:
    pass
`);
  progress("ready", 1, 1);
  return py;
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const req = event.data;
  try {
    if (req.type === "init") {
      ready ??= boot(req.root, req.totalBytes ?? 0);
      await ready;
      post({ id: req.id, type: "result", value: null });
      return;
    }
    if (!ready) throw new Error("py worker not initialised");
    const py = await ready;
    const fn = py.globals.get(BRIDGE[req.method]);
    const out = fn(...req.args.map((a) => JSON.stringify(a))) as string;
    fn.destroy?.();
    post({ id: req.id, type: "result", value: JSON.parse(out) });
  } catch (e) {
    post({ id: req.id, type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
