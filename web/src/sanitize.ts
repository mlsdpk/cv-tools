// An allowlist sanitizer for the HTML of cv-tools' renderer (web-spec sections 4.2, 4.3 and 4.6).
// cv-tools escapes every value itself; this is a second fence that keeps only the elements,
// attributes, classes and link targets the contract allows, and drops everything else.

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

/** Elements of section 4.2 (HTML) and of the inline contact icons (SVG). */
const HTML_ELEMENTS = new Set(["div", "header", "section", "p", "h1", "h2", "span", "a", "strong", "em", "br", "sup", "code", "ul", "li"]);
const SVG_ELEMENTS = new Set(["svg", "path", "g"]);

/** Data attributes of section 4.3, and the alias markers. */
const DATA_ATTRIBUTES = new Set([
  "data-path",
  "data-raw",
  "data-latex",
  "data-entry",
  "data-section",
  "data-newpage",
  "data-contact",
  "data-readonly",
  "data-layout",
  "data-source-format",
  "data-editable",
  "data-via-alias",
  "data-anchor",
]);

const ELEMENT_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(["href", "aria-label"]),
  svg: new Set(["viewbox", "aria-hidden", "focusable", "width", "height"]),
  path: new Set(["d", "fill", "transform", "fill-rule", "clip-rule"]),
  g: new Set(["fill", "transform"]),
};

const CLASS = /^cv-[a-z0-9-]+$/;
const SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** True for an absolute http, https or mailto URL, parsed the way the browser will parse it. */
export function safeHref(value: string): boolean {
  try {
    return SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function allowedElement(el: Element): boolean {
  const name = el.localName.toLowerCase();
  if (el.namespaceURI === HTML_NS) return HTML_ELEMENTS.has(name);
  if (el.namespaceURI === SVG_NS) return SVG_ELEMENTS.has(name) && (name === "svg" || el.closest("svg") !== null);
  return false;
}

function cleanAttributes(el: Element) {
  const name = el.localName.toLowerCase();
  for (const attr of [...el.attributes]) {
    const a = attr.name.toLowerCase();
    let keep = DATA_ATTRIBUTES.has(a) || a === "class" || (ELEMENT_ATTRIBUTES[name]?.has(a) ?? false);
    if (attr.namespaceURI) keep = false; // xlink:href and other namespaced attributes
    if (keep && a === "href") keep = safeHref(attr.value);
    // SVG presentation attributes are CSS: `fill="url(https://...)"` would fetch.
    if (keep && el.namespaceURI === SVG_NS && /url\(/i.test(unescapeCss(attr.value)) && !LOCAL_URL.test(unescapeCss(attr.value))) keep = false;
    if (keep && a === "class") {
      const classes = attr.value.split(/\s+/).filter((c) => CLASS.test(c));
      if (classes.length) el.setAttribute("class", classes.join(" "));
      else el.removeAttribute(attr.name);
      continue;
    }
    if (!keep) el.removeAttribute(attr.name);
  }
}

/** The renderer's HTML as a fragment that holds only what the contract allows. */
export function sanitize(html: string, doc: Document = document): DocumentFragment {
  const t = doc.createElement("template");
  t.innerHTML = html;
  const walk = (parent: ParentNode) => {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === 1) {
        const el = node as Element;
        if (!allowedElement(el)) {
          el.remove();
          continue;
        }
        cleanAttributes(el);
        walk(el);
      } else if (node.nodeType !== 3) {
        node.parentNode?.removeChild(node); // comments, processing instructions
      }
    }
  };
  walk(t.content);
  return t.content;
}

const LOCAL_URL = /^\s*url\(\s*(['"]?)#[^)]*\1\s*\)\s*$/i;

/** Decode CSS escapes, except those that write quotes, backslashes or line breaks (so strings stay intact). */
export function unescapeCss(css: string): string {
  return css.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([^\n\r\f0-9a-fA-F"'\\])/g, (all, hex: string | undefined, ch: string | undefined) => {
    if (ch !== undefined) return ch;
    const c = String.fromCodePoint(Math.min(parseInt(hex!, 16), 0x10ffff) || 0xfffd);
    return /["'\\\n\r\f]/.test(c) ? all : c;
  });
}

/** A url() target that fetches from elsewhere: any scheme, or `//host` (a tab or line break inside does not hide it). */
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:|[/\\]{2})/i;

/** The renderer's stylesheet without imports or remote URLs (the app serves its own fonts). Clean CSS is returned as it is. */
export function sanitizeCss(css: string): string {
  const plain = css
    .split(/(\/\*[\s\S]*?\*\/)/)
    .map((part, i) => (i % 2 ? "" : unescapeCss(part)))
    .join("");
  const clean = plain
    .replace(/@import[^;]*;?/gi, "")
    .replace(/(?:-webkit-)?image-set\([^)]*\)/gi, "none")
    .replace(/url\(\s*(['"]?)([^)]*?)\1\s*\)/gi, (all, _q, target: string) => (REMOTE.test(target.replace(/[\t\n\r\f]/g, "").trim()) ? "none" : all));
  return clean === plain ? css : clean;
}
