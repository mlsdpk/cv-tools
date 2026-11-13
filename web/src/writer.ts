// One tab at a time edits the CV: it holds the writer lock. Other tabs are read-only and follow its saves.

const NAME = "cv-tools:writer";
/** How long another tab waits for the writer to save before it takes the lock anyway. */
const YIELD_TIMEOUT = 2000;
const LEASE_TTL = 3000;
const BEAT = 1000;

type Message = { type: "saved" | "take" | "yielded"; by: string };

export interface WriterHooks {
  /** This tab gained (true) or lost (false) the lock after start(). */
  change(writer: boolean): void;
  /** Another tab asks for the lock: save everything first. */
  yield(): Promise<void>;
  /** Another tab saved the workspace. */
  saved(): void;
}

interface Backend {
  tryAcquire(): Promise<boolean>;
  steal(): Promise<void>;
  /** Wait for the lock; `granted` runs when it is free and this tab is visible. */
  wait(): void;
  cancelWait(): void;
  release(): void;
  /** Stop writing and let another tab take the lock; take it back if nobody does. */
  stepBack(): void;
}

class LockBackend implements Backend {
  private releaseLock: (() => void) | null = null;
  private waiting: AbortController | null = null;

  constructor(
    private locks: LockManager,
    private granted: () => void,
    private lost: () => void,
  ) {}

  private request(options: LockOptions, onGrant?: () => void): Promise<boolean> {
    return new Promise((resolve) => {
      let held = false;
      const end = () => {
        if (held) {
          this.releaseLock = null;
          this.lost();
        } else {
          resolve(false);
        }
      };
      this.locks
        .request(NAME, options, (lock) => {
          // A tab in the background gives the lock back at once and asks again when it is shown.
          if (!lock || (onGrant && document.hidden)) return void resolve(false);
          held = true;
          const hold = new Promise<void>((r) => (this.releaseLock = r));
          resolve(true);
          onGrant?.();
          return hold;
        })
        .then(end, end);
    });
  }

  tryAcquire() {
    return this.request({ ifAvailable: true });
  }

  async steal() {
    await this.request({ steal: true });
  }

  wait() {
    if (this.waiting || this.releaseLock) return;
    const ctrl = new AbortController();
    this.waiting = ctrl;
    void this.request({ signal: ctrl.signal }, () => this.granted()).then(() => {
      if (this.waiting === ctrl) this.waiting = null;
    });
  }

  cancelWait() {
    this.waiting?.abort();
    this.waiting = null;
  }

  release() {
    this.releaseLock?.();
  }

  stepBack() {
    const held = this.releaseLock;
    setTimeout(() => {
      if (held && this.releaseLock === held) this.granted();
    }, 2 * YIELD_TIMEOUT);
  }
}

/** Without Web Locks: a lease in localStorage that the writer renews. */
class LeaseBackend implements Backend {
  private held = false;
  private waiting = false;

  constructor(
    private id: string,
    private granted: () => void,
    private lost: () => void,
    private storage: () => Storage = () => localStorage,
  ) {
    setInterval(() => this.beat(), BEAT);
  }

  private read(): { id: string; until: number } | null {
    try {
      return JSON.parse(this.storage().getItem(NAME) ?? "null");
    } catch {
      return null;
    }
  }

  /** False when storage is blocked: the tabs cannot coordinate, so each one writes. */
  private write(lease: { id: string; until: number } | null): boolean {
    try {
      if (lease) this.storage().setItem(NAME, JSON.stringify(lease));
      else this.storage().removeItem(NAME);
      return true;
    } catch {
      return false;
    }
  }

  private free(): boolean {
    const l = this.read();
    return !l || l.id === this.id || l.until < Date.now();
  }

  private claim(): boolean {
    if (!this.write({ id: this.id, until: Date.now() + LEASE_TTL })) return true;
    return this.read()?.id === this.id;
  }

  async tryAcquire() {
    this.held = this.free() && this.claim();
    return this.held;
  }

  async steal() {
    this.claim();
    this.held = true;
  }

  private beat() {
    if (this.held) {
      const l = this.read();
      if (l && l.id !== this.id) {
        this.held = false;
        this.lost();
      } else {
        this.claim();
      }
    } else if (this.waiting && !document.hidden && this.free() && this.claim()) {
      this.held = true;
      this.waiting = false;
      this.granted();
    }
  }

  wait() {
    this.waiting = true;
  }

  cancelWait() {
    this.waiting = false;
  }

  release() {
    if (this.held && this.read()?.id === this.id) this.write(null);
    this.held = false;
  }

  stepBack() {
    this.held = false;
    setTimeout(() => (this.waiting = true), YIELD_TIMEOUT + BEAT);
  }
}

export class Writer {
  readonly id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  writer = false;
  private channel: BroadcastChannel | null = null;
  private backend: Backend;
  private yielded: (() => void) | null = null;

  constructor(
    private hooks: WriterHooks,
    locks: LockManager | undefined = navigator.locks,
  ) {
    const granted = () => this.set(true);
    const lost = () => {
      this.set(false);
      this.backend.wait();
    };
    this.backend = locks ? new LockBackend(locks, granted, lost) : new LeaseBackend(this.id, granted, lost);
    try {
      this.channel = new BroadcastChannel("cv-tools");
      this.channel.onmessage = (e) => void this.onMessage(e.data as Message);
    } catch {
      window.addEventListener("storage", (e) => {
        if (e.key === "cv-tools:workspace") hooks.saved();
      });
    }
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !this.writer) this.backend.wait();
    });
    window.addEventListener("pagehide", (e) => {
      if (e.persisted) this.set(false);
      this.backend.release();
    });
    window.addEventListener("pageshow", (e) => {
      if (e.persisted && !this.writer) this.backend.wait();
    });
  }

  /** Take the lock if no other tab has it. */
  async start(): Promise<boolean> {
    this.writer = await this.backend.tryAcquire();
    if (!this.writer) this.backend.wait();
    return this.writer;
  }

  /** "Use here": the writer saves and steps back, then this tab takes the lock. */
  async take() {
    if (this.writer) return;
    this.backend.cancelWait();
    const yielded = new Promise<void>((r) => (this.yielded = r));
    this.post("take");
    await Promise.race([yielded, new Promise((r) => setTimeout(r, YIELD_TIMEOUT))]);
    this.yielded = null;
    await this.backend.steal();
    this.set(true);
  }

  announceSaved() {
    this.post("saved");
  }

  private post(type: Message["type"]) {
    this.channel?.postMessage({ type, by: this.id } satisfies Message);
  }

  private async onMessage(m: Message) {
    if (!m || m.by === this.id) return;
    if (m.type === "saved") this.hooks.saved();
    else if (m.type === "yielded") this.yielded?.();
    else if (m.type === "take" && this.writer) {
      await this.hooks.yield();
      this.set(false);
      this.backend.stepBack();
      this.post("yielded");
    }
  }

  private set(on: boolean) {
    if (this.writer === on) return;
    this.writer = on;
    this.hooks.change(on);
  }
}
