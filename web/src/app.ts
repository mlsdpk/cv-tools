// The app: wires the editor, Python, the previews, storage and the menus.

import { visit } from "yaml";
import { Editor } from "./editor";
import { Engine, ENGINE_IS_STUB, failureMessage, logExcerpt, type EngineState } from "./engine";
import { download, droppedFiles, pickFiles, writeBack, type OpenedFile } from "./files";
import { pdfBreaks } from "./pages";
import { LivePreview } from "./preview";
import { PyClient, PyTimeoutError } from "./py/client";
import type { Diagnostic } from "./py/protocol";
import { LONG_LINK, readFragment, shareLink } from "./share";
import { BASE_URL, PYODIDE_BYTES, SITE } from "./site";
import { prefs, WorkspaceStore, type Files, type LoadResult, type NotSaved, type Workspace } from "./storage";
import { Writer } from "./writer";
import { formatPath, looksLikeV1, parseCached, referencedBibs, type YamlPath } from "./yamlDoc";
import { zip } from "./zip";
import { startErrorMessage } from "./startError";

type Layout = "split" | "paper" | "yaml";
type PhoneTab = "yaml" | "cv";
type Action = { label: string; run: () => void };

/** A file the app can write back to; `text` is what the disk holds. */
interface DiskFile {
  handle: FileSystemFileHandle;
  lastModified?: number;
  eol: "\n" | "\r\n";
  text: string;
}

const MAIN = "cv.yaml";
/** Each menu and the buttons that open it. */
const MENUS: Record<string, string[]> = { "open-menu": ["open-btn", "m-open"], "download-menu": ["download-more", "m-download"] };
const HTML_DEBOUNCE = 150;
const PDF_DEBOUNCE = 800;
const SAVE_DEBOUNCE = 400;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function since(): number {
  return Math.round(performance.now());
}

const mb = (n: number) => (n / 1e6).toFixed(n < 1e7 ? 1 : 0);
const sameFiles = (a: Files, b: Files) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export const MINIMAL = `version: 2
name: Your Name

contact:
  - - your.name@example.com

sections:
  - title: Experience
    layout: entries
    entries:
      - title: Company Name
        date: 2024 - Present
        subtitle: Job Title
`;

export function hasRawLatex(text: string): boolean {
  let found = false;
  try {
    visit(parseCached(text), {
      Map(_, node) {
        if (node.items.some((p) => (p.key as { value?: unknown } | null)?.value === "latex")) {
          found = true;
          return visit.BREAK;
        }
      },
    });
  } catch {
    return /\blatex\s*:/.test(text);
  }
  return found;
}

const LATEX_NOTE = "This CV contains raw LaTeX ({latex: ...}), which runs as code when you compile it with pdflatex on your computer.";

export class App {
  private app = $("app");
  private files: Files = { [MAIN]: "" };
  private displayName = MAIN;
  private disk = new Map<string, DiskFile>();
  private layout: Layout = (prefs.get("layout") as Layout) || "split";
  private phoneTab: PhoneTab = "cv";
  private phone = window.matchMedia("(max-width: 720px)");
  readonly store = new WorkspaceStore();
  private editor: Editor;
  private live: LivePreview;
  private py: PyClient;
  private engine: Engine;
  private pyReady = false;
  private pyStatus = "loading Python";
  /** This build of cv-tools has no HTML renderer. */
  private liveMissing = false;
  /** The renderer failed on this CV: the PDF is shown until `liveRetryAt`, with a growing backoff. */
  private liveFailures = 0;
  private liveRetryAt = 0;
  private diagnostics = new Map<string, Diagnostic[]>();
  private validity: { ok: boolean; message: string; count: number } | null = null;
  private v1 = false;
  private generation = 0;
  private textVersion = 0;
  private pdfGeneration = 0;
  /** The text version of the last PDF read for page breaks. */
  private pdfFor = -1;
  private htmlTimer = 0;
  private pdfTimer = 0;
  private saveTimer = 0;
  private savedSnapshot = "";
  private notSaved: NotSaved | null = null;
  /** The example alone is never saved. */
  private hasWork = false;
  /** A shared CV is saved only after it validated once (a hostile link must not stick). */
  private awaitingValidation = false;
  /** Another tab holds the writer lock: this one shows the CV and never saves. */
  private readOnly = false;
  /** A share link opened while read-only, opened when this tab gets the lock. */
  private pendingShare: string | null = null;
  private downloading = false;
  private lastPath: YamlPath | null = null;
  private lock: Writer;
  private refreshing = false;
  /** The change comes from the page, which waits for its render: no debounce. */
  private pageEdit = false;
  private refreshAgain = false;

  constructor() {
    this.editor = new Editor($("editor"), {
      onChange: (file, text) => this.onEdit(file, text),
      onCursor: (file, path, line, col) => this.onCursor(file, path, line, col),
    });
    this.live = new LivePreview($("live"), {
      yaml: () => this.files[MAIN] ?? "",
      apply: (text) => {
        this.pageEdit = true;
        this.editor.setText(MAIN, text);
        this.pageEdit = false;
      },
      reveal: (path) => {
        if (this.effectiveLayout() === "split") this.editor.reveal(path, false);
      },
      notify: (message, actions) => this.notice(message, actions, 8000),
      undo: () => this.undo(),
      confirm: (message, ok) => this.ask(message, ok),
      bibs: () => Object.keys(this.files).filter((n) => n !== MAIN),
      addFile: (name, text) => {
        this.files[name] = text;
        this.editor.setFiles(this.files, this.editor.current);
        this.renderTabs();
      },
      pages: () => this.updatePageInfo(),
    });
    this.engine = new Engine((s) => this.onEngine(s));
    this.app.dataset.engineKind = ENGINE_IS_STUB ? "stub" : "wasm";
    this.py = new PyClient(
      BASE_URL,
      (stage, done, total) => {
        if (this.pyReady) return;
        this.pyStatus = stage === "download" ? `loading Python ${mb(done)} / ${mb(Math.max(done, total))} MB` : "starting cv-tools";
        this.setValid(this.pyStatus, "loading");
      },
      {
        totalBytes: PYODIDE_BYTES,
        onRestart: () => {
          this.app.dataset.pyRestarts = String(this.py.restarts);
        },
      },
    );
    this.lock = new Writer({
      change: (writer) => void this.onWriterChange(writer),
      yield: () => this.yieldLock(),
      saved: () => void this.otherTabSaved(),
    });
  }

  // ------------------------------------------------------------ start

  async start() {
    $<HTMLAnchorElement>("github").href = `https://github.com/${SITE.repository}`;
    if (SITE.coffee) {
      $<HTMLAnchorElement>("coffee").href = SITE.coffee;
      $("coffee").hidden = false;
    }
    this.bindUi();
    this.setReadOnly(!(await this.lock.start()));
    await this.loadInitial();
    await this.openShareLink(location.hash, true);
    this.applyLayout();
    this.py.ready.then(
      async () => {
        this.pyReady = true;
        this.app.dataset.py = "ready";
        this.app.dataset.tPy = String(since());
        this.refresh();
        const [schema, version] = await Promise.all([this.py.schema(), this.py.version()]);
        if (schema.ok && schema.schema) this.editor.schema = schema.schema as Record<string, unknown>;
        if (version.python) this.app.dataset.python = version.python;
        navigator.serviceWorker?.ready.then((r) => r.active?.postMessage({ type: "warm" })).catch(() => {});
      },
      (e) => {
        this.app.dataset.py = "error";
        this.setValid("Python failed to load", "error");
        console.error(e);
        // A waiting new version may fix it: keep its Reload in view.
        if (this.update) return;
        this.notice(startErrorMessage(e), [{ label: "Reload", run: () => location.reload() }]);
      },
    );
  }

  private async loadInitial() {
    const r = await this.store.load();
    if (r.kind === "ok") {
      this.hasWork = true;
      this.setWorkspace(r.workspace.files, prefs.get("tab") ?? MAIN, prefs.get("name") ?? MAIN);
      this.savedSnapshot = JSON.stringify(r.workspace.files);
      const snap = await this.store.undoSnapshot();
      if (snap?.offer) this.offerUndo("The CV was replaced.");
      return;
    }
    // The example is not saved until the user changes something.
    this.setWorkspace(await this.example(), MAIN, MAIN);
    this.loadNotice(r);
  }

  private loadNotice(r: LoadResult) {
    const reload = { label: "Reload", run: () => location.reload() };
    const fresh = { label: "Start fresh", run: () => void this.startFresh() };
    if (r.kind === "empty" && r.lost) {
      this.notice("A CV saved in this browser was kept in IndexedDB, which is now empty (the browser may have cleared it). This is the example.", [], 0);
    } else if (r.kind === "blocked") {
      this.notice("This browser blocks storage for this site, so cv-tools cannot open or save a CV here. Anything saved before is untouched. Download your work to keep it.", [reload], 0);
    } else if (r.kind === "unreadable") {
      const why = r.reason === "newer" ? "it was saved by a newer version of cv-tools" : "the browser could not read its storage";
      this.notice(`Your saved CV could not be opened: ${why}. It has not been changed, and this tab does not save over it.`, [reload, fresh], 0);
    } else if (r.kind === "quarantined") {
      const kept = this.store.guarded ? "It is untouched, and this tab does not save over it" : "It was kept aside, unchanged";
      this.notice(`A CV saved in this browser could not be read (${r.detail}). ${kept}. This is the example.`, [
        { label: "Download the saved data", run: () => download("cv-tools-saved-data.json", r.raw, "application/json") },
      ], 0);
    }
  }

  /** Keep the record this tab cannot open aside, and save again. */
  private async startFresh() {
    const kept = await this.store.startFresh();
    if (kept === null) {
      this.notice("cv-tools could not keep a copy of the old data (browser storage is full), so it did not start fresh.", [], 0);
      return;
    }
    this.notSaved = null;
    if (this.hasWork) await this.save();
    this.updateFileState();
    this.notice(kept === "untouched" ? "Started fresh. The old data could not be read and stays where it was." : "Started fresh. The old data is kept aside in this browser.", [], 8000);
  }

  private async example(): Promise<Files> {
    const get = async (name: string) => {
      const res = await fetch(new URL(`example/${name}`, BASE_URL));
      if (!res.ok) throw new Error(`example/${name}: HTTP ${res.status}`);
      return res.text();
    };
    try {
      const files: Files = { [MAIN]: await get(MAIN) };
      for (const bib of referencedBibs(files[MAIN])) {
        try {
          files[bib] = await get(bib);
        } catch {
          // a missing example bib shows up as a validation error
        }
      }
      return files;
    } catch {
      return { [MAIN]: "version: 2\nname: Your Name\nsections: []\n" };
    }
  }

  private setWorkspace(files: Files, show: string, name: string) {
    this.files = { ...files };
    this.displayName = name;
    prefs.set("name", name);
    this.diagnostics.clear();
    this.v1 = false;
    this.editor.setFiles(this.files, show);
    this.live.textChanged(++this.textVersion);
    this.renderTabs();
    this.updateFileState();
    this.scheduleRefresh(0);
  }

  /** Replace the workspace, keeping the current one as the undo snapshot. */
  private async replaceWorkspace(files: Files, options: { name: string; disk?: Map<string, DiskFile>; awaitValidation?: boolean }): Promise<string> {
    this.live.finishEdit(false);
    this.flushSave();
    let note = "";
    if (this.hasWork && !sameFiles(this.files, files)) {
      const kept = await this.store.keepForUndo(this.files, this.displayName);
      if (kept.where === "memory") note = " The previous CV is kept only in this tab (browser storage is full or blocked): undo now or download it to keep it.";
    }
    this.disk = options.disk ?? new Map();
    this.setWorkspace(files, MAIN, options.name);
    this.hasWork = true;
    this.awaitingValidation = !!options.awaitValidation;
    if (this.awaitingValidation) this.updateFileState();
    else this.save();
    return note;
  }

  /** Asks before `files` replace work; true to go on. */
  private confirmReplace(files: Files, what: string): Promise<boolean> {
    if (!this.hasWork || sameFiles(files, this.files)) return Promise.resolve(true);
    const dialog = $<HTMLDialogElement>("replace");
    const opener = document.activeElement as HTMLElement | null;
    $("replace-text").textContent = `${what} replaces the CV you have open. You can undo it afterwards.`;
    dialog.showModal();
    $("replace-ok").focus();
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        dialog.removeEventListener("close", onCancel);
        $("replace-ok").removeEventListener("click", onOk);
        $("replace-cancel").removeEventListener("click", onCancel);
        if (dialog.open) dialog.close();
        if (!ok) opener?.focus();
        resolve(ok);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      dialog.addEventListener("close", onCancel);
      $("replace-ok").addEventListener("click", onOk);
      $("replace-cancel").addEventListener("click", onCancel);
    });
  }

  /** Asks a yes-or-no question; true for `ok`. */
  private ask(message: string, ok: string): Promise<boolean> {
    const dialog = $<HTMLDialogElement>("ask");
    const opener = (document.activeElement?.shadowRoot?.activeElement ?? document.activeElement) as HTMLElement | null;
    $("ask-text").textContent = message;
    $("ask-ok").textContent = ok;
    dialog.showModal();
    $("ask-ok").focus();
    return new Promise((resolve) => {
      const done = (yes: boolean) => {
        dialog.removeEventListener("close", onNo);
        $("ask-ok").removeEventListener("click", onYes);
        $("ask-cancel").removeEventListener("click", onNo);
        if (dialog.open) dialog.close();
        if (!yes) opener?.focus();
        resolve(yes);
      };
      const onYes = () => done(true);
      const onNo = () => done(false);
      dialog.addEventListener("close", onNo);
      $("ask-ok").addEventListener("click", onYes);
      $("ask-cancel").addEventListener("click", onNo);
    });
  }

  /** Replace after asking, then offer Undo. */
  private async replaceWith(files: Files, what: string, options: { name: string; disk?: Map<string, DiskFile>; awaitValidation?: boolean; done: string }) {
    if (!this.canWrite() || !(await this.confirmReplace(files, what))) return;
    const replaced = this.hasWork && !sameFiles(files, this.files);
    const note = await this.replaceWorkspace(files, options);
    if (replaced) this.offerUndo(`${options.done}${note}`);
    else this.notice(options.done, [], 8000);
  }

  private offerUndo(message: string) {
    this.notice(message, [{ label: "Undo", run: () => void this.restoreUndo() }], 0, undefined, () => void this.store.stopOfferingUndo());
  }

  /** Puts back the CV the last replacement replaced; the one replaced now becomes the undo snapshot. */
  private async restoreUndo() {
    if (!this.canWrite()) return;
    const snap = await this.store.undoSnapshot();
    if (!snap) {
      this.notice("There is no previous CV to restore.", [], 5000);
      return;
    }
    const note = await this.replaceWorkspace(snap.files, { name: snap.name });
    this.offerUndo(`Restored the previous CV.${note}`);
  }

  // ------------------------------------------------------------ share links

  /** Asks first when the link would replace work. */
  private async openShareLink(hash: string, initial = false) {
    if (!hash.startsWith("#cv=")) return;
    history.replaceState(null, "", location.pathname + location.search);
    if (this.readOnly) {
      this.pendingShare = hash;
      this.notice("This CV is open in another tab. Choose Use here to open the shared CV in this tab.", [], 0);
      return;
    }
    let shared: Files | null;
    try {
      shared = await readFragment(hash);
    } catch (e) {
      this.notice(`The share link could not be opened: ${e instanceof Error ? e.message : e}.`, [], 0);
      return;
    }
    if (!shared) return;
    if (sameFiles(shared, this.files)) {
      if (!initial) this.notice("The share link holds the CV you already have open.", [], 5000);
      return;
    }
    const latex = hasRawLatex(shared[MAIN]) ? " " + LATEX_NOTE : "";
    await this.replaceWith(shared, "The shared CV", { name: MAIN, awaitValidation: true, done: `Opened a shared CV. It is saved in this browser once it is valid.${latex}` });
  }

  // ------------------------------------------------------------ UI bindings

  private bindUi() {
    for (const b of document.querySelectorAll<HTMLButtonElement>("#layout-switch button")) {
      b.addEventListener("click", () => this.setLayout(b.dataset.layout as Layout));
    }
    const phoneTabs = [...document.querySelectorAll<HTMLButtonElement>("[data-phone-tab]")];
    for (const b of phoneTabs) {
      b.addEventListener("click", () => this.setPhoneTab(b.dataset.phoneTab as PhoneTab));
      b.addEventListener("keydown", (e) => {
        const i = phoneTabs.indexOf(b);
        const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? phoneTabs.length - 1 : null;
        if (next === null) return;
        e.preventDefault();
        const t = phoneTabs[(next + phoneTabs.length) % phoneTabs.length];
        this.setPhoneTab(t.dataset.phoneTab as PhoneTab);
        t.focus();
      });
    }
    this.phone.addEventListener("change", () => this.applyLayout());
    $("download-pdf").addEventListener("click", () => this.downloadPdf());
    for (const [id, triggers] of Object.entries(MENUS)) {
      const menu = $(id);
      for (const t of triggers) $(t).addEventListener("click", () => this.toggleMenu(id, $(t)));
      menu.addEventListener("click", (e) => {
        const item = (e.target as Element).closest<HTMLButtonElement>("[data-action]");
        if (!item) return;
        this.closeMenu();
        this.menuAction(item.dataset.action!);
      });
      menu.addEventListener("keydown", (e) => {
        const items = [...menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          items[e.key === "Home" ? 0 : items.length - 1].focus();
        } else if (e.key === "Tab") {
          this.closeMenu(false);
        }
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.openMenu) {
        this.closeMenu();
        e.preventDefault();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        this.saveToDisk();
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (this.openMenu && !(e.target as Element).closest(".menu-wrap")) this.closeMenu(false);
    });
    $("replace-download").addEventListener("click", () => this.downloadYaml());
    $("preview-scroll").addEventListener("scroll", () => this.updatePageInfo(), { passive: true });
    $("use-here").addEventListener("click", () => void this.lock.take());
    $("paper-undo").addEventListener("click", () => this.undo());
    $("hint-migrate").addEventListener("click", () => void this.migrate());
    // The editor's cursor is marked on the page only while the editor has focus.
    this.editor.view.contentDOM.addEventListener("focus", () => this.live.highlight(this.effectiveLayout() === "split" ? this.lastPath : null, false));
    this.editor.view.contentDOM.addEventListener("blur", () => this.live.highlight(null));

    const drop = $("drop");
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    window.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      depth++;
      drop.hidden = false;
    });
    window.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (!depth) drop.hidden = true;
    });
    window.addEventListener("dragover", (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      drop.hidden = true;
      // droppedFiles reads the DataTransfer synchronously before its first await.
      droppedFiles(e.dataTransfer!).then(
        (files) => this.openFiles(files),
        (err) => this.notice(String(err instanceof Error ? err.message : err), [], 8000),
      );
    });

    window.addEventListener("hashchange", () => void this.openShareLink(location.hash));

    new ResizeObserver(() => this.fit()).observe($("preview-scroll"));
    window.addEventListener("beforeunload", (e) => {
      this.live.finishEdit(false);
      this.flushSave();
      if (this.onlyInMemory()) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
    // Stop Python on navigation so its downloads end quietly; a page restored from the bfcache restarts.
    window.addEventListener("pagehide", (e) => {
      this.live.finishEdit(false);
      this.flushSave();
      if (!e.persisted) this.py.terminate();
    });
    window.addEventListener("pageshow", (e) => {
      if (e.persisted && this.app.dataset.py !== "ready") location.reload();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        this.live.finishEdit(false);
        this.flushSave();
      } else if (this.pdfFor !== this.textVersion) {
        this.schedulePdf(0);
      }
    });
  }

  private openMenu: { menu: HTMLElement; trigger: HTMLElement } | null = null;

  private toggleMenu(id: string, trigger: HTMLElement) {
    const was = this.openMenu?.menu.id;
    this.closeMenu(false);
    if (was === id) {
      trigger.focus();
      return;
    }
    const menu = $(id);
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    this.openMenu = { menu, trigger };
    menu.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }

  private closeMenu(focusTrigger = true) {
    const open = this.openMenu;
    if (!open) return;
    this.openMenu = null;
    open.menu.hidden = true;
    open.trigger.setAttribute("aria-expanded", "false");
    if (focusTrigger) open.trigger.focus();
  }

  private menuAction(action: string) {
    if (action === "pdf") this.downloadPdf();
    else if (action === "latex") this.downloadLatex();
    else if (action === "yaml") this.downloadYaml();
    else if (action === "share") this.copyShareLink();
    else if (action === "new") void this.replaceWith({ [MAIN]: MINIMAL }, "A new CV", { name: MAIN, done: "Started a new CV." });
    else if (action === "example") void this.example().then((files) => this.replaceWith(files, "The example", { name: MAIN, done: "Opened the example." }));
    else if (action === "open") this.open();
  }

  private undo() {
    if (this.readOnly) return;
    if (this.editor.current !== MAIN) this.editor.show(MAIN);
    this.editor.undo();
  }

  // ------------------------------------------------------------ layout

  private effectiveLayout(): Layout {
    if (this.phone.matches) return this.phoneTab === "yaml" ? "yaml" : "paper";
    return this.layout;
  }

  private setLayout(layout: Layout) {
    this.layout = layout;
    prefs.set("layout", layout);
    this.applyLayout();
  }

  private setPhoneTab(tab: PhoneTab) {
    this.phoneTab = tab;
    this.applyLayout();
  }

  private liveBroken(): boolean {
    return this.liveMissing || Date.now() < this.liveRetryAt;
  }

  private showsLive(): boolean {
    return this.effectiveLayout() !== "yaml" && !this.liveBroken();
  }

  private applyLayout() {
    const layout = this.effectiveLayout();
    const wasLive = this.app.dataset.showsLive === "true";
    this.app.dataset.layout = layout;
    this.app.dataset.phone = String(this.phone.matches);
    for (const b of document.querySelectorAll<HTMLButtonElement>("#layout-switch button")) b.setAttribute("aria-pressed", String(b.dataset.layout === this.layout));
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-phone-tab]")) {
      const on = b.dataset.phoneTab === this.phoneTab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    const live = this.showsLive();
    this.app.dataset.showsLive = String(live);
    this.updateEditable();
    // The editor cursor is marked on the page only next to the focused editor.
    this.live.highlight(layout === "split" && this.editor.view.hasFocus ? this.lastPath : null, false);
    this.updateMessage();
    this.updateStatusLine();
    this.fit();
    if (live && !wasLive) this.scheduleRefresh(0);
    if (live && this.pdfFor !== this.textVersion) this.schedulePdf(0);
    if (layout === "yaml" || layout === "split") this.editor.view.requestMeasure();
  }

  /** The page is editable unless the YAML is invalid or v1; then it is greyed out and the hint says why. */
  private updateEditable() {
    const live = this.showsLive();
    const blocked = this.v1 ? "v1" : this.validity && !this.validity.ok ? "invalid" : null;
    this.live.setEditable(live && !this.readOnly && !blocked);
    this.live.setBlocked(live && !!blocked);
    $("paper-hint").textContent =
      blocked === "v1" ? "Migrate to v2 to edit on the page" : blocked ? "Fix the YAML error to edit on the page" : this.phone.matches ? "Tap any text to edit it" : "Click any text to edit it";
    $("hint-migrate").hidden = blocked !== "v1";
  }

  private zoom(): number {
    const scroller = $("preview-scroll");
    const style = getComputedStyle(scroller);
    const avail = scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - (this.phone.matches ? 16 : 0);
    return Math.max(0.3, Math.min(1, avail / this.pageWidth()));
  }

  /** Letter paper is 8.5 in, 816 CSS pixels; the live page reports its own width. */
  private pageWidth(): number {
    return this.live.hasContent ? this.live.pageWidth() : 816;
  }

  private fitTimer = 0;

  private fit() {
    clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => {
      if (this.effectiveLayout() === "yaml") return;
      this.live.setZoom(this.zoom());
      if (this.live.needsPages) this.live.repaginate();
      this.updatePageInfo();
    }, 30);
  }

  /** "Page N of M": N is the page at the top of the view. */
  private updatePageInfo() {
    const pages = this.live.pages();
    const top = $("preview-scroll").getBoundingClientRect().top;
    let current = 1;
    pages.forEach((p, i) => {
      if (p.getBoundingClientRect().top - top < 80) current = i + 1;
    });
    $("page-info").textContent = pages.length && this.showsLive() ? `Page ${current} of ${pages.length}` : "";
  }

  private updateMessage() {
    const msg = $("preview-message");
    if (this.liveBroken() && this.effectiveLayout() !== "yaml") {
      msg.textContent = this.liveMissing
        ? "This build of cv-tools has no live preview. Edit the YAML and download the PDF."
        : "The live preview failed on this CV (a bug in cv-tools; details in the browser console). It tries again after your next change.";
      msg.hidden = false;
    } else {
      msg.hidden = true;
    }
  }

  // ------------------------------------------------------------ editing

  private onEdit(file: string, text: string) {
    const bibsBefore = file === MAIN ? referencedBibs(this.files[MAIN] ?? "").join("\n") : "";
    this.files[file] = text;
    if (file === MAIN) this.live.textChanged(++this.textVersion);
    if (file === MAIN && referencedBibs(text).join("\n") !== bibsBefore) this.renderTabs();
    this.hasWork = true;
    this.scheduleSave();
    this.updateFileState();
    this.scheduleRefresh(this.pageEdit ? 0 : HTML_DEBOUNCE);
  }

  private onCursor(file: string, path: YamlPath | null, line: number, col: number) {
    $("st-pos").textContent = `Ln ${line}, Col ${col}`;
    $("st-path").textContent = path && path.length ? formatPath(path) : "";
    if (file === MAIN) {
      const same = this.lastPath && path && this.lastPath.join(".") === path.join(".");
      if (!same && this.effectiveLayout() === "split" && this.editor.view.hasFocus) this.live.highlight(path, true);
      this.lastPath = path;
    }
    if (file !== MAIN || this.editor.current !== prefs.get("tab")) prefs.set("tab", this.editor.current);
  }

  private bibFiles(): Files {
    const out: Files = {};
    for (const [name, text] of Object.entries(this.files)) if (name !== MAIN) out[name] = text;
    return out;
  }

  private renderTabs() {
    const tabs = $("file-tabs");
    const referenced = referencedBibs(this.files[MAIN] ?? "");
    const names = [MAIN, ...referenced, ...Object.keys(this.files).filter((n) => n !== MAIN && !referenced.includes(n)).sort()];
    const focused = (document.activeElement as HTMLElement | null)?.closest?.("#file-tabs [role=tab]") as HTMLElement | null;
    const focusName = focused?.dataset.file;
    tabs.replaceChildren(
      ...names.map((name) => {
        const b = document.createElement("button");
        b.type = "button";
        b.setAttribute("role", "tab");
        b.dataset.file = name;
        const selected = name === this.editor.current;
        b.setAttribute("aria-selected", String(selected));
        b.setAttribute("aria-controls", "editor");
        b.tabIndex = selected ? 0 : -1;
        const label = document.createElement("span");
        label.textContent = name === MAIN ? this.displayName : name;
        b.append(label);
        const errors = (this.diagnostics.get(name) ?? []).length;
        const missing = name !== MAIN && !(name in this.files);
        if (errors || missing) {
          const mark = document.createElement("span");
          mark.className = "tab-mark";
          mark.textContent = missing ? "(missing)" : `(${errors})`;
          mark.setAttribute("aria-label", missing ? "missing file" : `${errors} errors`);
          b.append(mark);
        }
        b.addEventListener("click", () => this.showFile(name));
        b.addEventListener("keydown", (e) => {
          const all = [...tabs.querySelectorAll<HTMLButtonElement>("[role=tab]")].map((t) => t.dataset.file!);
          const i = all.indexOf(name);
          const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : null;
          if (next === null) return;
          e.preventDefault();
          this.showFile(all[(next + all.length) % all.length], true);
        });
        return b;
      }),
    );
    if (focusName) this.focusTab(focusName);
  }

  private showFile(name: string, focus = false) {
    this.editor.show(name);
    prefs.set("tab", name);
    this.renderTabs();
    if (focus) this.focusTab(name);
  }

  /** Focus a file tab by name (tabs are rebuilt on every change, so look it up again). */
  private focusTab(name: string) {
    [...$("file-tabs").querySelectorAll<HTMLButtonElement>("[role=tab]")].find((t) => t.dataset.file === name)?.focus();
  }

  // ------------------------------------------------------------ validation and rendering

  private scheduleRefresh(delay: number) {
    clearTimeout(this.htmlTimer);
    this.htmlTimer = window.setTimeout(() => this.refresh(), delay);
  }

  /** One render runs at a time; changes made meanwhile are rendered once after it. */
  private async refresh() {
    if (!this.pyReady) return;
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        try {
          await this.refreshNow();
        } catch (e) {
          if (e instanceof PyTimeoutError) {
            this.validity = { ok: false, message: e.message, count: 1 };
            this.setValid(e.message, "error");
            this.app.dataset.valid = "invalid";
            this.updateStatusLine();
            this.updateEditable();
            this.notice(e.message, [], 0);
          } else {
            console.warn("cv-tools: validation stopped", e);
          }
        }
      } while (this.refreshAgain);
    } finally {
      this.refreshing = false;
    }
  }

  private async refreshNow() {
    const gen = ++this.generation;
    const version = this.textVersion;
    const text = this.files[MAIN] ?? "";
    const bibs = this.bibFiles();

    if (looksLikeV1(text)) {
      this.v1 = true;
      this.diagnostics.clear();
      this.editor.setDiagnostics(this.diagnostics);
      this.renderTabs();
      this.setValid("v1 format, migrate to edit", "error");
      this.validity = { ok: false, message: "v1 format, migrate to edit", count: 1 };
      this.app.dataset.valid = "v1";
      this.updateStatusLine();
      this.updateEditable();
      this.offerMigration();
      // The page shows the v1 file, which cannot be edited there.
      if (this.showsLive()) {
        const r = await this.py.renderHtml(text, bibs);
        if (gen === this.generation && r.ok && "html" in r && typeof r.html === "string") {
          this.live.show(r.html, (r as { css?: string | null }).css ?? null, version);
          this.fit();
        }
      }
      return;
    }
    this.v1 = false;

    let ok: boolean;
    let diagnostics: Diagnostic[] = [];
    let warnings: string[] = [];
    if (this.showsLive()) {
      const r = await this.py.renderHtml(text, bibs);
      if (gen !== this.generation) return;
      if ("unavailable" in r && r.unavailable) this.liveMissing = true;
      if ((r.internal && !r.diagnostics?.some((d) => d.file)) || this.liveMissing) {
        if (r.internal) {
          // A renderer bug: try again later, with a growing backoff.
          console.error("cv-tools HTML renderer failed", (r as { traceback?: string }).traceback);
          this.liveFailures++;
          this.liveRetryAt = Date.now() + Math.min(60_000, 1000 * 2 ** this.liveFailures);
        }
        this.app.dataset.live = "unavailable";
        this.applyLayout();
        const v = await this.py.validate(text, bibs);
        if (gen !== this.generation) return;
        ok = v.ok;
        diagnostics = v.diagnostics ?? [];
        warnings = v.warnings ?? [];
      } else {
        ok = r.ok;
        diagnostics = r.diagnostics ?? [];
        warnings = r.warnings ?? [];
        if (ok && "html" in r && typeof r.html === "string") {
          const wasBroken = this.liveFailures > 0;
          this.liveFailures = 0;
          this.liveRetryAt = 0;
          this.live.show(r.html, (r as { css?: string | null }).css ?? null, version);
          this.app.dataset.live = "ready";
          this.app.dataset.tFirstPreview ??= String(since());
          if (wasBroken) this.applyLayout();
          this.fit();
        }
      }
    } else {
      const v = await this.py.validate(text, bibs);
      if (gen !== this.generation) return;
      ok = v.ok;
      diagnostics = v.diagnostics ?? [];
      warnings = v.warnings ?? [];
    }

    this.showDiagnostics(diagnostics, warnings, ok);
    if (ok && this.awaitingValidation) {
      this.awaitingValidation = false;
      this.save();
    }
    if (ok && this.showsLive()) this.schedulePdf(this.pdfFor < 0 ? 0 : PDF_DEBOUNCE);
  }

  private showDiagnostics(diagnostics: Diagnostic[], warnings: string[], ok: boolean) {
    const byFile = new Map<string, Diagnostic[]>();
    for (const d of diagnostics) {
      const file = d.file && d.file in this.files ? d.file : d.file && d.file !== MAIN && d.file !== "<string>" ? d.file : MAIN;
      byFile.set(file, [...(byFile.get(file) ?? []), d]);
    }
    this.diagnostics = byFile;
    this.editor.setDiagnostics(byFile);
    this.renderTabs();
    const n = diagnostics.length;
    const valid = $("st-valid");
    valid.title = [...diagnostics.map((d) => `${d.file ?? ""}${d.line ? `:${d.line}:${d.col}` : ""}: ${d.message}`), ...warnings].join("\n");
    if (ok) {
      this.setValid(`valid · schema v2${warnings.length ? ` · ${warnings.length} warning${warnings.length > 1 ? "s" : ""}` : ""}`, "ok");
      this.app.dataset.valid = "valid";
      this.validity = { ok: true, message: "", count: 0 };
    } else {
      const first = diagnostics[0];
      const where = first?.line ? ` (${first.file && first.file !== MAIN ? first.file + " " : ""}line ${first.line})` : "";
      this.setValid(n === 1 && first ? `error: ${first.message}` : `${n} errors`, "error");
      this.app.dataset.valid = "invalid";
      this.validity = { ok: false, message: first ? `${first.message}${where}` : "the CV is not valid", count: Math.max(n, 1) };
    }
    this.updateStatusLine();
    this.updateEditable();
  }

  private setValid(text: string, state: "ok" | "error" | "loading") {
    const el = $("st-valid");
    el.textContent = text;
    el.dataset.state = state;
    this.updateStatusLine();
  }

  /** The line above the page in Paper and on a phone, where the status bar is hidden. */
  private updateStatusLine() {
    const line = $("paper-status");
    const text = $("paper-status-text");
    const undo = $("paper-undo");
    let message = "";
    let error = false;
    if (!this.pyReady) message = this.pyStatus;
    else if (this.validity && !this.validity.ok) {
      message = this.v1 ? "This is a v1 file. Migrate it to edit it." : `${this.validity.count > 1 ? `${this.validity.count} errors. First: ` : "Error: "}${this.validity.message}. The page shows the last valid version.`;
      error = !this.v1;
    } else if (this.downloading || this.engine.state.kind === "error") {
      message = this.engineText(this.engine.state, this.downloading);
      error = this.engine.state.kind === "error";
    }
    text.textContent = message;
    text.title = message;
    line.dataset.state = error ? "error" : message ? "busy" : "idle";
    line.hidden = !message;
    undo.hidden = !error;
  }

  // ------------------------------------------------------------ PDF

  private schedulePdf(delay: number) {
    clearTimeout(this.pdfTimer);
    this.pdfTimer = window.setTimeout(() => this.updatePdf(), delay);
  }

  /** Compiles quietly in the background, then splits the page where the PDF's pages start. */
  private async updatePdf() {
    // A hidden tab compiles when it is shown again.
    if (!this.pyReady || this.v1 || !this.showsLive() || document.visibilityState === "hidden") return;
    const version = this.textVersion;
    const ticket = ++this.pdfGeneration;
    try {
      const files = await this.texFiles(false);
      if (!files || ticket !== this.pdfGeneration) return;
      const out = await this.engine.preview(files);
      if (ticket !== this.pdfGeneration || !out) return;
      const breaks = await pdfBreaks(out.pdf);
      if (ticket !== this.pdfGeneration) return;
      this.pdfFor = version;
      this.live.setBreaks(breaks, version);
      this.app.dataset.pdf = "ready";
      this.app.dataset.pdfPages = String(breaks.length + 1);
      this.app.dataset.pdfFor = String(version);
      this.app.dataset.tFirstPdf ??= String(since());
    } catch (e) {
      // The engine state shows the failure; a download reports it in full.
      if (ticket === this.pdfGeneration) this.app.dataset.pdf = "error";
      console.warn("cv-tools: background PDF failed", e);
    }
  }

  /** cv.tex and its files, or null (with diagnostics shown) when the CV is invalid. */
  private async texFiles(report = true): Promise<Record<string, Uint8Array> | null> {
    const r = await this.py.renderTex(this.files[MAIN] ?? "", this.bibFiles());
    if (!r.ok || r.tex === undefined) {
      if (report) this.showDiagnostics(r.diagnostics ?? [], r.warnings ?? [], false);
      return null;
    }
    const files: Record<string, Uint8Array> = { "cv.tex": new TextEncoder().encode(r.tex) };
    for (const [name, b64] of Object.entries(r.files ?? {})) files[name] = base64ToBytes(b64);
    return files;
  }

  private engineText(s: EngineState, download = false): string {
    if (s.kind === "loading") {
      const bytes = s.total > 1000 ? ` ${mb(s.loaded)} / ${mb(s.total)} MB` : "";
      if (s.stage === "extras") return `Fetching extra TeX fonts for this CV${bytes}`;
      if (s.stage === "start") return "Starting the TeX engine";
      return `First PDF: fetching the TeX engine${bytes}`;
    }
    if (s.kind === "compiling") return download ? "Compiling the PDF to download" : "Compiling the PDF";
    if (s.kind === "error") return `PDF failed: ${s.message}`;
    return download ? "Preparing the PDF" : "";
  }

  private onEngine(s: EngineState) {
    const el = $("st-engine");
    this.app.dataset.engine = ENGINE_IS_STUB ? `stub-${s.kind}` : s.kind;
    if (s.kind === "loading") {
      const pct = s.total ? Math.min(100, (100 * s.loaded) / s.total) : 0;
      el.replaceChildren();
      const label = document.createElement("span");
      label.textContent = this.engineText(s);
      el.append(label);
      if (s.total > 1000) {
        const bar = document.createElement("span");
        bar.className = "bar";
        bar.setAttribute("role", "progressbar");
        bar.setAttribute("aria-label", s.stage === "extras" ? "TeX font download" : "TeX engine download");
        bar.setAttribute("aria-valuenow", String(Math.round(pct)));
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", "100");
        const fill = document.createElement("span");
        fill.style.width = `${pct}%`;
        bar.append(fill);
        el.append(bar);
      }
    } else if (s.kind === "compiling") {
      el.textContent = ENGINE_IS_STUB ? "PDF engine stub: compiling" : "pdfLaTeX: compiling";
    } else if (s.kind === "ready") {
      const name = ENGINE_IS_STUB ? "PDF engine stub" : "pdfLaTeX";
      el.textContent = s.ms !== undefined ? `${name} · ${(s.ms / 1000).toFixed(1)} s` : name;
    } else if (s.kind === "error") {
      el.textContent = `TeX engine: ${s.message}`;
    } else {
      el.textContent = "";
    }
    this.updateStatusLine();
  }

  // ------------------------------------------------------------ downloads

  private baseName(): string {
    return this.displayName.replace(/\.(ya?ml)$/i, "") || "cv";
  }

  private async ensureValid(): Promise<boolean> {
    if (!this.pyReady) {
      this.notice("cv-tools is still loading. Try again in a moment.", [], 5000);
      return false;
    }
    if (this.v1) {
      this.offerMigration();
      return false;
    }
    return true;
  }

  private setDownloading(on: boolean) {
    this.downloading = on;
    const btn = $<HTMLButtonElement>("download-pdf");
    btn.textContent = on ? "Preparing PDF" : "Download PDF";
    for (const b of [btn, $("m-download")]) {
      if (on) {
        b.setAttribute("aria-busy", "true");
        b.setAttribute("aria-disabled", "true");
      } else {
        b.removeAttribute("aria-busy");
        b.removeAttribute("aria-disabled");
      }
    }
    this.updateStatusLine();
  }

  private async downloadPdf() {
    if (this.downloading || !(await this.ensureValid())) return;
    this.setDownloading(true);
    try {
      const files = await this.texFiles();
      if (!files) {
        this.notice("The CV has errors. Fix them to download the PDF.", [], 6000);
        return;
      }
      const out = await this.engine.compile(files);
      download(`${this.baseName()}.pdf`, out.pdf, "application/pdf");
    } catch (e) {
      const log = (e as { log?: string }).log;
      this.notice(`PDF failed: ${failureMessage(e)}${log ? `. ${logExcerpt(log, 3)}` : ""}`, [], 12000);
    } finally {
      this.setDownloading(false);
    }
  }

  private async downloadLatex() {
    if (!(await this.ensureValid())) return;
    const files = await this.texFiles();
    if (!files) {
      this.notice("The CV has errors. Fix them to download the LaTeX source.", [], 6000);
      return;
    }
    download(`${this.baseName()}-latex.zip`, zip(files), "application/zip");
  }

  private downloadYaml() {
    const bibs = Object.keys(this.files).filter((n) => n !== MAIN);
    if (!bibs.length) {
      download(this.displayName, this.files[MAIN], "text/yaml");
      return;
    }
    const entries: Record<string, string> = { [this.displayName]: this.files[MAIN] };
    for (const b of bibs) entries[b] = this.files[b];
    download(`${this.baseName()}.zip`, zip(entries), "application/zip");
  }

  private async copyShareLink() {
    const link = await shareLink(location.href, this.files);
    const long = link.length > LONG_LINK ? ` The link is long (${link.length} characters); some apps cut long links.` : "";
    try {
      await navigator.clipboard.writeText(link);
      this.notice(`Share link copied. Your CV is inside the link itself, nothing was uploaded.${long}`, [], 8000);
    } catch {
      const input = document.createElement("input");
      input.readOnly = true;
      input.value = link;
      input.setAttribute("aria-label", "Share link");
      this.notice(`Copy this share link.${long}`, [], 0, input);
      input.focus();
      input.select();
    }
  }

  // ------------------------------------------------------------ open, save, migrate

  private async open() {
    if (!this.canWrite()) return;
    try {
      const files = await pickFiles($<HTMLInputElement>("file-input"));
      await this.openFiles(files);
    } catch (e) {
      this.notice(`Could not open the file: ${e instanceof Error ? e.message : e}`, [], 8000);
    }
  }

  async openFiles(opened: OpenedFile[]) {
    if (!opened.length || !this.canWrite()) return;
    const norm = (f: OpenedFile) => f.text.replace(/\r\n?/g, "\n");
    const diskOf = (f: OpenedFile): DiskFile | null => (f.handle ? { handle: f.handle, lastModified: f.lastModified, eol: f.eol, text: norm(f) } : null);
    const yamlFile = opened.find((f) => /\.ya?ml$/i.test(f.name));
    const bibs = opened.filter((f) => /\.bib$/i.test(f.name));
    if (yamlFile) {
      const text = norm(yamlFile);
      const files: Files = { [MAIN]: text };
      for (const b of bibs) files[b.name] = norm(b);
      // Keep the .bib files the new YAML names (v1 files use `bibfile:`).
      const v1Bibs = [...text.matchAll(/^\s*bibfile:\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/gm)].map((m) => m[1]);
      for (const name of [...referencedBibs(text), ...v1Bibs]) if (!(name in files) && name in this.files) files[name] = this.files[name];
      const disk = new Map<string, DiskFile>();
      const d = diskOf(yamlFile);
      if (d) disk.set(MAIN, d);
      for (const b of bibs) {
        const db = diskOf(b);
        if (db) disk.set(b.name, db);
      }
      await this.replaceWith(files, yamlFile.name, { name: yamlFile.name, disk, done: `Opened ${yamlFile.name}.${hasRawLatex(text) ? " " + LATEX_NOTE : ""}` });
    } else {
      const replaced = bibs.filter((b) => b.name in this.files && this.files[b.name] !== norm(b));
      if (replaced.length) {
        const next = { ...this.files };
        for (const b of bibs) next[b.name] = norm(b);
        if (!(await this.confirmReplace(next, replaced.map((b) => b.name).join(", ")))) return;
        if (this.hasWork) await this.store.keepForUndo(this.files, this.displayName);
      }
      for (const b of bibs) {
        this.files[b.name] = norm(b);
        const d = diskOf(b);
        if (d) this.disk.set(b.name, d);
      }
      this.hasWork = true;
      this.editor.setFiles(this.files, bibs[0]?.name ?? this.editor.current);
      this.renderTabs();
      this.save();
      this.scheduleRefresh(0);
      const opened = `Opened ${bibs.map((b) => b.name).join(", ")}.`;
      if (replaced.length) this.offerUndo(opened);
      else this.notice(opened, [], 5000);
    }
  }

  private offerMigration() {
    this.notice(
      `${this.displayName} uses the v1 format. The web app edits v2 files; cv-tools can convert it (comments are kept, the PDF stays the same).`,
      [{ label: "Migrate to v2", run: () => this.migrate() }],
    );
  }

  private async migrate() {
    if (!this.canWrite()) return;
    const r = await this.py.migrate(this.files[MAIN] ?? "");
    if (!r.ok || r.text === undefined) {
      const d = r.diagnostics?.[0];
      this.notice(`Migration failed: ${d ? `${d.line ? `line ${d.line}: ` : ""}${d.message}` : "unknown error"}`, [], 0);
      return;
    }
    const warn = r.warnings?.length ? ` ${r.warnings.length} note${r.warnings.length > 1 ? "s" : ""}: ${r.warnings.join(" ")}` : "";
    // No disk handle: Ctrl+S must not write the v2 text into the v1 file.
    await this.replaceWith({ ...this.files, [MAIN]: r.text }, "The v2 version", { name: this.displayName, done: `Migrated to v2. Download the YAML to save the v2 file.${warn}` });
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), SAVE_DEBOUNCE);
  }

  private flushSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.save();
    }
  }

  private onlyInMemory(): boolean {
    if (!this.hasWork) return false;
    if (this.awaitingValidation || this.notSaved) return JSON.stringify(this.files) !== this.savedSnapshot;
    return false;
  }

  private async save() {
    this.saveTimer = 0;
    if (!this.hasWork || this.readOnly) return;
    if (this.awaitingValidation) {
      this.updateFileState();
      return;
    }
    const files = { ...this.files };
    const r = await this.store.save(files);
    if (r.superseded) return;
    if (r.where === "memory") {
      const first = this.notSaved !== r.reason;
      this.notSaved = r.reason ?? "blocked";
      if (first) this.showNotSaved();
    } else {
      this.notSaved = null;
      this.savedSnapshot = JSON.stringify(files);
      this.lock.announceSaved();
    }
    this.updateFileState();
  }

  private showNotSaved() {
    const why =
      this.notSaved === "quota"
        ? "This browser's storage for the site is full, so your latest changes are not saved."
        : this.notSaved === "guarded"
          ? "This tab does not save to the browser, so the saved CV it could not read is not overwritten."
          : "This browser blocks storage for the site (private browsing or a privacy setting), so your changes are not saved.";
    const actions: Action[] = [{ label: "Download cv.yaml + .bib", run: () => this.downloadYaml() }];
    if (this.notSaved === "guarded") actions.push({ label: "Start fresh", run: () => void this.startFresh() });
    this.notice(`${why} Download your CV to keep it.`, actions, 0);
  }

  // ------------------------------------------------------------ other tabs

  private setReadOnly(on: boolean) {
    this.readOnly = on;
    this.store.writable = !on;
    this.app.dataset.writer = String(!on);
    this.editor.setReadOnly(on);
    $("lock-bar").hidden = !on;
    this.applyLayout();
    this.updateFileState();
  }

  /** Another tab asks for the lock: keep what is typed here and save it first. */
  private async yieldLock() {
    this.live.finishEdit(false);
    this.flushSave();
    await this.store.settled();
  }

  private async onWriterChange(writer: boolean) {
    if (!writer) {
      this.live.finishEdit(true);
      clearTimeout(this.saveTimer);
      this.saveTimer = 0;
      this.notSaved = null;
      this.setReadOnly(true);
      return;
    }
    const hadFocus = $("lock-bar").contains(document.activeElement);
    this.setReadOnly(false);
    if (hadFocus) (this.effectiveLayout() === "paper" ? $("preview-scroll") : this.editor.view.contentDOM).focus();
    const r = await this.store.load();
    if (r.kind === "ok") {
      if (!sameFiles(r.workspace.files, this.files)) this.adopt(r.workspace);
    } else {
      this.loadNotice(r);
    }
    if (this.pendingShare) {
      const hash = this.pendingShare;
      this.pendingShare = null;
      await this.openShareLink(hash);
    }
  }

  private async otherTabSaved(retry = true) {
    if (!this.readOnly) return;
    const other = await this.store.peek();
    if (other && !sameFiles(other.files, this.files)) this.adopt(other);
    // WebKit can deliver the message before the other tab's localStorage write shows here.
    else if (retry) setTimeout(() => void this.otherTabSaved(false), 300);
  }

  private adopt(other: Workspace) {
    this.savedSnapshot = JSON.stringify(other.files);
    this.disk.clear();
    this.hasWork = true;
    this.setWorkspace(other.files, this.editor.current in other.files ? this.editor.current : MAIN, prefs.get("name") ?? MAIN);
  }

  private canWrite(): boolean {
    if (!this.readOnly) return true;
    this.notice("This CV is open in another tab. Choose Use here to edit it in this tab.", [], 6000);
    return false;
  }

  // ------------------------------------------------------------ files on disk

  private updateFileState() {
    let text: string;
    if (this.readOnly) text = "read-only, open in another tab";
    else if (this.awaitingValidation) text = "shared CV, saved once it is valid";
    else if (this.notSaved === "quota") text = "not saved: browser storage is full";
    else if (this.notSaved === "guarded") text = "not saved (see the message above)";
    else if (this.notSaved) text = "not saved: browser storage is blocked";
    else if (!this.hasWork) text = "example";
    else {
      const dirty = [...this.disk].some(([name, d]) => (this.files[name] ?? "") !== d.text);
      text = this.disk.size ? (dirty ? "saved in this browser · Ctrl+S writes the file" : "saved in this browser and on disk") : "saved in this browser";
    }
    $("file-state").textContent = `${this.displayName} · ${text}`;
  }

  private async saveToDisk(overwrite: string[] = []) {
    if (!this.disk.size) {
      this.downloadYaml();
      return;
    }
    const saved: string[] = [];
    const failed: string[] = [];
    const changed: string[] = [];
    for (const [name, d] of this.disk) {
      if (!(name in this.files)) continue;
      const label = name === MAIN ? this.displayName : name;
      const text = this.files[name];
      if (text === d.text && !overwrite.includes(name)) continue;
      const r = await writeBack(d.handle, text, { eol: d.eol, expectLastModified: d.lastModified, overwrite: overwrite.includes(name) });
      if (r.ok) {
        d.text = text;
        d.lastModified = r.lastModified;
        saved.push(label);
      } else if (r.reason === "changed") {
        changed.push(name);
      } else {
        failed.push(`${label} (${r.reason === "permission" ? "permission refused" : r.reason === "unsupported" ? "this browser cannot write files" : (r.message ?? "write failed")})`);
      }
    }
    this.updateFileState();
    const parts: string[] = [];
    if (saved.length) parts.push(`Saved ${saved.join(", ")}.`);
    if (failed.length) parts.push(`Could not write ${failed.join(", ")}. Download the files instead.`);
    if (!saved.length && !failed.length && !changed.length) parts.push("The files on disk are up to date.");
    const actions: Action[] = failed.length ? [{ label: "Download", run: () => this.downloadYaml() }] : [];
    if (changed.length) {
      const names = changed.map((n) => (n === MAIN ? this.displayName : n));
      parts.push(`${names.join(", ")} changed on disk since you opened ${changed.length > 1 ? "them" : "it"}. Overwrite with the version here?`);
      actions.push({ label: "Overwrite", run: () => this.saveToDisk(changed) }, { label: "Download instead", run: () => this.downloadYaml() });
    }
    this.notice(parts.join(" "), actions, failed.length || changed.length ? 0 : 4000);
  }

  // ------------------------------------------------------------ notices

  private noticeTimer = 0;
  private update: { message: string; actions: Action[] } | null = null;
  private showingUpdate = false;

  /** A new version waits: other notices hide it only until they close. */
  offerUpdate(message: string, actions: Action[]) {
    this.update = { message, actions };
    this.notice(message, actions);
    this.showingUpdate = true;
  }

  private hideNotice() {
    $("notice").hidden = true;
    if (this.showingUpdate) this.update = null;
    else if (this.update) this.offerUpdate(this.update.message, this.update.actions);
    this.showingUpdate = !!this.update && !$("notice").hidden;
  }

  notice(message: string, actions: Action[] = [], timeout = 0, extra?: HTMLElement, onDismiss?: () => void) {
    this.showingUpdate = false;
    const box = $("notice");
    $("notice-text").textContent = message;
    const buttons = actions.map((a) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn";
      b.textContent = a.label;
      b.addEventListener("click", () => {
        this.hideNotice();
        a.run();
      });
      return b;
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn";
    close.textContent = "Dismiss";
    close.addEventListener("click", () => {
      this.hideNotice();
      onDismiss?.();
    });
    $("notice-actions").replaceChildren(...(extra ? [extra] : []), ...buttons, close);
    box.hidden = false;
    clearTimeout(this.noticeTimer);
    if (timeout > 0) this.noticeTimer = window.setTimeout(() => this.hideNotice(), timeout);
  }

  /** Before a reload for a new version: keep what is typed. */
  flush() {
    this.live.finishEdit(false);
    this.flushSave();
  }
}
