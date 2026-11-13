// Page boxes: the live page split where the PDF's pages start, or by height before the first PDF.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

type PdfJs = typeof import("pdfjs-dist");
let lib: Promise<PdfJs> | null = null;

/** Where a PDF page starts: the end of the page before it and its own start, normalized, and its offset in the PDF's text. */
export interface PageBreak {
  before: string;
  start: string;
  at?: number;
  total?: number;
}

const KEY = 24;

/** Letters and digits only, so PDF ligatures, dashes, bullets and case do not matter. */
export const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export async function pdfBreaks(pdf: Uint8Array): Promise<PageBreak[]> {
  lib ??= import("pdfjs-dist").then((m) => {
    m.GlobalWorkerOptions.workerSrc = workerUrl;
    return m;
  });
  const task = (await lib).getDocument({ data: pdf.slice(), enableXfa: false });
  try {
    const doc = await task.promise;
    const texts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      texts.push(norm(content.items.map((it) => ("str" in it ? it.str : "")).join("")));
    }
    const total = texts.reduce((n, t) => n + t.length, 0);
    let at = 0;
    return texts.slice(1).map((t, i) => {
      at += texts[i].length;
      return { before: texts[i].slice(-KEY), start: t.slice(0, KEY), at, total };
    });
  } finally {
    await task.destroy();
  }
}

/** Blocks a page can start at, innermost first. */
const BLOCK = ".cv-section-title,.cv-description,.cv-line,.cv-detail,.cv-bullet,.cv-list-item,.cv-subitem,.cv-dated-row,.cv-paragraph,.cv-citation";
const UI = "[data-cv-ui]";
/** Attributes a continuation must not repeat: it is not a second copy of the YAML node. */
const DROP = ["id", "data-path", "data-raw", "data-entry", "data-section", "data-contact", "data-newpage", "data-anchor", "data-via-alias", "data-cv-entry", "data-cv-edit", "tabindex"];

const elements = (el: Element) => [...el.children].filter((c) => !c.matches(UI));

function pages(doc: Element): HTMLElement[] {
  return [...doc.querySelectorAll<HTMLElement>(":scope > .cv-page")];
}

/** The block to break before: the outermost one that starts with `el`; null at the top of a page. */
function breakBefore(el: Element, page: Element): Element | null {
  if (el.closest(".cv-header")) return null;
  while (el.parentElement && el.parentElement !== page && elements(el.parentElement)[0] === el) el = el.parentElement;
  return el.parentElement === page && elements(page)[0] === el ? null : el;
}

/** Moves `target` and all that follows it on its page into a new page, inside copies of its containers. */
function split(target: Element, page: HTMLElement): HTMLElement {
  let node = target;
  let carry: Element | null = null;
  for (;;) {
    const parent = node.parentElement!;
    const shell = parent.cloneNode(false) as HTMLElement;
    const of = parent.getAttribute("data-entry") ?? parent.getAttribute("data-section");
    for (const a of DROP) shell.removeAttribute(a);
    shell.classList.remove("cv-entry-active");
    shell.dataset.cvCont = "";
    if (of) shell.dataset.cvOf = of;
    const moving: Node[] = [];
    for (let n: Node | null = carry ? node.nextSibling : node; n; n = n.nextSibling) moving.push(n);
    if (carry) shell.append(carry);
    shell.append(...moving);
    if (parent === page) {
      page.after(shell);
      return shell;
    }
    carry = shell;
    node = parent;
  }
}

function merge(into: Element, from: Element) {
  const first = elements(from)[0];
  if (first?.hasAttribute("data-cv-cont")) {
    merge(elements(into).at(-1)!, first);
    first.remove();
  }
  into.append(...from.childNodes);
}

/** Back to the pages the renderer made (one per `newpage`). */
export function unpaginate(doc: Element) {
  for (const page of pages(doc).reverse()) {
    if (page.hasAttribute("data-cv-cont")) {
      merge(page.previousElementSibling!, page);
      page.remove();
    }
  }
}

/** Splits where the PDF's pages start; returns how many breaks were found. */
export function paginateByPdf(doc: HTMLElement, breaks: PageBreak[]): number {
  const parts: { at: number; node: Text }[] = [];
  let text = "";
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(UI) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const t = norm(n.data);
    if (!t) continue;
    parts.push({ at: text.length, node: n });
    text += t;
  }
  let from = 0;
  let found = 0;
  // A repeated line matches in several places: take the one nearest where the PDF breaks.
  const nearest = (key: string, shift: number, expected: number) => {
    let best = -1;
    for (let i = text.indexOf(key, from); i >= 0; i = text.indexOf(key, i + 1)) {
      if (best >= 0 && Math.abs(i + shift - expected) >= Math.abs(best - expected)) break;
      best = i + shift;
    }
    return best;
  };
  for (const b of breaks) {
    const expected = b.at !== undefined && b.total ? (b.at * text.length) / b.total : from;
    const both = b.before && b.start ? nearest(b.before + b.start, b.before.length, expected) : -1;
    const at = both >= 0 ? both : b.start ? nearest(b.start, 0, expected) : -1;
    if (at < 0) continue;
    from = at + 1;
    found++;
    let i = parts.length - 1;
    while (i > 0 && parts[i].at > at) i--;
    const node = parts[i].node;
    const page = node.parentElement?.closest<HTMLElement>(".cv-page");
    const block = node.parentElement?.closest(BLOCK);
    const target = page && block ? breakBefore(block, page) : null;
    if (target && page) split(target, page);
  }
  return found;
}

/** Splits `page` before the first block that ends past its height plus `slack` CSS pixels; null when it fits or is hidden. */
function fitPage(page: HTMLElement, slack: number): HTMLElement | null {
  const style = getComputedStyle(page);
  const box = page.getBoundingClientRect();
  const scale = box.width / parseFloat(style.width);
  if (!scale) return null;
  const limit = parseFloat(style.minHeight) - parseFloat(style.paddingBottom) + slack;
  const blocks = [...page.querySelectorAll(BLOCK)].filter((b) => !b.closest(UI) && !b.querySelector(BLOCK));
  const over = blocks.find((b) => (b.getBoundingClientRect().bottom - box.top) / scale > limit);
  const target = over ? breakBefore(over, page) : null;
  return target ? split(target, page) : null;
}

/** Splits every page whose content runs past its height by more than `slack` CSS pixels; false when hidden. */
export function paginateByHeight(doc: HTMLElement, slack = 0): boolean {
  const all = pages(doc);
  if (all.length && !all[0].getBoundingClientRect().width) return false;
  for (let i = 0; i < all.length; i++) {
    const next = fitPage(all[i], slack);
    if (next) all.splice(i + 1, 0, next);
  }
  return true;
}
