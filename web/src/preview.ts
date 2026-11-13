// The live page in a shadow root: page boxes, editing text in place and the entry tools (attributes: web-spec 4.3).

import { isMap } from "yaml";
import { rawOffset } from "./caret";
import { paginateByHeight, paginateByPdf, unpaginate, type PageBreak } from "./pages";
import { sanitize, sanitizeCss } from "./sanitize";
import {
  addKey,
  addSection,
  deleteAt,
  fromDataPath,
  getValue,
  insertItem,
  isPrefix,
  moveItem,
  newEntry,
  newSection,
  parseCached,
  replaceItem,
  reusedAnchor,
  samePath,
  setScalar,
  toDataPath,
  type Layout,
  type YamlPath,
} from "./yamlDoc";

export interface LiveCallbacks {
  yaml(): string;
  apply(text: string): void;
  reveal(path: YamlPath): void;
  notify(message: string, actions?: { label: string; run: () => void }[]): void;
  undo(): void;
  /** Asks before a change that is hard to see, such as deleting a section. */
  confirm(message: string, ok: string): Promise<boolean>;
  /** The .bib files of the workspace. */
  bibs(): string[];
  addFile(name: string, text: string): void;
  /** The page boxes changed. */
  pages(): void;
}

/** The layout picker: label, hint and the title it suggests. */
const LAYOUTS: [Layout, string, string, string][] = [
  ["list", "List", "awards, service", "Awards"],
  ["entries", "Entries", "jobs, projects", "Experience"],
  ["entries-inline", "Entries inline", "education", "Education"],
  ["pairs", "Pairs", "skills", "Skills"],
  ["dated", "Dated", "talks", "Talks"],
  ["text", "Text", "summary", "Summary"],
  ["publications", "Publications", "from .bib", "Publications"],
];

const EXAMPLE_BIB = "@article{doe2024,\n  author = {John Doe and Jane Smith},\n  title = {A Paper Title},\n  journal = {Journal Name},\n  year = {2024},\n}\n";

/** Required keys: clearing one writes an empty string instead of deleting it. */
const REQUIRED = new Set(["title", "text", "name", "layout", "bib"]);

/** How far a page may run past its height, before a stale PDF's breaks get an estimated one. */
const SLACK = 20;

export const ALIAS_HINT = "Defined through a YAML alias. Edit it in the YAML, where the anchor (&) is.";

const UI_FONT = "Inter, system-ui, sans-serif";
/** A size in screen pixels, whatever the page's zoom. */
const px = (n: number) => `calc(${n}px * var(--cv-unzoom))`;
const BASE_CSS = `
:host { display: block; --cv-unzoom: 1; }
.cv-root { position: relative; }
:host(.cv-blocked) .cv-root { opacity: 0.45; filter: grayscale(1); }
[data-cv-edit], .cv-ph { cursor: text; }
:host(.cv-editable) [data-cv-edit]:not([data-editing]):hover { outline: 1px dashed #6b6b6b; outline-offset: 2px; }
:host(.cv-editable) :is([data-cv-edit], .cv-ph):not([data-editing]):focus-visible { outline: 2px solid #000; outline-offset: 2px; }
:host(.cv-editable) [data-via-alias] { cursor: not-allowed; }
:host(.cv-editable) [data-via-alias]:hover { outline: 1px dotted #6b6b6b; outline-offset: 2px; }
:host(.cv-editable) .cv-section { position: relative; }
:host(:not(.cv-editable)) [data-path] { cursor: pointer; }
/* Justified lines would open wide gaps in the text being typed. */
[data-editing] { outline: none; text-decoration: underline 1px !important; text-underline-offset: 0.2em; text-align-last: auto; }
[data-editing]:not(.cv-name) { text-align: left !important; text-align-last: left !important; }
[contenteditable] { -webkit-user-modify: read-write-plaintext-only; outline: none; }
/* An empty value shows what it is for, at the page's text size. */
:not(li)[data-ph]:empty::before {
  content: attr(data-ph); color: #6b6b6b; font-style: italic; font-weight: normal; font-size: 10.95pt; text-transform: none; letter-spacing: normal;
}
.cv-document[data-editable] :is(.cv-section-title, .cv-name)[data-path]:empty { display: block; }
.cv-alias-peer { outline: 1.5px dotted #000; outline-offset: 2px; }
.cv-sync:not([data-editing]) { outline: 1px solid #a0a0a0; outline-offset: 2px; }
/* A continuation starts at the top of its page; the page itself keeps its margins. */
:not(.cv-page)[data-cv-cont], [data-cv-cont] > :first-child { margin-top: 0 !important; padding-top: 0 !important; }
[data-cv-entry], [data-cv-of] { position: relative; }
/* Wider than the entry but no taller, so it never crosses a rule or the next row. */
.cv-entry-active::after { content: ""; position: absolute; inset: 0 -5px; border: 1px solid #000; pointer-events: none; }
/* Typed text takes the field's own style. */
.cv-ph:not([data-editing]) { color: #6b6b6b; font-style: italic; font-weight: normal; }
/* Inline placeholders keep their spaces rigid inside a justified line. */
:is(span, em).cv-ph, .cv-ph-rigid { display: inline-block; min-width: 0.5em; }
/* A row above the selected entry's text, in the flow, so it covers nothing. */
:host { --cv-tools-h: ${px(18)}; --cv-tools-gap: ${px(2)}; }
.cv-tools {
  display: flex; width: max-content; height: var(--cv-tools-h); margin: 0 0 var(--cv-tools-gap); grid-column: 1 / -1;
  box-sizing: border-box; border: 1px solid #000; background: #fff; font: 400 ${px(11)}/1 ${UI_FONT}; white-space: nowrap; text-align: left; word-spacing: normal;
}
.cv-tools button, .cv-add-entry, .cv-add button {
  font: inherit; color: #000; background: #fff; border: 0; cursor: pointer;
}
.cv-tools button { padding: 0 ${px(7)}; }
.cv-tools button + button { border-left: 1px solid #000; }
.cv-tools button:hover, .cv-add-entry:hover { background: #f2f2f2; }
.cv-tools button[aria-disabled="true"] { color: #6b6b6b; cursor: default; background: #fff; }
/* Out of the flow, below the section, and shown only when the section is in use or empty. */
.cv-add-entry {
  position: absolute; left: 1.5em; top: 100%; padding: 1px 0; background: none; color: #595959;
  font: 400 10px/1.4 ${UI_FONT}; opacity: 0;
}
.cv-section:is(:hover, .cv-entry-active, .cv-empty, :has(.cv-entry-active)) > .cv-add-entry, .cv-add-entry:focus { opacity: 1; }
:is(.cv-tools button, .cv-add-entry, .cv-add button, .cv-add input, .cv-add select):focus-visible { outline: 2px solid #000; outline-offset: 1px; }
/* Below the last section's "+ Add entry", in a row of its own (the page's reset of margins is overridden). */
.cv-page > .cv-add { margin-top: 32px; font: 400 ${px(12)}/1.4 ${UI_FONT}; color: #000; text-align: left; word-spacing: normal; }
.cv-add .cv-add-section { width: 100%; border: 1px dashed #6b6b6b !important; color: #404040 !important; padding: ${px(6)}; }
.cv-add form { display: flex; flex-direction: column; gap: 8px; border: 1px solid #000; background: #fff; padding: 10px 12px; }
.cv-add .cv-field { display: flex; flex-direction: column; gap: 3px; color: #404040; }
.cv-add .cv-field[hidden] { display: none; }
.cv-add input[type="text"], .cv-add select { font: inherit; color: #000; background: #fff; border: 1px solid #000; padding: 4px 6px; }
.cv-layouts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; border: 0; margin: 0; padding: 0; }
.cv-layouts legend { color: #404040; padding: 0; margin-bottom: 4px; }
.cv-layouts label { position: relative; border: 1px solid #c8c8c8; padding: 5px 7px; cursor: pointer; }
.cv-layouts label:has(:checked) { background: #000; color: #fff; border-color: #000; }
.cv-layouts label:has(:focus-visible) { outline: 2px solid #000; outline-offset: 2px; }
.cv-layouts input { position: absolute; opacity: 0; pointer-events: none; }
.cv-layouts b { font-weight: 500; }
.cv-actions { display: flex; gap: 6px; justify-content: flex-end; }
.cv-actions button { border: 1px solid #000; padding: 4px 10px; }
.cv-actions .cv-primary { background: #000; color: #fff; }
@media (pointer: coarse) {
  /* 44 CSS pixels on screen, whatever the page's zoom. */
  :host { --cv-tools-h: ${px(46)}; }
  .cv-tools { font-size: ${px(13)}; }
  .cv-tools button, .cv-add-entry, .cv-add button, .cv-add input, .cv-add select, .cv-layouts label {
    min-height: ${px(44)}; min-width: ${px(44)};
  }
  /* In the flow, so it never lies over the next section. */
  .cv-add-entry { position: static; display: none; margin-left: 1.5em; font-size: ${px(13)}; opacity: 1; }
  .cv-section:is(.cv-entry-active, .cv-empty, :has(.cv-entry-active)) > .cv-add-entry { display: block; }
  .cv-add { font-size: ${px(14)}; }
  /* A 44 px hit area behind the text, so the layout and the neighbours' own areas stay. */
  .cv-page { isolation: isolate; }
  :host(.cv-editable) :is([data-cv-edit], .cv-ph) { position: relative; }
  :host(.cv-editable) :is([data-cv-edit], .cv-ph)::after {
    content: ""; position: absolute; z-index: -1; inset: min(0px, calc(50% - ${px(24)}));
  }
}
`;

class Sheet {
  private sheet: CSSStyleSheet | null = null;
  private el: HTMLStyleElement | null = null;
  constructor(root: ShadowRoot, css: string) {
    try {
      this.sheet = new CSSStyleSheet();
      this.sheet.replaceSync(css);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, this.sheet];
    } catch {
      this.sheet = null;
      this.el = document.createElement("style");
      this.el.textContent = css;
      root.prepend(this.el);
    }
  }
  set(css: string) {
    if (this.sheet) this.sheet.replaceSync(css);
    else if (this.el) this.el.textContent = css;
  }
}

/** What typing into a placeholder adds: a key, a list item, or a plain item turned into a mapping. */
interface Addition {
  path: YamlPath;
  list?: boolean;
  /** The item that Enter in it started: focus goes back there when this stays empty. Its own empty item is in the YAML already. */
  after?: HTMLElement;
  /** The text version that has it at its path. */
  version?: number;
  make?: (typed: string) => unknown;
  /** The new value's path, focused after Enter. */
  focus: YamlPath;
}

interface Editing {
  el: HTMLElement;
  /** The element typed into: `el`, or a span inside an element that cannot be a textbox (li, h1). */
  box: HTMLElement;
  path: YamlPath;
  /** The YAML when the edit started. */
  yaml: string;
  raw: string;
  latex: boolean;
  saved: Node[];
  done: boolean;
  anchor: string | null;
  /** The element's own accessible name, put back after the edit. */
  label: string | null;
  add?: Addition;
  cleanup?: () => void;
}

/** What gets focus after the render of `version`. */
type Refocus = { path: YamlPath; target: "edit" | "focus" | "tool"; tool?: string; from?: Element | null; version?: number };
/** A focusable element of the page, found again after a render. */
/** `exact`: the path is already that of the text version it holds. */
type Key = { attr: "data-path" | "data-cv-add"; path: YamlPath; exact?: number } | { tool: string };

/** The character offset in `el`'s text nearest to a point. */
function offsetAt(el: HTMLElement, x: number, y: number): number | null {
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let best = { d: Infinity, at: 0 };
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    for (let i = 0; i < n.length; i++) {
      range.setStart(n, i);
      range.setEnd(n, i + 1);
      const r = range.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const before = Math.abs(x - r.left);
      const after = Math.abs(x - r.right);
      const d = dy * 1000 + Math.min(before, after);
      if (d < best.d) best = { d, at: offset + i + (after < before ? 1 : 0) };
    }
    offset += n.length;
  }
  return best.d < Infinity ? best.at : null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && !("latex" in v);
const isSection = (path: string | null) => !!path && /^sections\.\d+$/.test(path);

/** What an empty value is for. */
function phLabel(path: YamlPath): string {
  const [last, parent] = [path[path.length - 1], path[path.length - 2]];
  if (typeof last === "string") return `add ${last}`;
  if (path[0] === "contact") return "add contact";
  return parent === "bullets" ? "add bullet" : parent === "details" ? "add detail line" : "add item";
}

/** Old paths to new ones, after an item is inserted (+1) or removed (-1) at `seq[index]`. */
function shiftPaths(seq: YamlPath, index: number, by: 1 | -1) {
  return (p: YamlPath): YamlPath => {
    const i = p[seq.length];
    if (!isPrefix(seq, p) || typeof i !== "number" || i < index + (by < 0 ? 1 : 0)) return p;
    return [...seq, i + by, ...p.slice(seq.length + 1)];
  };
}

export class LivePreview {
  readonly root: ShadowRoot;
  private content: HTMLDivElement;
  private rendererSheet: Sheet;
  private addBox: HTMLDivElement;
  private tools: HTMLDivElement;
  private editable = false;
  private editing: Editing | null = null;
  private pending: { html: string; css: string | null; version: number } | null = null;
  /** What the current press is on, selected on its mousedown. */
  private pressTarget: Element | null = null;
  /** A press on the page is under way: a render waits for its click. */
  private held = false;
  /** The selected entry's or section's data path, or "contact" for the header's contact lines. */
  private selected: string | null = null;
  /** The selection's outline, tools and placeholders are on the page. */
  private applied = false;
  private additions = new WeakMap<HTMLElement, Addition>();
  private refocus: Refocus | null = null;
  /** Changes not rendered yet that move paths, by the text version they make; null when how is unknown (a YAML edit). */
  private moves: { version: number; fn: ((p: YamlPath) => YamlPath) | null }[] = [];
  /** An entry just added with an empty title: left empty, it goes again. */
  private fresh: { entry: YamlPath; edit: string } | null = null;
  /** Focus to put back once the render it belongs to arrives. */
  private carried: Key | null = null;
  /** Keys typed between "+ Add entry" and the edit of the new title, which the render starts. */
  private typeahead: string | null = null;
  /** An edit asked for while a render was pending, started after it. */
  private queued: { key: Key; at: number | null } | null = null;
  private applyingText = false;
  private ownEdit = false;
  private quietFocus = false;
  private synced: YamlPath | null = null;
  private version = 0;
  private shownVersion = -1;
  private breaks: { list: PageBreak[]; version: number } | null = null;
  private pagesPending = false;
  /** Pages could not be measured (the page is hidden). */
  needsPages = false;
  private phPress = false;
  /** The edit the current press started, and how to place its caret again. */
  private pressed: { x: number; y: number; caret: () => void } | null = null;
  /** Where the pointer went down in a value (an offset in its shown text, or in its source when `mapped`). */
  private clickCaret: { el: HTMLElement; at: number | null; text?: string; date?: string; mapped?: boolean; x?: number; y?: number } | null = null;
  /** The element whose edit was restarted to get a caret (WebKit), so it happens once. */
  private retriedCaret: HTMLElement | null = null;
  hasContent = false;

  constructor(
    private host: HTMLElement,
    private cb: LiveCallbacks,
  ) {
    this.root = host.attachShadow({ mode: "open" });
    new Sheet(this.root, BASE_CSS);
    this.rendererSheet = new Sheet(this.root, "");
    this.content = document.createElement("div");
    this.content.className = "cv-root";
    this.addBox = document.createElement("div");
    this.addBox.className = "cv-add";
    this.addBox.dataset.cvUi = "";
    this.addBox.hidden = true;
    // A press on a button keeps focus where it is: ending an edit there could move the button away before the click.
    this.addBox.addEventListener("mousedown", (e) => {
      if ((e.target as Element).closest("button")) e.preventDefault();
    });
    this.tools = this.makeTools();
    this.root.append(this.content);
    this.renderAddButton();

    this.root.addEventListener("pointerdown", (e) => this.onPointerDown(e as PointerEvent), true);
    document.addEventListener("pointerdown", () => (this.typeahead = null), true);
    this.root.addEventListener("click", (e) => this.onClick(e as MouseEvent));
    // The empty placeholder shrinks under the pointer: the browser must not move the caret it got.
    this.root.addEventListener("mousedown", (e) => {
      if (this.phPress) e.preventDefault();
      // Selecting adds the tools row; done after the browser has found what the press focuses.
      const target = this.pressTarget;
      this.pressTarget = null;
      if (target?.isConnected) this.select(this.entryFrom(target), target);
    });
    // The browser can place the caret of an edit this press started outside the value: place it again.
    // Until the press ends, a blur of the placeholder it started (WebKit, after a re-render) does not end the edit.
    const release = () =>
      setTimeout(() => {
        this.phPress = false;
        this.held = false;
        this.content.querySelectorAll("[data-cv-gone]").forEach((e) => e.remove());
        this.flush();
      }, 0);
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    // A press whose release never comes (a synthetic event, a lost pointer) holds renders for a moment only.
    let heldTimer = 0;
    this.root.addEventListener(
      "pointerdown",
      () => {
        this.held = true;
        clearTimeout(heldTimer);
        heldTimer = window.setTimeout(release, 1000);
      },
      true,
    );
    this.root.addEventListener("mouseup", (ev) => {
      const e = ev as MouseEvent;
      const p = this.pressed;
      this.pressed = null;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4) p.caret();
    });
    // A middle click (or any other button) would open a link in a new tab.
    this.root.addEventListener("auxclick", (e) => {
      if ((e.composedPath()[0] as Element)?.closest?.("a[href]")) e.preventDefault();
    });
    this.root.addEventListener("focusin", (e) => this.onFocusIn(e as FocusEvent));
    this.root.addEventListener("keydown", (e) => {
      const ev = e as KeyboardEvent;
      const target = ev.composedPath()[0] as HTMLElement;
      if (this.typeahead !== null && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        e.preventDefault();
        this.typeahead += ev.key;
        return;
      }
      if (!this.editable || this.isEditing || !(target instanceof HTMLElement)) return;
      const ph = target.classList.contains("cv-ph") && (ev.key === "Enter" || ev.key === " ");
      if (ph || (ev.key === "Enter" && target.hasAttribute("data-cv-edit"))) {
        e.preventDefault();
        this.clickCaret = null;
        this.startEdit(target);
      }
    });
    document.fonts?.ready.then(() => this.repaginate());
  }

  // ------------------------------------------------------------ rendering

  /** The page shows the current YAML. */
  get current(): boolean {
    return this.shownVersion === this.version;
  }

  textChanged(version: number) {
    this.version = version;
    if (!this.applyingText && !this.ownEdit) {
      this.moves.push({ version, fn: null });
      this.select(null);
      this.fresh = null;
    }
    this.updateTools();
  }

  show(html: string, css: string | null, version = this.version) {
    if (this.isEditing || this.held) {
      this.pending = { html, css, version };
      return;
    }
    this.pending = null;
    const focused = this.root.activeElement as HTMLElement | null;
    const key = this.keyOf(focused) ?? (focused ? null : this.carried);
    this.carried = null;
    const inAdd = focused && this.addBox.contains(focused) ? focused : null;
    const map = this.mapFrom(this.shownVersion, version) ?? ((p: YamlPath) => p);
    this.rendererSheet.set(sanitizeCss(css ?? ""));
    this.addBox.remove();
    this.content.replaceChildren(sanitize(html));
    this.hasContent = true;
    this.shownVersion = version;
    this.retriedCaret = null;
    this.applied = false;
    this.decorate();
    this.paginate();
    this.decorateSections();
    this.placeAddBox();
    inAdd?.focus();
    if (this.synced) this.highlight(this.synced, false);
    // A refocus for a later version waits for its render.
    let refocus = this.refocus && (this.refocus.version ?? 0) <= version ? this.refocus : null;
    if (refocus) this.refocus = null;
    // Focus that moved on while the page was stale stays where it went.
    if (refocus?.from && focused !== refocus.from) refocus = null;
    const selected = this.selected && toDataPath(map(fromDataPath(this.selected)));
    this.selected = null;
    this.select(refocus && refocus.target !== "edit" ? this.entryPathOf(refocus.path) : selected);
    if (refocus) this.focusPath(refocus);
    else if (key && (!focused || !focused.isConnected)) {
      if ("exact" in key && key.exact !== undefined && key.exact > version) this.carried = key;
      else this.focusKey(key, map);
    }
    if (!this.refocus) this.typeahead = null;
    this.moves = this.moves.filter((m) => m.version > version);
    const q = this.queued;
    this.queued = null;
    const again = q && this.find(q.key, map);
    if (again) {
      this.clickCaret = { el: again, at: q!.at, mapped: true };
      this.startEdit(again);
    }
  }

  private decorate() {
    const root = this.content.querySelector<HTMLElement>(".cv-document");
    if (root?.dataset.editable === "false") return;
    for (const el of this.content.querySelectorAll<HTMLElement>("[data-path]")) {
      if (el.closest("[data-readonly]") || el.hasAttribute("data-via-alias")) continue;
      el.dataset.cvEdit = "";
      if (this.editable) el.tabIndex = 0;
      if (!el.firstChild) el.dataset.ph = phLabel(fromDataPath(el.dataset.path!));
    }
    for (const el of this.content.querySelectorAll<HTMLElement>("[data-via-alias]")) el.title = ALIAS_HINT;
    for (const el of this.content.querySelectorAll<HTMLElement>("[data-entry]")) el.dataset.cvEntry = el.dataset.entry;
    for (const a of this.content.querySelectorAll<HTMLAnchorElement>("a[href]")) a.rel = "noopener noreferrer";
  }

  setEditable(on: boolean) {
    if (this.editable === on) return;
    // Leaving an editable layout keeps what was typed.
    if (!on) this.finishEdit(false);
    this.editable = on;
    this.host.classList.toggle("cv-editable", on);
    this.addBox.hidden = !on;
    for (const el of this.content.querySelectorAll<HTMLElement>("[data-cv-edit]")) {
      if (on) el.tabIndex = 0;
      else el.removeAttribute("tabindex");
    }
    if (on) this.decorateSections();
    else {
      this.select(null);
      this.content.querySelectorAll(".cv-add-entry").forEach((b) => b.remove());
    }
  }

  /** The page shows a CV that cannot be edited now (invalid YAML or a v1 file). */
  setBlocked(on: boolean) {
    this.host.classList.toggle("cv-blocked", on);
  }

  setZoom(zoom: number) {
    this.host.style.zoom = String(zoom);
    this.host.style.setProperty("--cv-unzoom", String(1 / zoom));
  }

  pageWidth(): number {
    const page = this.content.querySelector<HTMLElement>(".cv-page") ?? (this.content.firstElementChild as HTMLElement | null);
    return page?.offsetWidth || 816;
  }

  // ------------------------------------------------------------ page boxes

  /** Page breaks read from the PDF of the YAML at `version`. */
  setBreaks(list: PageBreak[], version: number) {
    this.breaks = { list, version };
    this.repaginate();
  }

  pages(): HTMLElement[] {
    return [...this.content.querySelectorAll<HTMLElement>(".cv-document > .cv-page")];
  }

  private doc() {
    return this.content.querySelector<HTMLElement>(".cv-document");
  }

  private paginate() {
    const doc = this.doc();
    if (!doc) return;
    const b = this.breaks;
    const found = b?.list.length ? paginateByPdf(doc, b.list) : 0;
    const exact = !!b && b.version === this.shownVersion && found === b.list.length;
    this.needsPages = !exact && !paginateByHeight(doc, b ? SLACK : 0);
    this.host.dataset.pagesFrom = exact ? "pdf" : "estimate";
    this.pagesChanged();
  }

  private pagesChanged() {
    this.host.dataset.pages = String(this.pages().length);
    this.cb.pages();
  }

  /** "+ Add section" ends the last page; it is UI, so page breaks ignore it. */
  private placeAddBox() {
    // Moving it again would cancel a click on it.
    const last = this.pages().at(-1);
    if (last && last.lastElementChild !== this.addBox) last.append(this.addBox);
    this.addBox.hidden = !this.editable;
  }

  /** Splits the page again, without the selection's tools and placeholders. */
  private remeasure() {
    const doc = this.doc();
    if (!doc) return;
    this.applied = false;
    this.content.querySelectorAll("[data-cv-ui]").forEach((e) => {
      if (e !== this.addBox && !this.addBox.contains(e)) e.remove();
    });
    unpaginate(doc);
    this.paginate();
    this.decorateSections();
    this.placeAddBox();
  }

  /** Splits the page again, keeping the selection and focus. */
  repaginate() {
    if (!this.doc()) return;
    if (this.isEditing || this.held) {
      this.pagesPending = true;
      return;
    }
    this.pagesPending = false;
    const focused = this.root.activeElement as HTMLElement | null;
    const key = this.keyOf(focused);
    const selected = this.selected;
    // What the user is on stays where it is on screen.
    const anchor = focused && this.content.contains(focused) ? focused : selected ? this.entryEls(selected)[0] : null;
    const top = anchor?.getBoundingClientRect().top;
    this.select(null);
    this.remeasure();
    this.select(selected);
    if (focused?.isConnected) {
      if (this.root.activeElement !== focused) this.focusQuietly(focused);
    } else if (key) this.focusKey(key);
    const moved = top !== undefined && anchor!.isConnected ? anchor!.getBoundingClientRect().top - top : 0;
    if (moved) this.host.closest(".preview-scroll")?.scrollBy(0, moved);
  }

  // ------------------------------------------------------------ cursor sync

  /** The closest element for the YAML path under the editor cursor; null removes the mark. */
  highlight(path: YamlPath | null, scroll = true) {
    this.synced = path;
    this.content.querySelectorAll(".cv-sync").forEach((e) => e.classList.remove("cv-sync"));
    if (!path || !path.length) return;
    let best: HTMLElement | null = null;
    let bestLen = 0;
    for (const el of this.content.querySelectorAll<HTMLElement>("[data-path],[data-entry],[data-section]")) {
      const p = fromDataPath(el.dataset.path ?? el.dataset.entry ?? el.dataset.section ?? "");
      if (p.length > bestLen && isPrefix(p, path)) {
        best = el;
        bestLen = p.length;
      }
    }
    if (!best || bestLen < 2) return;
    best.classList.add("cv-sync");
    if (scroll) {
      const r = best.getBoundingClientRect();
      const box = this.host.closest(".preview-scroll")?.getBoundingClientRect();
      if (box && (r.top < box.top || r.bottom > box.bottom)) best.scrollIntoView({ block: "center", behavior: "auto" });
    }
  }

  // ------------------------------------------------------------ events

  private onPointerDown(e: PointerEvent) {
    if (!this.editable) return;
    const target = e.composedPath()[0] as Element;
    if (!(target instanceof Element) || this.tools.contains(target) || this.addBox.contains(target)) return;
    const ph = target.closest<HTMLElement>(".cv-ph");
    // Started now: the edit that ends on this press can re-render the page before a click.
    if (ph && !ph.hasAttribute("data-editing")) {
      this.startEdit(ph);
      this.phPress = true;
      return;
    }
    const field = target.closest<HTMLElement>("[data-cv-edit]");
    // Measured before the entry's placeholders appear.
    this.clickCaret =
      field && !field.hasAttribute("data-editing")
        ? { el: field, at: offsetAt(field, e.clientX, e.clientY), text: field.textContent ?? "", date: field.querySelector(".cv-date-value")?.textContent ?? "", x: e.clientX, y: e.clientY }
        : null;
    this.pressTarget = target.closest(".cv-add-entry") ? null : target;
  }

  private onClick(e: MouseEvent) {
    const target = e.composedPath()[0] as HTMLElement;
    if (!(target instanceof Element)) return;
    const link = target.closest("a[href]") as HTMLAnchorElement | null;
    if (link) {
      e.preventDefault();
      if (!this.editable && (e.ctrlKey || e.metaKey)) window.open(link.href, "_blank", "noopener,noreferrer");
    }
    if (this.editable) {
      // A focused value whose edit ended (Escape, Enter) edits again on click; placeholders start on the press.
      const field = target.closest<HTMLElement>("[data-cv-edit]");
      const active = this.root.activeElement;
      if (field && !field.hasAttribute("data-editing") && active && (active === field || field.contains(active))) this.startEdit(field);
      const alias = target.closest<HTMLElement>("[data-via-alias]");
      if (alias && !target.closest("[data-cv-edit]")) this.cb.notify(ALIAS_HINT);
    }
    const el = target.closest<HTMLElement>("[data-path],[data-entry],[data-section]");
    if (el && !(this.editable && el.hasAttribute("data-cv-edit"))) this.cb.reveal(fromDataPath(el.dataset.path ?? el.dataset.entry ?? el.dataset.section ?? ""));
  }

  private onFocusIn(e: FocusEvent) {
    if (!this.editable || this.quietFocus) return;
    const target = e.composedPath()[0] as HTMLElement;
    if (!(target instanceof HTMLElement) || target.closest("[data-cv-ui]") || target.hasAttribute("data-cv-box")) return;
    this.select(this.entryFrom(target), target);
    // A click on a link inside a value edits the value.
    const field = target.closest<HTMLElement>("[data-cv-edit]");
    if (field && (field === target || target.matches("a")) && this.editing?.el !== field) this.startEdit(field);
  }

  // ------------------------------------------------------------ entries and sections

  /** The item's elements: the entry or section and its continuations on later pages, or the contact lines. */
  private entryEls(path: string): HTMLElement[] {
    if (path === "contact") return [...this.content.querySelectorAll<HTMLElement>(".cv-contact[data-contact]")];
    return [...this.content.querySelectorAll<HTMLElement>(`[data-cv-entry="${path}"], [data-section="${path}"], [data-cv-cont][data-cv-of="${path}"]`)];
  }

  private entryFrom(el: Element): string | null {
    for (let e: Element | null = el; e && e !== this.content; e = e.parentElement) {
      const d = (e as HTMLElement).dataset;
      if (d.contact !== undefined) return "contact";
      if (d.viaAlias !== undefined && d.section !== undefined) return null;
      const path = d.cvEntry ?? d.section ?? (d.cvCont !== undefined ? d.cvOf : undefined);
      if (path && this.content.querySelector(`[data-cv-entry="${path}"], [data-section="${path}"]`)) return path;
    }
    return null;
  }

  private entryPathOf(path: YamlPath): string | null {
    for (let n = path.length; n > 0; n--) {
      const p = toDataPath(path.slice(0, n));
      if (this.content.querySelector(`[data-cv-entry="${p}"], [data-section="${p}"]`)) return p;
    }
    return null;
  }

  /** Selects an item; `anchor` (what the pointer or focus is on) keeps its place on screen, and focus stays. */
  private select(path: string | null, anchor?: Element) {
    if (path === this.selected && (!path || this.applied)) return;
    const focused = this.root.activeElement as HTMLElement | null;
    const key = this.keyOf(focused);
    const top = anchor?.getBoundingClientRect().top;
    this.applySelect(path);
    if (focused && this.root.activeElement !== focused && !this.isEditing) {
      if (focused.isConnected) this.focusQuietly(focused);
      else if (key) this.focusKey(key);
    }
    // The tools row and placeholders push content down: scroll so the pointer stays on what it pressed.
    const moved = top !== undefined && anchor!.isConnected ? anchor!.getBoundingClientRect().top - top : 0;
    if (moved) this.host.closest(".preview-scroll")?.scrollBy(0, moved);
  }

  /** The outline, the tools and the placeholders of the item's empty fields. */
  private applySelect(path: string | null) {
    if (this.editing?.add) this.finishEdit(false);
    this.content.querySelectorAll(".cv-entry-active").forEach((e) => e.classList.remove("cv-entry-active"));
    this.content.querySelectorAll(".cv-ph, [data-cv-ph]").forEach((e) => e.remove());
    this.tools.remove();
    this.selected = path;
    this.applied = false;
    if (!path || !this.editable) return;
    const els = this.entryEls(path);
    if (!els.length) {
      this.selected = null;
      return;
    }
    this.applied = true;
    if (path === "contact") {
      this.addContactPlaceholders(els);
      return;
    }
    // The page breaks stay the PDF's: the tools and placeholders make their sheet taller instead.
    els.forEach((e) => e.classList.add("cv-entry-active"));
    this.addPlaceholders(fromDataPath(path), els);
    els[0].prepend(this.tools);
    this.updateTools();
  }

  /** A placeholder; `block` puts it in its own line, such as a `li.cv-bullet`. */
  private placeholder(text: string, add: Addition, tag = "span", cls = "", block?: string): HTMLElement {
    const el = document.createElement(tag);
    el.className = `cv-ph ${cls}`.trim();
    el.textContent = text;
    el.tabIndex = 0;
    el.dataset.cvUi = "";
    el.setAttribute("role", "button");
    el.dataset.cvAdd = toDataPath(add.focus);
    this.additions.set(el, add);
    if (!block) return el;
    const [blockTag, blockCls] = block.split(".");
    const line = document.createElement(blockTag);
    line.className = blockCls;
    line.dataset.cvUi = "";
    line.dataset.cvPh = "";
    line.append(el);
    return line;
  }

  /** A placeholder after inline text such as ", " or the stretchable space before a right-aligned value. */
  private inline(prefix: string, ph: HTMLElement, rigid = false): HTMLElement {
    const wrap = document.createElement("span");
    if (rigid) wrap.className = "cv-ph-rigid";
    wrap.dataset.cvUi = "";
    wrap.dataset.cvPh = "";
    wrap.append(prefix, ph);
    return wrap;
  }

  private addPlaceholders(path: YamlPath, els: HTMLElement[]) {
    const yaml = this.cb.yaml();
    const value = getValue(yaml, path);
    const all = (sel: string) => els.flatMap((e) => [...e.querySelectorAll<HTMLElement>(sel)]);
    const key = (k: string): Addition => ({ path: [...path, k], focus: [...path, k] });
    if (path.length === 2) {
      const body = els[0].querySelector(":scope > .cv-section-body");
      if (isObject(value) && !("description" in value)) body?.prepend(this.placeholder("add description", key("description"), "span", "", "p.cv-description"));
      return;
    }
    const layout = String(getValue(yaml, [...path.slice(0, 2), "layout"]) ?? "");
    const item = (k: string): Addition => {
      const list = (value as Record<string, unknown>)[k];
      return { path: [...path, k], list: true, focus: [...path, k, Array.isArray(list) ? list.length : 0] };
    };
    if ((layout === "entries" || layout === "entries-inline") && isObject(value)) {
      const [l1, l2] = all(":scope > .cv-line");
      if (!("location" in value)) l1?.querySelector(".cv-head")?.append(this.inline(", ", this.placeholder("add location", key("location")), true));
      if (!("date" in value)) l1?.append(this.inline(" ", this.placeholder("add date", key("date"), "em", "cv-date cv-right")));
      if (!("subtitle" in value)) l2?.prepend(this.placeholder("add subtitle", key("subtitle"), "span", "cv-subtitle"));
      if (!("note" in value)) l2?.append(this.inline(" ", this.placeholder("add note", key("note"), "span", "cv-note cv-right")));
      (all(".cv-detail").at(-1) ?? l2)?.after(this.placeholder("add detail line", item("details"), "span", "", "div.cv-detail"));
      const ul = all("ul.cv-bullets").at(-1) ?? this.uiList("cv-bullets", els.at(-1)!);
      ul.append(this.placeholder("add bullet", item("bullets"), "span", "", "li.cv-bullet"));
    } else if (layout === "list" && (typeof value === "string" || typeof value === "number" || isObject(value))) {
      const add: Addition = isObject(value)
        ? item("bullets")
        : { path, make: (t) => ({ text: value, bullets: [t] }), focus: [...path, "bullets", 0] };
      const ul = all("ul.cv-sublist").at(-1) ?? this.uiList("cv-sublist", els.at(-1)!);
      ul.append(this.placeholder("add sub-item", add, "span", "", "li.cv-subitem"));
    } else if (layout === "dated" && !(isObject(value) && "date" in value) && !(value && typeof value === "object" && "latex" in value)) {
      const add: Addition = isObject(value) ? key("date") : { path, make: (t) => ({ date: t, text: value }), focus: [...path, "date"] };
      all(".cv-dated-date")[0]?.append(this.placeholder("add date", add));
    }
  }

  /** "add contact" at the end of each contact line; a new item is plain text. */
  private addContactPlaceholders(lines: HTMLElement[]) {
    const yaml = this.cb.yaml();
    for (const line of lines) {
      const at = fromDataPath(line.dataset.contact!);
      const seq = Array.isArray(getValue(yaml, at)) ? at : [...at, "items"];
      const items = getValue(yaml, seq);
      if (!Array.isArray(items)) continue;
      const add: Addition = { path: seq, list: true, focus: [...seq, items.length] };
      const sep = items.length ? (line.querySelector(".cv-sep")?.textContent ?? " | ").replace(/ /g, " ") : "";
      line.append(this.inline(sep, this.placeholder("add contact", add)));
    }
  }

  private uiList(cls: string, parent: HTMLElement): HTMLElement {
    const ul = document.createElement("ul");
    ul.className = cls;
    ul.dataset.cvPh = "";
    ul.dataset.cvUi = "";
    parent.append(ul);
    return ul;
  }

  /** "+ Add entry" under each section with entries; always shown when it has none. */
  private decorateSections() {
    if (!this.editable) return;
    const yaml = this.cb.yaml();
    for (const section of this.content.querySelectorAll<HTMLElement>(".cv-section[data-section]")) {
      const path = section.dataset.section!;
      const seq = [...fromDataPath(path), "entries"];
      const entries = getValue(yaml, seq);
      if (section.dataset.layout === "publications" || section.hasAttribute("data-via-alias") || !Array.isArray(entries)) continue;
      section.classList.toggle("cv-empty", !entries.length);
      const parts = [section, ...this.content.querySelectorAll<HTMLElement>(`.cv-section[data-cv-of="${path}"]`)];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cv-add-entry";
      btn.dataset.cvUi = "";
      btn.textContent = "+ Add entry";
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        this.finishEdit(false);
        this.addEntry(seq, this.countAt(seq), section.dataset.layout ?? "list");
      });
      parts.at(-1)!.append(btn);
    }
  }

  /** Inserts an entry with an empty title and edits that title; left empty, the entry goes again. */
  private addEntry(seq: YamlPath, at: number, layout: string) {
    if (this.stale(seq)) return;
    const entry = newEntry(layout);
    const path = [...seq, at];
    const edit = isObject(entry) ? [...path, "title"] : path;
    this.fresh = { entry: path, edit: toDataPath(edit) };
    this.typeahead = "";
    this.shift(seq, at, 1);
    this.edit((y) => insertItem(y, seq, entry, at), { path: edit, target: "edit" });
  }

  private makeTools(): HTMLDivElement {
    const box = document.createElement("div");
    box.className = "cv-tools";
    box.dataset.cvUi = "";
    box.setAttribute("role", "toolbar");
    box.setAttribute("aria-label", "Entry actions");
    const actions: [string, string, () => void][] = [
      ["cv-up", "Move up", () => this.moveBy(-1)],
      ["cv-down", "Move down", () => this.moveBy(1)],
      ["cv-below", "Add entry below", () => this.addBelow()],
      ["cv-delete", "Delete", () => void this.deleteSelected()],
    ];
    for (const [cls, label, run] of actions) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = label;
      b.addEventListener("click", () => {
        if (b.getAttribute("aria-disabled") !== "true") run();
      });
      box.append(b);
    }
    // A text edit commits before a tool acts on the entry.
    box.addEventListener("mousedown", () => this.finishEdit(false));
    return box;
  }

  /** Tools act only on a page that shows the current YAML. */
  private updateTools() {
    const info = this.entryInfo();
    const count = info ? this.countAt(info.seq) : 0;
    const section = isSection(this.selected);
    this.tools.setAttribute("aria-label", section ? "Section actions" : "Entry actions");
    this.tools.querySelector<HTMLElement>(".cv-below")!.hidden = section;
    this.tools.querySelector<HTMLElement>(".cv-delete")!.textContent = section ? "Delete section" : "Delete";
    for (const b of this.tools.querySelectorAll<HTMLButtonElement>("button")) {
      const off = !this.current || !info || (b.classList.contains("cv-up") && info.index === 0) || (b.classList.contains("cv-down") && info.index >= count - 1);
      if (off) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
    }
  }

  private entryInfo() {
    if (!this.selected) return null;
    const path = fromDataPath(this.selected);
    const index = path[path.length - 1];
    if (typeof index !== "number") return null;
    return { path, seq: path.slice(0, -1), index };
  }

  private countAt(seq: YamlPath): number {
    const v = getValue(this.cb.yaml(), seq);
    return Array.isArray(v) ? v.length : 0;
  }

  /** Applies a change that can move paths; `refocus` says what gets focus after the render. */
  private edit(fn: (yaml: string) => string, refocus?: Refocus): boolean {
    let out: string;
    try {
      out = fn(this.cb.yaml());
    } catch (e) {
      this.cb.notify(`Could not change the YAML: ${e instanceof Error ? e.message : e}`);
      return false;
    }
    this.refocus = refocus ? { ...refocus, version: this.version + 1 } : null;
    this.ownEdit = true;
    try {
      this.cb.apply(out);
    } finally {
      this.ownEdit = false;
    }
    return true;
  }

  /** True (with a message) when other places reuse the entry through an anchor inside it. */
  private reused(path: YamlPath): boolean {
    const name = reusedAnchor(this.cb.yaml(), path);
    if (name) this.cb.notify(`This ${path.length === 2 ? "section" : "entry"} is reused elsewhere through &${name}. Edit the YAML to change it.`);
    return !!name;
  }

  private moveBy(delta: number) {
    const info = this.entryInfo();
    if (!info || !this.current || this.reused(info.path)) return;
    const to = info.index + delta;
    if (to < 0 || to >= this.countAt(info.seq)) return;
    this.moves.push({ version: this.version + 1, fn: null });
    this.edit((y) => moveItem(y, info.seq, info.index, to), { path: [...info.seq, to], target: "tool", tool: delta < 0 ? "cv-up" : "cv-down" });
  }

  private addBelow() {
    const info = this.entryInfo();
    if (!info || !this.current) return;
    this.addEntry(info.seq, info.index + 1, String(getValue(this.cb.yaml(), [...info.seq.slice(0, 2), "layout"]) ?? "list"));
  }

  private async deleteSelected() {
    const info = this.entryInfo();
    if (!info || !this.current || this.reused(info.path)) return;
    const section = info.path.length === 2;
    if (section) {
      const title = String(getValue(this.cb.yaml(), [...info.path, "title"]) ?? "");
      if (!(await this.cb.confirm(`Delete the section '${title}' and its entries?`, "Delete section")) || !this.current) return;
    }
    const count = this.countAt(info.seq);
    this.select(null);
    // Focus goes to the item that takes its place (or the one before the last).
    const next: Refocus | undefined = count > 1 ? { path: [...info.seq, Math.min(info.index, count - 2)], target: "focus" } : undefined;
    this.shift(info.seq, info.index, -1);
    if (!this.edit((y) => deleteAt(y, info.path), next)) return;
    this.cb.notify(section ? "Section deleted." : "Entry deleted.", [
      {
        label: "Undo",
        run: () => {
          this.refocus = { path: info.path, target: "focus", version: this.version + 1 };
          this.cb.undo();
        },
      },
    ]);
  }

  // ------------------------------------------------------------ editing text in place

  /** The YAML value at the path, which `data-raw` mirrors when the page is current. */
  private rawOf(el: HTMLElement, path: YamlPath): { raw: string; latex: boolean } {
    const value = getValue(this.cb.yaml(), path);
    if (value && typeof value === "object" && "latex" in (value as object)) return { raw: String((value as { latex: unknown }).latex), latex: true };
    const dataRaw = el.dataset.raw;
    if (typeof value === "string") return { raw: value, latex: false };
    if (typeof value === "number" || typeof value === "boolean") {
      // data-raw has the number as written ("2024", "1.0"); keep it when it is the same number.
      return { raw: dataRaw !== undefined && Number(dataRaw) === Number(value) ? dataRaw : String(value), latex: false };
    }
    return { raw: value === undefined || value === null ? (dataRaw ?? "") : String(value), latex: false };
  }

  private startEdit(el: HTMLElement) {
    this.finishEdit(false);
    // Finishing may have re-rendered the page: edit the same value there.
    if (!el.isConnected) {
      const key = this.keyOf(el);
      const again = key && this.find(key);
      if (!again) return;
      el = again;
    }
    const add = this.additions.get(el);
    const path = add ? add.focus : fromDataPath(el.dataset.path ?? "");
    const { raw, latex } = add ? { raw: "", latex: false } : this.rawOf(el, path);
    const press = this.clickCaret?.el === el ? this.clickCaret : null;
    this.clickCaret = null;
    const click = press?.at == null || add ? null : press.mapped ? press.at : rawOffset(raw, press.text ?? "", press.at, press.date);
    // After a change that may move paths, this element may stand for another value: edit it after the render.
    if (this.stale(path) && !add?.after) {
      const key = this.keyOf(el);
      if (key) this.queued = { key, at: click };
      return;
    }
    const anchor = el.dataset.anchor ?? null;
    const shown = el.textContent ?? "";
    // Only some elements can be a textbox; inside others a span is.
    const box = !add && /^(LI|H\d)$/.test(el.tagName) ? document.createElement("span") : el;
    const editing: Editing = { el, box, path, yaml: this.cb.yaml(), raw, latex, saved: [...el.childNodes], done: false, anchor, label: box.getAttribute("aria-label"), add };
    this.editing = editing;
    // Same font, size and place: only an inline value's own spaces must not stretch with its justified line.
    const style = getComputedStyle(el);
    if (style.display === "inline" && el.getClientRects().length <= 1) {
      // An inline box is as tall as its font's content area: the same line height keeps the box and baseline.
      el.style.lineHeight = `${el.offsetHeight}px`;
      el.style.display = "inline-block";
    } else if (style.display === "inline-block" && !el.firstChild) {
      // Empty, it is an inline block only until text is typed.
      el.style.display = "inline-block";
    } else if (/grid|flex/.test(style.display)) el.style.display = "block";
    box.textContent = raw + (this.typeahead ?? "");
    this.typeahead = null;
    if (box !== el) {
      box.dataset.cvBox = "";
      el.replaceChildren(box);
    }
    if (raw.includes("\n")) box.style.whiteSpace = "pre-wrap";
    el.dataset.editing = "";
    box.dataset.ph = el.dataset.ph ?? (add ? shown : phLabel(path));
    try {
      box.contentEditable = "plaintext-only";
    } catch {
      box.contentEditable = "true";
    }
    box.spellcheck = true;
    box.setAttribute("role", "textbox");
    box.setAttribute("aria-label", add ? shown : `Edit ${toDataPath(path)}`);
    box.setAttribute("aria-multiline", "true");
    if (anchor) for (const peer of this.peers(anchor, el)) peer.classList.add("cv-alias-peer");
    if (!add || add.after) this.cb.reveal(path);
    const sel = el.ownerDocument.getSelection();
    // WebKit gives a caret only when the element is focused again as an editable one.
    this.quietFocus = true;
    try {
      if (this.root.activeElement === box) box.blur();
      box.focus();
    } finally {
      this.quietFocus = false;
    }
    const caret = () => {
      if (!sel || editing.done) return;
      // WebKit ignores addRange inside a shadow root; collapse works everywhere.
      const text = box.firstChild as Text | null;
      if (text) sel.collapse(text, Math.min(click ?? text.length, text.length));
      else sel.collapse(box, 0);
    };
    caret();
    if (press?.x !== undefined) this.pressed = { x: press.x, y: press.y!, caret };
    // WebKit can drop the caret when the tools attach in the same task: focus again once.
    setTimeout(() => {
      if (editing.done || this.root.activeElement !== box || (sel && sel.rangeCount > 0) || this.retriedCaret === el) return;
      this.retriedCaret = el;
      this.finishEdit(true, { retry: true });
      this.clickCaret = { el, at: click, mapped: true };
      el.blur();
      el.focus();
      if (this.editing?.el !== el) this.startEdit(el);
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        this.finishEdit(false, { key: true });
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.finishEdit(true, { key: true });
      }
    };
    const onBlur = () => {
      if (this.phPress && add && el.isConnected) {
        el.focus();
        caret();
        return;
      }
      this.finishEdit(false);
    };
    box.addEventListener("keydown", onKey);
    box.addEventListener("blur", onBlur);
    editing.cleanup = () => {
      box.removeEventListener("keydown", onKey);
      box.removeEventListener("blur", onBlur);
    };
  }

  private peers(anchor: string, el?: HTMLElement): HTMLElement[] {
    return [...this.content.querySelectorAll<HTMLElement>("[data-anchor],[data-via-alias]")].filter(
      (p) => p !== el && (p.dataset.anchor === anchor || p.dataset.viaAlias === anchor),
    );
  }

  get isEditing(): boolean {
    return !!this.editing && !this.editing.done;
  }

  /** The list item that clearing the value at `path` removes: a bullet, list entry, detail line or contact item. */
  private itemOf(yaml: string, path: YamlPath): YamlPath | null {
    if (path[0] === "contact") {
      let i = path.length - 1;
      while (i > 0 && typeof path[i] !== "number") i--;
      return i > 0 ? path.slice(0, i + 1) : null;
    }
    const value = getValue(yaml, path);
    return typeof path[path.length - 1] === "number" && (typeof value === "string" || typeof value === "number") ? path : null;
  }

  /** Where Enter in the value at `path` starts a new item: after a bullet, sub-item or list entry. */
  private chainOf(yaml: string, path: YamlPath): { seq: YamlPath; index: number } | null {
    const last = path[path.length - 1];
    if (typeof last === "number" && path[path.length - 2] === "bullets") return { seq: path.slice(0, -1), index: last };
    const list = path[0] === "sections" && path[2] === "entries" && getValue(yaml, [...path.slice(0, 2), "layout"]) === "list";
    if (list && typeof path[3] === "number" && (path.length === 4 || (path.length === 5 && path[4] === "text"))) return { seq: path.slice(0, 3), index: path[3] };
    return null;
  }

  /** The change that writes `text` into the value being edited. */
  private commitFn(ed: Editing, text: string): (yaml: string) => string {
    const add = ed.add;
    if (add?.after) return (y) => setScalar(y, add.focus, text);
    if (add) {
      return (y) =>
        add.make
          ? replaceItem(y, add.path, add.make(text))
          : add.list && Array.isArray(getValue(y, add.path))
            ? insertItem(y, add.path, text)
            : addKey(y, add.path, add.list ? [text] : text);
    }
    return (y) => {
      const key = ed.path[ed.path.length - 1];
      if (text === "" && typeof key === "string" && !REQUIRED.has(key) && !ed.latex && this.mappingHasOtherKeys(y, ed.path)) return deleteAt(y, ed.path);
      return setScalar(y, ed.latex ? [...ed.path, "latex"] : ed.path, text);
    };
  }

  /** Removes the item at `path`, and a contact line it leaves empty. */
  private removeFn(path: YamlPath): (yaml: string) => string {
    return (y) => {
      let out = deleteAt(y, path);
      const seq = path.slice(0, -1);
      const line = seq[seq.length - 1] === "items" ? seq.slice(0, -1) : seq;
      if (path[0] === "contact" && line.length === 2) {
        const left = getValue(out, seq);
        if (Array.isArray(left) && !left.length) out = deleteAt(out, line);
      }
      return out;
    };
  }

  /** Ends the edit; `key` is Enter or Escape, which keep focus on the value (Escape cancels). */
  finishEdit(cancel: boolean, opts: { key?: boolean; retry?: boolean } = {}) {
    const ed = this.editing;
    if (!ed || ed.done) return;
    ed.done = true;
    ed.cleanup?.();
    const { el, box } = ed;
    // Compare before normalising, so focusing and leaving a block scalar never rewrites it.
    let typed = (box.textContent ?? "").replace(/\r\n?/g, "\n");
    if (!ed.raw.includes("\u00a0")) typed = typed.replace(/\u00a0/g, " ");
    for (const p of ["display", "line-height", "white-space"]) el.style.removeProperty(p);
    box.removeAttribute("contenteditable");
    if (box === el) {
      if (ed.add) el.setAttribute("role", "button");
      else el.removeAttribute("role");
      if (ed.label === null) el.removeAttribute("aria-label");
      else el.setAttribute("aria-label", ed.label);
      el.removeAttribute("aria-multiline");
      if (ed.add) delete el.dataset.ph;
    } else el.textContent = typed;
    delete el.dataset.editing;
    this.content.querySelectorAll(".cv-alias-peer").forEach((p) => p.classList.remove("cv-alias-peer"));
    const restore = () => el.replaceChildren(...ed.saved);
    this.editing = null;
    if (opts.retry) {
      restore();
      return;
    }
    const trimEnd = (s: string) => s.replace(/\n+$/, "");
    let text = typed;
    // A browser adds no final line break; keep the one the value had (a `|` block keeps one).
    if (ed.raw.endsWith("\n") && !text.endsWith("\n")) text += "\n";
    else if (!ed.raw.endsWith("\n")) text = text.replace(/\n$/, "");
    const changed = !(typed === ed.raw || trimEnd(typed) === trimEnd(ed.raw));
    const final = cancel || (!ed.add && !changed) ? ed.raw : text;
    const yaml = this.cb.yaml();
    const fresh = this.fresh?.edit === toDataPath(ed.path) ? this.fresh : null;
    if (fresh && final.trim()) this.fresh = null;
    // A new entry left without a title, and a list item left empty, go again.
    const after = ed.add?.after;
    const gone =
      (fresh && !final.trim() ? fresh.entry : null) ??
      (after && !final.trim() ? ed.add!.focus : null) ??
      (!ed.add && !ed.latex && final === "" ? this.itemOf(yaml, ed.path) : null);
    const enter = opts.key && !cancel;
    let fn: ((y: string) => string) | null = null;
    let refocus: Refocus | null = enter ? { path: ed.path, target: "focus", from: el } : null;
    let structural = false;
    try {
      if (gone) {
        if (fresh) this.fresh = null;
        const i = gone[gone.length - 1] as number;
        fn = this.removeFn(gone);
        structural = true;
        // Removing a contact line's last item removes the line too.
        if (gone[0] === "contact") this.moves.push({ version: this.version + 1, fn: null });
        else this.shift(gone.slice(0, -1), i, -1);
        refocus = enter ? { path: i > 0 ? [...gone.slice(0, -1), i - 1] : gone.slice(0, -2), target: "focus" } : null;
      } else if (final !== ed.raw || (ed.add && final.trim())) {
        if (!ed.add && yaml !== ed.yaml && this.rawOf(el, ed.path).raw !== ed.raw) throw new Error("the CV changed while you were editing this value");
        fn = this.commitFn(ed, final);
      }
      if (after && gone) {
        this.drop([el.closest<HTMLElement>("[data-cv-ph]") ?? el]);
        if (opts.key) this.focusQuietly(after.matches("[data-cv-edit]") ? after : (after.querySelector<HTMLElement>("[data-cv-edit], [data-cv-add]") ?? after));
      } else if (after && fn) {
        // The new item shows what was typed until the render.
        el.classList.remove("cv-ph");
        el.textContent = final;
      } else if (gone) {
        this.drop(fresh ? this.entryEls(toDataPath(gone)) : [el.closest<HTMLElement>("li") ?? el]);
        if (refocus) this.focusPath({ ...refocus, target: "focus" });
      } else if (!fn || ed.add) restore();
      if (after) refocus = null;
      if (fn && structural) this.edit(fn, refocus ?? undefined);
      else if (fn) {
        this.refocus = refocus && { ...refocus, version: this.version + 1 };
        this.applyingText = true;
        try {
          this.cb.apply(fn(yaml));
        } finally {
          this.applyingText = false;
        }
      }
      if (fn && ed.anchor) {
        const n = aliasCopies(el, ed.anchor, this.content).length;
        if (n) this.cb.notify(`Also changed ${n} other place${n > 1 ? "s" : ""} that use${n > 1 ? "" : "s"} this value through a YAML alias.`);
      }
      if (cancel && opts.key && changed && typed.trim()) this.offerUncancel(ed, text);
      // Enter in a bullet, sub-item or list entry starts the next one right away.
      const chain = enter && !gone && final.trim() ? this.chainOf(this.cb.yaml(), ed.add ? ed.add.focus : ed.path) : null;
      if (chain) this.chainEdit(el, chain.seq, chain.index + 1);
    } catch (e) {
      restore();
      this.cb.notify(`Could not change the YAML: ${e instanceof Error ? e.message : e}`);
    }
    // The keyboard stays on the value after Enter or Escape.
    if (opts.key && !this.isEditing && el.isConnected && this.root.activeElement !== el) this.focusQuietly(el);
    // A blur (Tab) waits until its focus change has landed.
    if (opts.key) this.flush();
    else setTimeout(() => this.flush(), 0);
  }

  /** The render or page split that waited for an edit or a press. */
  private flush() {
    if (this.isEditing || this.held) return;
    const p = this.pending;
    if (p) this.show(p.html, p.css, p.version);
    else if (this.pagesPending) this.repaginate();
  }

  /** An empty item below `el`'s item, being edited: typed text goes in at `seq[index]`. */
  private chainEdit(el: HTMLElement, seq: YamlPath, index: number) {
    const item = el.closest<HTMLElement>("li") ?? el;
    const add: Addition = { path: seq, list: true, after: item, focus: [...seq, index] };
    // An empty item in the YAML too, so the editor shows the new line; left empty, it goes again.
    this.shift(seq, index, 1);
    if (!this.edit((y) => insertItem(y, seq, "", index))) return;
    add.version = this.version;
    const line = this.placeholder("", add, "span", "", `li.${item.classList[0]}`);
    item.after(line);
    this.startEdit(line.firstElementChild as HTMLElement);
  }

  /** Takes elements off the page before the render does; under a press they only hide, so what is pressed stays put. */
  private drop(els: HTMLElement[]) {
    for (const e of els) {
      if (this.held) {
        e.style.visibility = "hidden";
        e.dataset.cvGone = "";
      } else e.remove();
    }
  }

  /** The next change inserts (+1) or removes (-1) the item at `seq[index]`. */
  private shift(seq: YamlPath, index: number, by: 1 | -1) {
    this.moves.push({ version: this.version + 1, fn: shiftPaths(seq, index, by) });
  }

  /** How paths of the page at version `from` map to version `to`; null when unknown. */
  private mapFrom(from: number, to = Infinity): ((p: YamlPath) => YamlPath) | null {
    const moves = this.moves.filter((m) => m.version > from && m.version <= to);
    if (moves.some((m) => !m.fn)) return null;
    return (p) => moves.reduce((q, m) => m.fn!(q), p);
  }

  /** The element for `path` on the shown page may stand for another value after the pending changes. */
  private stale(path: YamlPath): boolean {
    const map = this.mapFrom(this.shownVersion);
    return !map || !samePath(map(path), path);
  }

  /** "Edit cancelled" with Undo, which writes the discarded text after all. */
  private offerUncancel(ed: Editing, text: string) {
    const after = this.cb.yaml();
    this.cb.notify("Edit cancelled.", [
      {
        label: "Undo",
        run: () => {
          if (this.cb.yaml() !== after) {
            this.cb.notify("The CV changed since, so the edit cannot come back.");
            return;
          }
          const path = ed.add ? ed.add.focus : ed.path;
          this.edit(() => this.commitFn(ed, text)(ed.yaml), { path, target: "focus" });
        },
      },
    ]);
  }

  /** Deleting the key leaves no `{}`. */
  private mappingHasOtherKeys(yaml: string, path: YamlPath): boolean {
    const parent = path.length > 1 ? parseCached(yaml).getIn(path.slice(0, -1), true) : parseCached(yaml).contents;
    return isMap(parent) && parent.items.length > 1;
  }

  private focusQuietly(el: HTMLElement) {
    this.quietFocus = true;
    try {
      el.focus();
    } finally {
      this.quietFocus = false;
    }
  }

  private keyOf(el: Element | null): Key | null {
    if (!(el instanceof HTMLElement)) return null;
    if (this.tools.contains(el) && el !== this.tools) return { tool: el.className };
    const owner = el.closest<HTMLElement>("[data-cv-add], [data-cv-edit]");
    // An item Enter started has a path in the pending render's terms already.
    if (owner?.dataset.cvAdd) return { attr: "data-cv-add", path: fromDataPath(owner.dataset.cvAdd), exact: this.additions.get(owner)?.version };
    if (owner?.dataset.path) return { attr: "data-path", path: fromDataPath(owner.dataset.path) };
    return null;
  }

  private find(key: Key, map: (p: YamlPath) => YamlPath = (p) => p): HTMLElement | null {
    if ("tool" in key) return this.tools.isConnected ? this.tools.querySelector<HTMLElement>(`.${key.tool}`) : null;
    const want = toDataPath(key.exact !== undefined ? (this.mapFrom(key.exact, this.shownVersion) ?? ((p: YamlPath) => p))(key.path) : map(key.path));
    // A value added through a placeholder has the placeholder's path.
    const all = [...this.content.querySelectorAll<HTMLElement>("[data-cv-add], [data-cv-edit]")];
    return all.find((e) => e.getAttribute(key.attr) === want) ?? all.find((e) => e.dataset.path === want || e.dataset.cvAdd === want) ?? null;
  }

  /** Focus on the element for `key` again, or on the selected item, never on nothing. */
  private focusKey(key: Key, map?: (p: YamlPath) => YamlPath) {
    const el = this.find(key, map) ?? (this.selected ? this.entryEls(this.selected)[0]?.querySelector<HTMLElement>("[data-cv-edit]") : null);
    if (el) this.focusQuietly(el);
  }

  private focusPath(r: Refocus) {
    if (r.target === "tool") {
      this.select(this.entryPathOf(r.path));
      const b = this.tools.querySelector<HTMLElement>(`.${r.tool}`);
      if (b) this.focusQuietly(b);
      return;
    }
    const want = toDataPath(r.path);
    const els = [...this.content.querySelectorAll<HTMLElement>("[data-cv-edit]")];
    const el = els.find((e) => e.dataset.path === want) ?? els.find((e) => isPrefix(r.path, fromDataPath(e.dataset.path ?? "")));
    if (!el) return;
    if (r.target === "focus") this.focusQuietly(el);
    else el.focus();
  }

  // ------------------------------------------------------------ add section

  private renderAddButton(focus = false) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cv-add-section";
    btn.textContent = "+ Add section";
    btn.addEventListener("click", () => this.renderAddForm());
    this.addBox.replaceChildren(btn);
    if (focus) btn.focus();
  }

  private renderAddForm() {
    const form = document.createElement("form");
    form.setAttribute("aria-label", "Add section");
    const titleLabel = document.createElement("label");
    titleLabel.className = "cv-field";
    titleLabel.textContent = "Section title";
    const title = document.createElement("input");
    title.type = "text";
    title.value = LAYOUTS[0][3];
    let typedTitle = false;
    title.addEventListener("input", () => (typedTitle = true));
    titleLabel.append(title);

    const group = document.createElement("fieldset");
    group.className = "cv-layouts";
    const legend = document.createElement("legend");
    legend.textContent = "Layout";
    group.append(legend);
    for (const [i, [layout, name, hint, suggested]] of LAYOUTS.entries()) {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "cv-layout";
      radio.value = layout;
      radio.checked = i === 0;
      radio.addEventListener("change", () => {
        if (!typedTitle) title.value = suggested;
        bibRow.hidden = layout !== "publications";
      });
      const b = document.createElement("b");
      b.textContent = name;
      label.append(radio, b, ` · ${hint}`);
      group.append(label);
    }

    const bibs = this.cb.bibs();
    let fresh = "publications.bib";
    for (let n = 2; bibs.includes(fresh); n++) fresh = `publications-${n}.bib`;
    const bibRow = document.createElement("label");
    bibRow.className = "cv-field";
    bibRow.hidden = true;
    bibRow.textContent = "BibTeX file";
    const bib = document.createElement("select");
    for (const name of [...bibs, fresh]) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name === fresh ? `New file: ${fresh}` : name;
      bib.append(o);
    }
    bibRow.append(bib);

    const actions = document.createElement("div");
    actions.className = "cv-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.renderAddButton(true));
    const add = document.createElement("button");
    add.type = "submit";
    add.className = "cv-primary";
    add.textContent = "Add section";
    actions.append(cancel, add);

    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.renderAddButton(true);
      }
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const layout = (form.querySelector<HTMLInputElement>("input[name=cv-layout]:checked")?.value ?? "list") as Layout;
      const name = title.value.trim() || "New Section";
      const count = this.countAt(["sections"]);
      if (layout === "publications" && bib.value === fresh) this.cb.addFile(fresh, EXAMPLE_BIB);
      this.renderAddButton();
      if (layout === "publications") {
        this.edit((y) => addSection(y, newSection(layout, name, undefined, bib.value)), { path: ["sections", count, "title"], target: "focus" });
        return;
      }
      // One empty entry to type into, as "+ Add entry" makes.
      const entry = newEntry(layout);
      const path = ["sections", count, "entries", 0];
      const edit = isObject(entry) ? [...path, "title"] : path;
      this.fresh = { entry: path, edit: toDataPath(edit) };
      this.addBox.querySelector<HTMLElement>("button")?.focus();
      this.typeahead = "";
      this.edit((y) => addSection(y, newSection(layout, name, entry)), { path: edit, target: "edit" });
    });
    form.append(titleLabel, group, bibRow, actions);
    this.addBox.replaceChildren(form);
    title.focus({ preventScroll: true });
    title.select();
    form.scrollIntoView({ block: "nearest" });
  }
}

const STRUCTURAL = "[data-entry],[data-section],[data-contact]";

/** The aliased copies of `el`: same `data-via-alias` name, same place inside the copy as `el` inside the anchor. */
export function aliasCopies(el: HTMLElement, name: string, root: ParentNode): HTMLElement[] {
  const is = (e: Element, attr: string) => e.getAttribute(attr) === name;
  let anchorRoot: Element = el;
  for (let p = el.parentElement; p; p = p.parentElement) if (is(p, "data-anchor")) anchorRoot = p;
  const steps: number[] = [];
  // The editing tools and placeholders are not part of the render.
  const kids = (e: Element) => [...e.children].filter((c) => !c.hasAttribute("data-cv-ui"));
  for (let e: Element = el; e !== anchorRoot; e = e.parentElement!) steps.unshift(kids(e.parentElement!).indexOf(e));
  const copyRoots = new Set<Element>();
  for (const v of root.querySelectorAll(`[data-via-alias]`)) {
    if (!is(v, "data-via-alias")) continue;
    let top: Element = v;
    for (let p = v.parentElement; p; p = p.parentElement) if (is(p, "data-via-alias")) top = p;
    if (anchorRoot.matches(STRUCTURAL) && !top.matches(STRUCTURAL)) top = top.closest(STRUCTURAL) ?? top;
    if (!anchorRoot.contains(top)) copyRoots.add(top);
  }
  const out: HTMLElement[] = [];
  for (const r of copyRoots) {
    let e: Element | undefined = r;
    for (const i of steps) e = e && kids(e)[i];
    if (e && is(e, "data-via-alias")) out.push(e as HTMLElement);
  }
  return out;
}
