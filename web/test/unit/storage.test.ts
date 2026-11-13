import { describe, expect, it } from "vitest";
import { FORMAT, KEY, localStore, memoryStore, parseRecord, quarantineKey, WorkspaceStore, type KeyValue } from "../../src/storage";

class FakeStorage {
  m = new Map<string, string>();
  limit = Infinity;
  blocked = false;
  getItem(k: string) {
    if (this.blocked) throw new DOMException("blocked", "SecurityError");
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.blocked) throw new DOMException("blocked", "SecurityError");
    if (v.length > this.limit) throw new DOMException("full", "QuotaExceededError");
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const failing = (name = "UnknownError"): KeyValue => ({
  get: async () => {
    throw new DOMException("no idb", name);
  },
  set: async () => {
    throw new DOMException("no idb", name);
  },
  remove: async () => {
    throw new DOMException("no idb", name);
  },
});

const files = { "cv.yaml": "version: 2\nname: A\n", "publications.bib": "@article{x, title={T}}" };
const ls = () => new FakeStorage();
const store = (s: FakeStorage, idb: KeyValue = memoryStore(), now?: () => number) => new WorkspaceStore(localStore(() => s as unknown as Storage), idb, now);

describe("workspace storage", () => {
  it("saves a format 2 record to localStorage", async () => {
    const s = ls();
    const a = store(s);
    expect((await a.save(files)).where).toBe("local");
    const rec = JSON.parse(s.m.get(KEY)!);
    expect(rec).toMatchObject({ format: FORMAT, files });
    expect(typeof rec.savedAt).toBe("number");
    const loaded = await store(s).load();
    expect(loaded.kind === "ok" && loaded.workspace.files).toEqual(files);
  });

  it("falls back to IndexedDB when localStorage is full, and back again", async () => {
    const s = ls();
    s.limit = 50;
    const idb = memoryStore();
    const a = store(s, idb);
    expect((await a.save(files)).where).toBe("indexeddb");
    expect(s.m.get(KEY)).toBe('{"in":"indexeddb"}');
    const again = store(s, idb);
    const r = await again.load();
    expect(r.kind === "ok" && r.workspace.files).toEqual(files);
    s.limit = Infinity;
    expect((await again.save({ ...files, "cv.yaml": "version: 2\nname: B\n" })).where).toBe("local");
    const r2 = await store(s, idb).load();
    expect(r2.kind === "ok" && r2.workspace.files["cv.yaml"]).toContain("name: B");
  });

  it("uses IndexedDB when localStorage is blocked", async () => {
    const s = ls();
    s.blocked = true;
    const idb = memoryStore();
    expect((await store(s, idb).save(files)).where).toBe("indexeddb");
    const r = await store(s, idb).load();
    expect(r.kind === "ok" && r.workspace.files).toEqual(files);
  });

  it("keeps the workspace in memory when nothing works, and says why", async () => {
    const full = ls();
    full.limit = 10;
    expect(await store(full, failing("QuotaExceededError")).save(files)).toMatchObject({ where: "memory", reason: "quota" });
    const blocked = ls();
    blocked.blocked = true;
    const b = store(blocked, failing());
    expect(await b.save(files)).toMatchObject({ where: "memory", reason: "blocked" });
    expect((await b.memoryCopy())!.files).toEqual(files);
  });

  it("tells 'nothing stored' from 'could not read', and then never writes the workspace", async () => {
    const s = ls();
    s.limit = 50;
    let broken = false;
    const idb = memoryStore();
    const flaky: KeyValue = {
      get: (k) => (broken ? Promise.reject(new DOMException("transient", "UnknownError")) : idb.get(k)),
      set: (k, v) => idb.set(k, v),
      remove: (k) => idb.remove(k),
    };
    await store(s, flaky).save(files);
    expect((await store(ls(), memoryStore()).load()).kind).toBe("empty");
    broken = true;
    const b = store(s, flaky);
    const r = await b.load();
    expect(r).toMatchObject({ kind: "unreadable", reason: "read-failed" });
    expect(b.guarded).toBeTruthy();
    // The example (or anything else) is not saved over the unreadable work.
    expect(await b.save({ "cv.yaml": "version: 2\nname: Example\n" })).toMatchObject({ where: "memory", reason: "guarded" });
    broken = false;
    const r2 = await store(s, flaky).load();
    expect(r2.kind === "ok" && r2.workspace.files).toEqual(files);
  });

  it("moves a damaged or unknown record aside instead of dropping it", async () => {
    for (const raw of ["{not json", JSON.stringify({ files: { "main.yaml": "version: 2\nname: Precious\n" } }), JSON.stringify([1])]) {
      const s = ls();
      s.m.set(KEY, raw);
      const b = store(s);
      const r = await b.load();
      expect(r).toMatchObject({ kind: "quarantined", key: quarantineKey(raw), raw });
      expect(s.m.get(quarantineKey(raw))).toBe(raw);
      expect(b.guarded).toBe(false);
    }
  });

  it("guards a damaged record that cannot be moved aside", async () => {
    const s = ls();
    s.m.set(KEY, "{not json");
    s.limit = 5;
    const b = store(s, failing("QuotaExceededError"));
    expect((await b.load()).kind).toBe("quarantined");
    expect(b.guarded).toBeTruthy();
    await b.save(files);
    expect(s.m.get(KEY)).toBe("{not json");
  });

  it("refuses to overwrite a record from a newer version", async () => {
    const s = ls();
    s.m.set(KEY, JSON.stringify({ format: FORMAT + 1, data: "future" }));
    const b = store(s);
    expect(await b.load()).toMatchObject({ kind: "unreadable", reason: "newer" });
    await b.save(files);
    expect(JSON.parse(s.m.get(KEY)!).data).toBe("future");
  });

  it("reads format 1 records and writes them back as format 2", async () => {
    const s = ls();
    s.m.set(KEY, JSON.stringify({ files, savedAt: 5 }));
    const b = store(s);
    const r = await b.load();
    expect(r).toMatchObject({ kind: "ok", upgraded: true });
    expect((await b.save(files)).where).toBe("local");
    expect(JSON.parse(s.m.get(KEY)!).format).toBe(2);
    expect(parseRecord(JSON.stringify({ files, savedAt: 1 }))).toMatchObject({ kind: "ok", format: 1 });
  });

  it("says storage is blocked when neither store can be read, and then never writes", async () => {
    const s = ls();
    s.m.set(KEY, JSON.stringify({ format: 2, files, savedAt: 1 }));
    s.blocked = true;
    const b = store(s, failing("SecurityError"));
    expect(await b.load()).toEqual({ kind: "blocked" });
    s.blocked = false;
    expect(await b.save({ "cv.yaml": "version: 2\nname: Example\n" })).toMatchObject({ where: "memory", reason: "blocked" });
    expect(JSON.parse(s.m.get(KEY)!).files).toEqual(files);
  });

  it("keeps one quarantine copy per damaged record, however often it loads", async () => {
    const s = ls();
    s.m.set(KEY, "{damaged");
    let t = 0;
    for (let i = 0; i < 5; i++) await store(s, memoryStore(), () => ++t).load();
    expect([...s.m.keys()].filter((k) => k.includes("quarantine"))).toEqual([quarantineKey("{damaged")]);
  });

  it("finds a record in IndexedDB when localStorage had no room for the marker", async () => {
    const s = ls();
    s.limit = 10;
    const idb = memoryStore();
    expect((await store(s, idb).save(files)).where).toBe("indexeddb");
    expect(s.m.has(KEY)).toBe(false);
    const r = await store(s, idb).load();
    expect(r.kind === "ok" && r.workspace.files).toEqual(files);
  });

  it("start fresh copies a newer record aside, then saves", async () => {
    const s = ls();
    const future = JSON.stringify({ format: FORMAT + 1, data: "future" });
    s.m.set(KEY, future);
    const b = store(s);
    await b.load();
    const kept = await b.startFresh();
    expect(kept).toBe(quarantineKey(future));
    expect(s.m.get(kept!)).toBe(future);
    expect((await b.save(files)).where).toBe("local");
    expect(JSON.parse(s.m.get(KEY)!).files).toEqual(files);
  });

  it("start fresh leaves a record it cannot read where it is", async () => {
    const s = ls();
    s.limit = 40;
    const idb = memoryStore();
    let broken = false;
    const flaky: KeyValue = { get: (k) => (broken ? Promise.reject(new Error("broken")) : idb.get(k)), set: (k, v) => idb.set(k, v), remove: (k) => idb.remove(k) };
    await store(s, flaky).save(files);
    s.m.set(KEY, '{"in":"indexeddb"}');
    s.limit = Infinity;
    broken = true;
    const b = store(s, flaky);
    expect((await b.load()).kind).toBe("unreadable");
    expect(await b.startFresh()).toBe("untouched");
    expect((await b.save({ "cv.yaml": "version: 2\nname: New\n" })).where).toBe("local");
    expect(await idb.get(KEY)).toContain("name: A");
  });

  it("a read-only store writes nothing", async () => {
    const s = ls();
    s.m.set(KEY, "{damaged");
    s.m.set("cv-tools:backup", JSON.stringify({ files, savedAt: 1 }));
    const before = new Map(s.m);
    const b = store(s);
    b.writable = false;
    await b.load();
    await b.save(files);
    await b.keepForUndo(files, "cv.yaml");
    expect(s.m).toEqual(before);
  });

  it("writes saves in order, so a slow IndexedDB write never lands after a newer one", async () => {
    const s = ls();
    s.limit = 150;
    const idb = memoryStore();
    const slow: KeyValue = { ...idb, set: async (k, v) => (await new Promise((r) => setTimeout(r, 30)), idb.set(k, v)) };
    const a = store(s, slow);
    const big = { "cv.yaml": "version: 2\nname: " + "x".repeat(200) + "\n" };
    const small = { "cv.yaml": "v: 2\n" };
    const p1 = a.save(big);
    await new Promise((r) => setTimeout(r, 5)); // p1 is now inside the slow IndexedDB write
    const p2 = a.save(small);
    const p3 = a.save({ "cv.yaml": "v: 3\n" });
    expect((await p1).where).toBe("indexeddb");
    expect((await p2).superseded).toBe(true);
    expect((await p3).where).toBe("local");
    const r = await store(s, slow).load();
    expect(r.kind === "ok" && r.workspace.files["cv.yaml"]).toBe("v: 3\n");
  });
});

describe("undo snapshot", () => {
  it("keeps one snapshot, which survives a new store and is replaced by the next one", async () => {
    const s = ls();
    await store(s).keepForUndo({ "cv.yaml": "name: A\n" }, "a.yaml");
    expect(await store(s).undoSnapshot()).toMatchObject({ files: { "cv.yaml": "name: A\n" }, name: "a.yaml", offer: true });
    await store(s).keepForUndo({ "cv.yaml": "name: B\n" }, "cv.yaml");
    const b = store(s);
    expect((await b.undoSnapshot())?.files["cv.yaml"]).toBe("name: B\n");
    await b.stopOfferingUndo();
    expect(await store(s).undoSnapshot()).toMatchObject({ offer: false, files: { "cv.yaml": "name: B\n" } });
  });

  it("never writes the snapshot after a failed read", async () => {
    const s = ls();
    s.limit = 40;
    const idb = memoryStore();
    let broken = false;
    const flaky: KeyValue = { get: (k) => (broken ? Promise.reject(new Error("transient")) : idb.get(k)), set: (k, v) => idb.set(k, v), remove: (k) => idb.remove(k) };
    await store(s, flaky).keepForUndo({ "cv.yaml": "name: OLD\n" }, "cv.yaml");
    broken = true;
    const c = store(s, flaky);
    expect(await c.keepForUndo({ "cv.yaml": "name: NEW\n" }, "cv.yaml")).toMatchObject({ where: "memory" });
    expect((await c.undoSnapshot())?.files["cv.yaml"]).toBe("name: NEW\n");
    broken = false;
    expect((await store(s, flaky).undoSnapshot())?.files["cv.yaml"]).toBe("name: OLD\n");
  });

  it("copies a damaged snapshot aside before writing a new one", async () => {
    const s = ls();
    const damaged = '{"format":2,"files":{"cv.yaml":"name: OLD"}';
    s.m.set("cv-tools:undo", damaged);
    await store(s).keepForUndo({ "cv.yaml": "name: NEW\n" }, "cv.yaml");
    expect(s.m.get(quarantineKey(damaged))).toBe(damaged);
    expect(JSON.parse(s.m.get("cv-tools:undo")!).files["cv.yaml"]).toBe("name: NEW\n");
  });

  it("keeps the snapshot in memory when storage is full", async () => {
    const s = ls();
    s.limit = 20;
    const b = store(s, failing("QuotaExceededError"));
    expect(await b.keepForUndo({ "cv.yaml": "name: BIG\n" }, "cv.yaml")).toMatchObject({ where: "memory", reason: "quota" });
    expect((await b.undoSnapshot())?.files["cv.yaml"]).toBe("name: BIG\n");
  });

  it("adopts the single backup slot of earlier versions as the snapshot", async () => {
    const s = ls();
    s.m.set(KEY, JSON.stringify({ files, savedAt: 1 }));
    s.m.set("cv-tools:backup", JSON.stringify({ files: { "cv.yaml": "name: old\n" }, savedAt: 1 }));
    const b = store(s);
    await b.load();
    expect(await b.undoSnapshot()).toMatchObject({ files: { "cv.yaml": "name: old\n" }, offer: false });
    expect(s.m.has("cv-tools:backup")).toBe(false);
  });

  it("keeps the backup of earlier versions when a snapshot exists", async () => {
    const s = ls();
    await store(s).keepForUndo({ "cv.yaml": "name: SNAP\n" }, "cv.yaml");
    s.m.set(KEY, JSON.stringify({ files, savedAt: 1 }));
    s.m.set("cv-tools:backup", JSON.stringify({ files: { "cv.yaml": "name: LEGACY\n" }, savedAt: 1 }));
    const c = store(s);
    await c.load();
    expect((await c.undoSnapshot())?.files["cv.yaml"]).toBe("name: SNAP\n");
    expect(s.m.has("cv-tools:backup")).toBe(true);
  });
});
