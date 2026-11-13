// The workspace and one undo snapshot, in localStorage, else IndexedDB, else memory.

export type Files = Record<string, string>;

export const FORMAT = 2;

export interface Workspace {
  files: Files;
  savedAt: number;
}

export interface Snapshot {
  files: Files;
  /** The file name shown for it. */
  name: string;
  savedAt: number;
  /** The Undo notice is still offered (after a reload too). */
  offer: boolean;
}

export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export type Where = "local" | "indexeddb" | "memory";

/** Why a save stayed in memory. "guarded": the store will not write over a record it could not read. */
export type NotSaved = "quota" | "blocked" | "guarded";

export type LoadResult =
  | { kind: "empty"; lost?: boolean }
  | { kind: "ok"; workspace: Workspace; upgraded: boolean }
  | { kind: "blocked" }
  | { kind: "unreadable"; reason: "read-failed" | "newer"; detail: string }
  | { kind: "quarantined"; key: string; raw: string; detail: string };

export interface SaveResult {
  where: Where;
  reason?: NotSaved;
  /** A newer save replaced this one before it ran. */
  superseded?: boolean;
  savedAt?: number;
}

export const KEY = "cv-tools:workspace";
const LEGACY_BACKUP = "cv-tools:backup";
const UNDO = "cv-tools:undo";
export const QUARANTINE = "cv-tools:quarantine:";
const MARKER = '{"in":"indexeddb"}';

class BlockedError extends Error {}

export function localStore(storage: () => Storage = () => localStorage): KeyValue {
  return {
    async get(key) {
      return storage().getItem(key);
    },
    async set(key, value) {
      storage().setItem(key, value);
    },
    async remove(key) {
      storage().removeItem(key);
    },
  };
}

export function indexedDbStore(factory: () => IDBFactory = () => indexedDB, name = "cv-tools"): KeyValue {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const req = factory().open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        db = null;
        reject(req.error);
      };
    }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const store = (await open()).transaction("kv", mode).objectStore("kv");
    return new Promise((resolve, reject) => {
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };
  return {
    async get(key) {
      const v = await run<unknown>("readonly", (s) => s.get(key));
      return typeof v === "string" ? v : null;
    },
    async set(key, value) {
      await run("readwrite", (s) => s.put(value, key));
    },
    async remove(key) {
      await run("readwrite", (s) => s.delete(key));
    },
  };
}

export function memoryStore(): KeyValue {
  const m = new Map<string, string>();
  return {
    async get(key) {
      return m.get(key) ?? null;
    },
    async set(key, value) {
      m.set(key, value);
    },
    async remove(key) {
      m.delete(key);
    },
  };
}

function isQuota(e: unknown): boolean {
  const ex = e as { name?: string; code?: number } | null;
  return !!ex && (ex.name === "QuotaExceededError" || ex.name === "NS_ERROR_DOM_QUOTA_REACHED" || ex.code === 22 || ex.code === 1014);
}

function isFiles(v: unknown): v is Files {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((t) => typeof t === "string") && typeof (v as Files)["cv.yaml"] === "string";
}

function parseSnapshot(raw: string): Snapshot | null {
  try {
    const v = JSON.parse(raw) as Partial<Snapshot> & { format?: unknown };
    if (!v || !isFiles(v.files) || typeof v.format !== "number" || v.format > FORMAT) return null;
    return { files: v.files, name: typeof v.name === "string" ? v.name : "cv.yaml", savedAt: Number(v.savedAt) || 0, offer: v.offer === true };
  } catch {
    return null;
  }
}

type Parsed = { kind: "ok"; workspace: Workspace; format: number } | { kind: "newer"; format: number } | { kind: "damaged"; detail: string };

/** A workspace record: format 1 (`{files, savedAt}`) or 2 (`{format: 2, files, savedAt}`). */
export function parseRecord(text: string): Parsed {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { kind: "damaged", detail: "it is not valid JSON" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { kind: "damaged", detail: "it is not a workspace record" };
  const r = v as { format?: unknown; files?: unknown; savedAt?: unknown };
  const format = r.format === undefined ? 1 : r.format;
  if (typeof format !== "number" || !Number.isInteger(format) || format < 1) return { kind: "damaged", detail: "its format is not a number" };
  if (format > FORMAT) return { kind: "newer", format };
  if (!isFiles(r.files)) return { kind: "damaged", detail: "it holds no cv.yaml" };
  return { kind: "ok", format, workspace: { files: r.files, savedAt: typeof r.savedAt === "number" ? r.savedAt : 0 } };
}

/** One quarantine key per distinct record, so loading a damaged record again adds no copy. */
export function quarantineKey(raw: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) h = Math.imul(h ^ raw.charCodeAt(i), 0x01000193);
  return QUARANTINE + (h >>> 0).toString(16).padStart(8, "0") + raw.length.toString(16);
}

export class WorkspaceStore {
  where: Where = "local";
  /** Set when the stored workspace could not be read: the workspace key is then never written. */
  guarded: false | "blocked" | "unreadable" = false;
  /** Only the tab that holds the writer lock writes (see writer.ts). */
  writable = true;
  private memory = memoryStore();
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private undoMemory: Snapshot | null = null;
  /** The undo record could not be read, so it is never written. */
  private undoGuarded = false;
  /** Keys this tab read from or wrote to IndexedDB; only those copies are ever removed. */
  private inIdb = new Set<string>();

  constructor(
    private local: KeyValue = localStore(),
    private idb: KeyValue = indexedDbStore(),
    private now: () => number = () => Date.now(),
  ) {}

  /** Throws BlockedError when neither store can be read. */
  private async readRaw(key: string): Promise<string | null> {
    let text: string | null;
    try {
      text = await this.local.get(key);
    } catch {
      try {
        text = await this.idb.get(key);
      } catch {
        throw new BlockedError("this browser blocks storage for the site");
      }
      if (text !== null) this.inIdb.add(key);
      return text ?? (await this.memory.get(key));
    }
    if (text === MARKER) {
      const fromIdb = await this.idb.get(key);
      if (fromIdb === null) throw Object.assign(new Error("the record is missing from IndexedDB"), { missing: true });
      this.inIdb.add(key);
      return fromIdb;
    }
    if (text === null) {
      // The marker write can fail when localStorage is full.
      const fromIdb = await this.idb.get(key).catch(() => null);
      if (fromIdb !== null) {
        this.inIdb.add(key);
        return fromIdb;
      }
    }
    return text ?? (await this.memory.get(key));
  }

  private async writeRaw(key: string, text: string): Promise<{ where: Where; reason?: NotSaved }> {
    let quota = false;
    try {
      await this.local.set(key, text);
      if (this.inIdb.delete(key)) this.idb.remove(key).catch(() => {});
      this.memory.remove(key).catch(() => {});
      return { where: "local" };
    } catch (e) {
      quota ||= isQuota(e);
    }
    try {
      await this.idb.set(key, text);
      this.inIdb.add(key);
      await this.local.set(key, MARKER).catch(() => {});
      this.memory.remove(key).catch(() => {});
      return { where: "indexeddb" };
    } catch (e) {
      quota ||= isQuota(e);
      await this.memory.set(key, text);
      return { where: "memory", reason: quota ? "quota" : "blocked" };
    }
  }

  /** A read-only store never writes here. */
  async load(): Promise<LoadResult> {
    this.guarded = false;
    let raw: string | null;
    try {
      raw = await this.readRaw(KEY);
    } catch (e) {
      if ((e as { missing?: boolean }).missing) return { kind: "empty", lost: true };
      if (e instanceof BlockedError) {
        this.guarded = "blocked";
        return { kind: "blocked" };
      }
      this.guarded = "unreadable";
      return { kind: "unreadable", reason: "read-failed", detail: e instanceof Error ? e.message : String(e) };
    }
    if (raw === null) {
      await this.adoptLegacyBackup();
      return { kind: "empty" };
    }
    const parsed = parseRecord(raw);
    if (parsed.kind === "newer") {
      this.guarded = "unreadable";
      return { kind: "unreadable", reason: "newer", detail: `it was saved by a newer version of cv-tools (record format ${parsed.format})` };
    }
    if (parsed.kind === "damaged") {
      const key = quarantineKey(raw);
      if (!this.writable || (await this.writeRaw(key, raw)).where === "memory") this.guarded = "unreadable";
      return { kind: "quarantined", key, raw, detail: parsed.detail };
    }
    await this.adoptLegacyBackup();
    return { kind: "ok", workspace: parsed.workspace, upgraded: parsed.format < FORMAT };
  }

  async peek(): Promise<Workspace | null> {
    try {
      const raw = await this.readRaw(KEY);
      const p = raw === null ? null : parseRecord(raw);
      return p?.kind === "ok" ? p.workspace : null;
    } catch {
      return null;
    }
  }

  /** Stop guarding: copy the record aside. Returns the key, "untouched" (unreadable, left in place) or null (no room). */
  async startFresh(): Promise<string | "untouched" | null> {
    let raw: string | null = null;
    try {
      raw = await this.readRaw(KEY);
    } catch {
      raw = null;
    }
    let kept: string | "untouched" = "untouched";
    if (raw !== null) {
      kept = quarantineKey(raw);
      if ((await this.writeRaw(kept, raw)).where === "memory") return null;
    }
    this.guarded = false;
    return kept;
  }

  /** Saves run in order and only the newest pending one is written. */
  save(files: Files): Promise<SaveResult> {
    const seq = ++this.seq;
    const run = async (): Promise<SaveResult> => {
      if (seq !== this.seq) return { where: this.where, superseded: true };
      const record = (savedAt: number) => JSON.stringify({ format: FORMAT, files, savedAt });
      if (this.guarded || !this.writable) {
        await this.memory.set(KEY, record(this.now()));
        return { where: "memory", reason: this.guarded === "blocked" ? "blocked" : "guarded" };
      }
      const savedAt = this.now();
      const out = await this.writeRaw(KEY, record(savedAt));
      this.where = out.where;
      return out.where === "memory" ? out : { ...out, savedAt };
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async settled(): Promise<void> {
    await this.chain;
  }

  async memoryCopy(): Promise<Workspace | null> {
    const raw = await this.memory.get(KEY);
    const p = raw === null ? null : parseRecord(raw);
    return p?.kind === "ok" ? p.workspace : null;
  }

  // ---------------------------------------------------------------- undo

  /** The CV that the last replacement replaced, or null. A damaged record is copied aside first. */
  async undoSnapshot(): Promise<Snapshot | null> {
    if (this.undoMemory) return this.undoMemory;
    let raw: string | null;
    try {
      raw = await this.readRaw(UNDO);
    } catch {
      this.undoGuarded = true;
      return null;
    }
    if (raw === null) return null;
    const snap = parseSnapshot(raw);
    if (!snap && (!this.writable || (await this.writeRaw(quarantineKey(raw), raw)).where === "memory")) this.undoGuarded = true;
    return snap;
  }

  /** Replaces the one undo snapshot. */
  async keepForUndo(files: Files, name: string, offer = true): Promise<{ where: Where; reason?: NotSaved }> {
    if (!this.undoMemory) await this.undoSnapshot();
    const snap: Snapshot = { files: { ...files }, name, savedAt: this.now(), offer };
    if (this.undoGuarded || !this.writable) {
      this.undoMemory = snap;
      return { where: "memory", reason: "guarded" };
    }
    const out = await this.writeRaw(UNDO, JSON.stringify({ format: FORMAT, ...snap }));
    this.undoMemory = out.where === "memory" ? snap : null;
    return out;
  }

  /** The Undo notice is not offered again after a reload. */
  async stopOfferingUndo(): Promise<void> {
    const snap = await this.undoSnapshot();
    if (snap?.offer) await this.keepForUndo(snap.files, snap.name, false);
  }

  /** The single backup slot of earlier versions becomes the undo snapshot when there is none. */
  private async adoptLegacyBackup() {
    if (!this.writable) return;
    try {
      const raw = await this.readRaw(LEGACY_BACKUP);
      const p = raw ? parseRecord(raw) : null;
      if (p?.kind !== "ok" || (await this.undoSnapshot()) || this.undoGuarded) return;
      if ((await this.keepForUndo(p.workspace.files, "cv.yaml", false)).where === "memory") return;
      await this.local.remove(LEGACY_BACKUP).catch(() => {});
      await this.idb.remove(LEGACY_BACKUP).catch(() => {});
    } catch {
      // keep the legacy backup where it is
    }
  }
}

/** UI preferences (layout, file tab). Failures are ignored. */
export const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem("cv-tools:" + key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem("cv-tools:" + key, value);
    } catch {
      // ignore
    }
  },
};
