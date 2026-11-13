import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_TIMEOUT_MS, TexClient, TexCompileError } from "../../src/tex/client.ts";

// cv.tex scripts the fake worker: "hang", "slow:<ms>", "progress:<n>" (100 ms
// apart), anything else answers at once.
function fakeWorkers() {
  const workers = [];
  const factory = () => {
    const w = {
      messages: [],
      terminated: false,
      onmessage: null,
      onerror: null,
      postMessage(msg) {
        w.messages.push(msg);
        const reply = (m) => setTimeout(() => !w.terminated && w.onmessage?.({ data: { id: msg.id, ...m } }), 0);
        if (msg.type === "init") return reply({ type: "ready", info: { tag: "fake", texliveYear: 2026, ms: 1 } });
        const tex = String(msg.files["cv.tex"]);
        const result = { type: "result", pdf: new TextEncoder().encode(tex), log: "", ms: 1, extrasLoaded: false };
        if (tex === "hang") return;
        if (tex.startsWith("slow:")) return setTimeout(() => reply(result), Number(tex.slice(5)));
        if (tex.startsWith("progress:")) {
          const n = Number(tex.slice(9));
          for (let i = 1; i <= n; i++) {
            setTimeout(() => reply({ type: "progress", progress: { stage: "extras", loaded: i, total: n } }), 100 * i);
          }
          return setTimeout(() => reply(result), 100 * n + 50);
        }
        reply(result);
      },
      terminate() {
        w.terminated = true;
      },
    };
    workers.push(w);
    return w;
  };
  return { workers, factory };
}

const client = (fw, options = {}) => new TexClient({ baseUrl: "http://example.test/engine/", worker: fw.factory, ...options });
const text = (r) => new TextDecoder().decode(r.pdf);
const compiles = (w) => w.messages.filter((m) => m.type === "compile").map((m) => m.files["cv.tex"]);

describe("watchdog", () => {
  test("times out a hung compilation and restarts the worker", async () => {
    const fw = fakeWorkers();
    const c = client(fw, { timeoutMs: 200 });
    const t0 = performance.now();
    await assert.rejects(c.compile({ "cv.tex": "hang" }), (e) => {
      assert.ok(e instanceof TexCompileError);
      assert.equal(e.code, "timeout");
      assert.equal(e.tex, false);
      assert.match(e.message, /did not finish within 200 ms/);
      assert.match(e.message, /infinite loop in raw LaTeX/);
      return true;
    });
    assert.ok(performance.now() - t0 < 2000);
    assert.equal(fw.workers[0].terminated, true);
    assert.equal(fw.workers.length, 2, "a new worker starts at once");
    assert.deepEqual(fw.workers[1].messages.map((m) => m.type), ["init"]);
    const r = await c.compile({ "cv.tex": "after" });
    assert.equal(text(r), "after");
    assert.equal(fw.workers.length, 2, "a new worker serves the next compilation");
    assert.equal(fw.workers[1].messages[0].type, "init", "the new worker is initialized again");
  });

  test("defaults to 30 s, overridable per compilation", async () => {
    assert.equal(DEFAULT_TIMEOUT_MS, 30000);
    const fw = fakeWorkers();
    const c = client(fw);
    await assert.rejects(c.compile({ "cv.tex": "hang" }, { timeoutMs: 100 }), (e) => e.code === "timeout" && /within 100 ms/.test(e.message));
    const r = await c.compile({ "cv.tex": "slow:300" });
    assert.equal(text(r), "slow:300");
  });

  test("progress restarts the watchdog", async () => {
    const fw = fakeWorkers();
    const c = client(fw, { timeoutMs: 250 });
    const seen = [];
    const r = await c.compile({ "cv.tex": "progress:6" }, { onProgress: (p) => seen.push(p.loaded) });
    assert.equal(text(r), "progress:6");
    assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
  });

  test("runs compilations queued behind a timeout", async () => {
    const fw = fakeWorkers();
    const c = client(fw, { timeoutMs: 150 });
    const stuck = c.compile({ "cv.tex": "hang" });
    const next = c.compile({ "cv.tex": "queued download" });
    await assert.rejects(stuck, (e) => e.code === "timeout");
    assert.equal(text(await next), "queued download");
  });
});

describe("coalescing (live preview)", () => {
  test("replaces queued previews but never downloads", async () => {
    const fw = fakeWorkers();
    const c = client(fw);
    await c.init();
    const running = c.compile({ "cv.tex": "slow:100" }, { coalesce: true });
    const p1 = c.compile({ "cv.tex": "preview 1" }, { coalesce: true });
    const download = c.compile({ "cv.tex": "download" });
    const p2 = c.compile({ "cv.tex": "preview 2" }, { coalesce: true });
    const p3 = c.compile({ "cv.tex": "preview 3" }, { coalesce: true });
    const outcome = (p) => p.then(text, (e) => `rejected:${e.code}`);
    assert.deepEqual(await Promise.all([running, p1, download, p2, p3].map(outcome)), [
      "slow:100",
      "rejected:superseded",
      "download",
      "rejected:superseded",
      "preview 3",
    ]);
    assert.deepEqual(compiles(fw.workers[0]), ["slow:100", "download", "preview 3"]);
  });

  test("keeps different keys apart", async () => {
    const fw = fakeWorkers();
    const c = client(fw);
    const a = c.compile({ "cv.tex": "slow:50" }, { coalesce: "a" });
    const b1 = c.compile({ "cv.tex": "b1" }, { coalesce: "b" });
    const a2 = c.compile({ "cv.tex": "a2" }, { coalesce: "a" });
    assert.deepEqual((await Promise.all([a, b1, a2])).map(text), ["slow:50", "b1", "a2"]);
  });

  test("runs uncoalesced compilations in order", async () => {
    const fw = fakeWorkers();
    const c = client(fw);
    const all = await Promise.all(["one", "two", "three"].map((t) => c.compile({ "cv.tex": t })));
    assert.deepEqual(all.map(text), ["one", "two", "three"]);
  });
});

describe("epochs and termination", () => {
  test("sends the init() epoch with every message", async () => {
    const fw = fakeWorkers();
    const c = client(fw);
    await c.init(undefined, { sourceDateEpoch: 1767225600 });
    await c.compile({ "cv.tex": "x" });
    const [init, compile] = fw.workers[0].messages;
    assert.equal(init.sourceDateEpoch, 1767225600);
    assert.equal(compile.sourceDateEpoch, 1767225600);
  });

  test("sends no epoch by default", async () => {
    const fw = fakeWorkers();
    const c = client(fw);
    await c.compile({ "cv.tex": "x" });
    assert.ok(fw.workers[0].messages.every((m) => m.sourceDateEpoch === undefined));
  });

  test("terminate() rejects pending compilations", async () => {
    const fw = fakeWorkers();
    const c = client(fw);
    await c.init();
    const a = c.compile({ "cv.tex": "hang" });
    const b = c.compile({ "cv.tex": "queued" });
    await new Promise((r) => setTimeout(r, 20));
    c.terminate();
    await assert.rejects(a, (e) => e.code === "stopped");
    await assert.rejects(b, (e) => e.code === "stopped");
  });
});
