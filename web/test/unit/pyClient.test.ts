import { describe, expect, it } from "vitest";
import { PyClient, PyTimeoutError } from "../../src/py/client";

/** A worker that answers init at once and each call after `delay` ms (Infinity: never), one at a time like Pyodide. */
function fakeWorker(delays: number[], made: { count: number; terminated: number }) {
  return () => {
    const delay = delays[made.count] ?? 0;
    made.count++;
    let busyUntil = 0;
    const w = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      onerror: null,
      postMessage(msg: { id: number; type: string }) {
        const reply = () => w.onmessage?.({ data: { id: msg.id, type: "result", value: msg.type === "init" ? null : { ok: true, worker: made.count } } } as MessageEvent);
        if (msg.type === "init") setTimeout(reply, 0);
        else if (delay !== Infinity) {
          busyUntil = Math.max(busyUntil, Date.now()) + delay;
          setTimeout(reply, busyUntil - Date.now());
        }
      },
      terminate() {
        made.terminated++;
      },
    };
    return w as unknown as Worker;
  };
}

describe("py client watchdog", () => {
  it("restarts a worker whose call runs too long, and later calls use the new worker", async () => {
    const made = { count: 0, terminated: 0 };
    let restarted = 0;
    const py = new PyClient("http://x/", undefined, { timeoutMs: 50, worker: fakeWorker([Infinity, 0], made), onRestart: () => restarted++ });
    await py.ready;
    await expect(py.validate("a", {})).rejects.toBeInstanceOf(PyTimeoutError);
    expect(made).toEqual({ count: 2, terminated: 1 });
    expect(restarted).toBe(1);
    expect(py.restarts).toBe(1);
    await expect(py.validate("a", {})).resolves.toMatchObject({ ok: true, worker: 2 });
  });
  it("times only the call that runs, not the ones waiting behind it", async () => {
    const made = { count: 0, terminated: 0 };
    const py = new PyClient("http://x/", undefined, { timeoutMs: 120, worker: fakeWorker([50], made) });
    const calls = Array.from({ length: 5 }, () => py.validate("a", {}));
    await expect(Promise.all(calls)).resolves.toHaveLength(5);
    expect(made.terminated).toBe(0);
  });
  it("leaves a call that finishes in time alone", async () => {
    const made = { count: 0, terminated: 0 };
    const py = new PyClient("http://x/", undefined, { timeoutMs: 200, worker: fakeWorker([10], made) });
    await expect(py.validate("a", {})).resolves.toMatchObject({ ok: true });
    expect(made.terminated).toBe(0);
  });
});
