// Edits of the CV YAML by path: a minimal text patch, checked against the edited Document; never a reformat.

import { CST, Document, isAlias, isMap, isPair, isScalar, isSeq, Parser, parseDocument, Scalar, stringify, visit, YAMLMap, YAMLSeq } from "yaml";
import type { Node, ParsedNode } from "yaml";

export type PathPart = string | number;
export type YamlPath = PathPart[];

export class YamlEditError extends Error {}

const PARSE_OPTIONS = { keepSourceTokens: true, prettyErrors: false } as const;

export function parse(text: string): Document.Parsed {
  return parseDocument(text, PARSE_OPTIONS);
}

const cache: { text: string; doc: Document.Parsed }[] = [];

/** Shared by every reader of the same text; callers must not change it. */
export function parseCached(text: string): Document.Parsed {
  const hit = cache.find((c) => c.text === text);
  if (hit) return hit.doc;
  const doc = parse(text);
  cache.unshift({ text, doc });
  cache.length = Math.min(cache.length, 3);
  return doc;
}

// ---------------------------------------------------------------- path formats

/** `sections[0].entries[1].date`, as cv-tools prints paths in its messages. */
export function formatPath(path: YamlPath): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${part}` : part;
  }
  return out;
}

/** `sections.0.entries.1.date`, the `data-path` attribute of the live preview. */
export function toDataPath(path: YamlPath): string {
  return path.join(".");
}

export function fromDataPath(dataPath: string): YamlPath {
  if (dataPath === "") return [];
  return dataPath.split(".").map((p) => (/^(0|[1-9][0-9]*)$/.test(p) ? Number(p) : p));
}

export function samePath(a: YamlPath, b: YamlPath): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

export function isPrefix(prefix: YamlPath, path: YamlPath): boolean {
  return prefix.length <= path.length && prefix.every((p, i) => p === path[i]);
}

// ---------------------------------------------------------------- path <-> source position

function keyOf(key: unknown): PathPart {
  if (isScalar(key)) {
    const v = key.value;
    return typeof v === "number" ? String(v) : String(v);
  }
  return String(key);
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

/** A key position names its value. */
export function pathAt(doc: Document.Parsed, text: string, offset: number): YamlPath {
  const path: YamlPath = [];
  let node: unknown = doc.contents;
  for (;;) {
    if (isMap(node)) {
      let next: unknown = undefined;
      for (const pair of node.items) {
        const key = pair.key as ParsedNode | null;
        const value = pair.value as ParsedNode | null;
        const start = key?.range?.[0] ?? value?.range?.[0];
        const end = value?.range?.[2] ?? key?.range?.[2];
        if (start === undefined || end === undefined) continue;
        if (offset >= start && offset < Math.max(end, start + 1)) {
          path.push(keyOf(key));
          next = value && value.range && offset >= value.range[0] ? value : undefined;
          break;
        }
      }
      if (next === undefined) return path;
      node = next;
    } else if (isSeq(node)) {
      let found = -1;
      const seq = node;
      seq.items.forEach((item, i) => {
        const r = (item as ParsedNode | null)?.range;
        if (!r) return;
        const from = seq.flow ? r[0] : lineStart(text, r[0]);
        if (offset >= from && offset < Math.max(r[2], r[0] + 1)) found = i;
      });
      if (found < 0) return path;
      path.push(found);
      node = node.items[found];
    } else {
      return path;
    }
  }
}

export interface PathRange {
  from: number;
  to: number;
  valueFrom: number;
  valueTo: number;
}

/** Or of its closest ancestor that exists. */
export function rangeOf(doc: Document.Parsed, path: YamlPath): PathRange | null {
  let node: unknown = doc.contents;
  let best: PathRange | null = null;
  for (const part of path) {
    if (isMap(node)) {
      const pair = node.items.find((p) => keyOf(p.key) === String(part));
      if (!pair) break;
      const key = pair.key as ParsedNode | null;
      const value = pair.value as ParsedNode | null;
      const from = key?.range?.[0] ?? value?.range?.[0];
      if (from === undefined) break;
      const vr = value?.range ?? key!.range!;
      best = { from, to: vr[1], valueFrom: value?.range ? vr[0] : key!.range![1], valueTo: vr[1] };
      node = value;
    } else if (isSeq(node) && typeof part === "number" && part < node.items.length) {
      const item = node.items[part] as ParsedNode | null;
      if (!item?.range) break;
      best = { from: item.range[0], to: item.range[1], valueFrom: item.range[0], valueTo: item.range[1] };
      node = item;
    } else {
      break;
    }
  }
  return best;
}

export function getValue(text: string, path: YamlPath): unknown {
  const doc = parseCached(text);
  const node = doc.getIn(path, true) as Node | undefined;
  if (node === undefined) return undefined;
  return isScalar(node) ? node.value : (node as YAMLMap | YAMLSeq).toJSON();
}

// ---------------------------------------------------------------- verification and fallback

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Map || b instanceof Map) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as never)[k], (b as never)[k]));
}

function data(doc: Document): unknown {
  return doc.toJS({ maxAliasCount: -1 });
}

/** Indented sequences (`key:\n  - item`) unless the file writes them flush with the key. */
function indentSeq(text: string): boolean {
  const m = /^( *)[^\s#-][^\n]*:[ \t]*\n(?:[ \t]*(?:#[^\n]*)?\n)*( *)- /m.exec(text);
  return m ? m[2].length > m[1].length : true;
}

function printed(doc: Document, original: string): string {
  return doc.toString({ lineWidth: 0, minContentWidth: 0, indentSeq: indentSeq(original), flowCollectionPadding: false });
}

export const REFORMAT_MESSAGE =
  "this change would reformat the YAML file (its comments, blank lines or spacing), so it was not made. Make it in the YAML editor instead";

/** A reprint loses nothing. */
function reprintsExactly(original: string): boolean {
  const doc = parse(original);
  if (doc.errors.length) return false;
  const norm = (t: string) => t.replace(/\n*$/, "\n");
  return norm(printed(doc, original)) === norm(original);
}

const commentCache: { text: string; comments: { at: number; text: string }[] }[] = [];

function comments(text: string): { at: number; text: string }[] {
  const hit = commentCache.find((c) => c.text === text);
  if (hit) return hit.comments;
  const out: { at: number; text: string }[] = [];
  commentCache.unshift({ text, comments: out });
  commentCache.length = Math.min(commentCache.length, 2);
  const walk = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) {
      o.forEach(walk);
      return;
    }
    const t = o as { type?: string; offset?: number; source?: string };
    if (t.type === "comment" && typeof t.offset === "number") out.push({ at: t.offset, text: (t.source ?? "").trimEnd() });
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  };
  for (const token of new Parser().parse(text)) walk(token);
  return out;
}

/** True when every comment of `original` outside `removed` is still in `patched`. */
function keepsComments(original: string, patched: string, removed: [number, number] | null): boolean {
  const left = new Map<string, number>();
  for (const c of comments(patched)) left.set(c.text, (left.get(c.text) ?? 0) + 1);
  for (const c of comments(original)) {
    if (removed && c.at >= removed[0] && c.at < removed[1]) continue;
    const n = left.get(c.text) ?? 0;
    if (n === 0) return false;
    left.set(c.text, n - 1);
  }
  return true;
}

/** A text patch, and the range it deletes on purpose (with its comments). */
type Patch = string | { text: string; removed: [number, number] } | null;

function finish(original: string, doc: Document, patch: Patch): string {
  const want = data(doc);
  const patched = patch === null ? null : typeof patch === "string" ? patch : patch.text;
  const removed = patch !== null && typeof patch === "object" ? patch.removed : null;
  if (patched !== null) {
    const re = parseDocument(patched);
    if (re.errors.length === 0 && deepEqual(data(re), want) && keepsComments(original, patched, removed)) return patched;
  }
  if (!reprintsExactly(original)) throw new YamlEditError(REFORMAT_MESSAGE);
  const out = printed(doc, original);
  return original.endsWith("\n") ? out : out.replace(/\n$/, "");
}

function parseForEdit(text: string, shared = false): Document.Parsed {
  const doc = shared ? parseCached(text) : parse(text);
  if (doc.errors.length) throw new YamlEditError(`the YAML has errors: ${doc.errors[0].message}`);
  return doc;
}

function ancestorIsFlow(doc: Document.Parsed, path: YamlPath): boolean {
  let node: unknown = doc.contents;
  for (const part of path) {
    if ((isMap(node) || isSeq(node)) && node.flow) return true;
    node = isMap(node) || isSeq(node) ? node.get(part as never, true) : undefined;
  }
  return false;
}

// ---------------------------------------------------------------- scalars

type ScalarType = "PLAIN" | "QUOTE_SINGLE" | "QUOTE_DOUBLE" | "BLOCK_LITERAL" | "BLOCK_FOLDED";

function plainReadsBack(value: string): boolean {
  try {
    const doc = parseDocument(`k: ${value}\n`);
    return doc.errors.length === 0 && doc.get("k") === value;
  } catch {
    return false;
  }
}

function scalarType(value: string, current: string | undefined, inFlow: boolean): ScalarType {
  const multiline = value.includes("\n");
  const type = (current ?? "PLAIN") as ScalarType;
  if (multiline) {
    if (!inFlow && !/^[ \t]|[ \t]$/m.test(value) && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value)) return "BLOCK_LITERAL";
    return "QUOTE_DOUBLE";
  }
  if (type === "BLOCK_LITERAL" || type === "BLOCK_FOLDED") return plainReadsBack(value) ? "PLAIN" : "QUOTE_DOUBLE";
  if (type === "PLAIN" && !plainReadsBack(value)) return value.includes("'") || /[\\\x00-\x1f]/.test(value) ? "QUOTE_DOUBLE" : "QUOTE_SINGLE";
  if (type === "QUOTE_SINGLE" && /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) return "QUOTE_DOUBLE";
  return type;
}

function sourceLength(token: CST.Token): number {
  return CST.stringify(token).length;
}

/** A missing key is added. Write to `[...path, "latex"]` to keep a `{latex: ...}` value. */
export function setScalar(text: string, path: YamlPath, value: string | number | boolean | null): string {
  const doc = parseForEdit(text, true);
  const node = doc.getIn(path, true) as Node | undefined;
  const parentPath = path.slice(0, -1);
  const parent = parentPath.length ? (doc.getIn(parentPath, true) as Node | undefined) : doc.contents;
  if (!(isMap(parent) || isSeq(parent))) throw new YamlEditError(`no mapping or list at ${formatPath(parentPath)}`);

  // A number stays a number only when typed the way YAML prints it ("2025", not "2024.10" or "1e3").
  if (isScalar(node) && typeof node.value === "number" && typeof value === "string" && !value.includes("\n")) {
    const re = parseDocument(`k: ${value}\n`);
    const n = re.errors.length === 0 ? re.get("k") : undefined;
    if (typeof n === "number" && Number.isFinite(n) && stringify(n).trim() === value) value = n;
  }

  const semantic = parseForEdit(text, true).clone();
  const old = semantic.getIn(path, true) as Node | undefined;
  if (isScalar(old)) {
    old.value = value;
  } else {
    semantic.setIn(path, value);
  }

  let patched: string | null = null;
  if ((isScalar(node) || isAlias(node)) && node.srcToken && typeof value === "string") {
    // An alias (`*name`) is replaced by the scalar; the anchored value stays as it is.
    // An empty value is quoted only because it is empty: what is typed into it is plain when it can be.
    patched = patchScalar(text, doc, path, node.srcToken, isScalar(node) && node.value !== "" ? node.type : undefined, value);
  } else if (isScalar(node) && node.srcToken && value !== null) {
    const source = typeof value === "number" ? stringify(value).trim() : String(value);
    patched = replaceToken(text, node.srcToken, source, { type: "PLAIN" });
  } else if (node === undefined && isMap(parent) && !parent.flow && parent.items.length) {
    patched = appendPair(text, parent, String(path[path.length - 1]), value);
  }
  return finish(text, semantic, patched);
}

function patchScalar(text: string, doc: Document.Parsed, path: YamlPath, token: CST.Token, current: Scalar["type"], value: string): string | null {
  const inFlow = ancestorIsFlow(doc, path);
  let type = scalarType(value, current, inFlow);
  if (type === "PLAIN" && inFlow && /[[\]{},]/.test(value)) type = "QUOTE_DOUBLE";
  const parent = doc.getIn(path.slice(0, -1), true);
  return replaceToken(text, token, value, { type, inFlow, afterKey: isMap(parent) || path.length === 1 });
}

function replaceToken(
  text: string,
  token: CST.Token,
  value: string,
  context: { type: ScalarType; inFlow?: boolean; afterKey?: boolean },
): string | null {
  if (!("offset" in token)) return null;
  const length = sourceLength(token);
  const copy = structuredClone(token) as CST.Token;
  try {
    CST.setScalarValue(copy, value, context);
  } catch {
    return null;
  }
  return text.slice(0, token.offset) + CST.stringify(copy) + text.slice(token.offset + length);
}

function indentOf(text: string, offset: number): string {
  const start = lineStart(text, offset);
  return text.slice(start, offset).replace(/[^ ]/g, " ");
}

function appendPair(text: string, map: YAMLMap, key: string, value: unknown): string | null {
  const first = map.items[0] as { key: ParsedNode | null };
  const last = map.items[map.items.length - 1] as { key: ParsedNode | null; value: ParsedNode | null };
  if (!first.key?.range || !(last.value ?? last.key)?.range) return null;
  const indent = indentOf(text, first.key.range[0]);
  const end = lineEndAfter(text, (last.value ?? last.key)!.range![2]);
  const line = pairLines(key, value, indent);
  const prefix = end > 0 && text[end - 1] !== "\n" ? "\n" : "";
  return text.slice(0, end) + prefix + line + "\n" + text.slice(end);
}

function pairLines(key: string, value: unknown, indent: string): string {
  return stringify({ [key]: value }, { lineWidth: 0 })
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => indent + l)
    .join("\n");
}

/** The offset after the line containing `offset - 1`. */
function lineEndAfter(text: string, offset: number): number {
  if (offset > 0 && text[offset - 1] === "\n") return offset;
  const nl = text.indexOf("\n", offset);
  return nl < 0 ? text.length : nl + 1;
}

// ---------------------------------------------------------------- block sequences, item by item

interface Chunks {
  head: string;
  tail: string;
  /** Leading blank lines, kept with the position when items move. */
  blanks: string[];
  bodies: string[];
  indent: string;
}

const NOT_CONTENT = new Set(["comment", "space", "newline", "byte-order-mark"]);

function contentEnd(token: unknown): number {
  let end = -1;
  const walk = (t: unknown) => {
    if (!t || typeof t !== "object") return;
    if (Array.isArray(t)) return t.forEach(walk);
    const o = t as { type?: string; offset?: number; source?: string };
    if (o.type && typeof o.offset === "number" && typeof o.source === "string" && !NOT_CONTENT.has(o.type)) end = Math.max(end, o.offset + o.source.length);
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  };
  walk(token);
  return end;
}

/** The end of the lines of a block node: its last content line and the comment lines below it from column `col` on. */
function blockEnd(src: string, token: unknown, col: number): number {
  let end = lineEndAfter(src, contentEnd(token));
  for (;;) {
    const nl = src.indexOf("\n", end);
    const m = nl < 0 ? null : /^( *)#/.exec(src.slice(end, nl));
    if (!m || m[1].length < col) return end;
    end = nl + 1;
  }
}

function itemEnd(src: string, item: CST.BlockSequence["items"][number], ind: CST.SourceToken): number {
  const value = item.value as CST.SourceToken | undefined;
  const col = value && "offset" in value && lineStart(src, value.offset) > ind.offset ? value.offset - lineStart(src, value.offset) : ind.offset - lineStart(src, ind.offset) + 2;
  return blockEnd(src, value ?? ind, col);
}

/** A trailing comment-only CST item has no `-`. */
function dashItems(token: CST.BlockSequence): { item: CST.BlockSequence["items"][number]; ind: CST.SourceToken }[] {
  const out: { item: CST.BlockSequence["items"][number]; ind: CST.SourceToken }[] = [];
  for (const item of token.items) {
    const ind = item.start.find((t) => t.type === "seq-item-ind") as CST.SourceToken | undefined;
    if (ind) out.push({ item, ind });
  }
  return out;
}

/** Whole-line chunks, one per item. Comments between items go with the item below unless indented into the one above. */
function chunks(text: string, seq: YAMLSeq): Chunks | null {
  const token = seq.srcToken as CST.BlockSequence | undefined;
  if (!token || token.type !== "block-seq" || seq.flow) return null;
  const items = dashItems(token);
  if (!items.length || items.length !== seq.items.length) return null;
  const src = text.endsWith("\n") ? text : text + "\n";
  let indent = "";
  const bounds: [number, number][] = [];
  for (const { item, ind } of items) {
    const indLine = lineStart(src, ind.offset);
    if (!/^ *$/.test(src.slice(indLine, ind.offset))) return null; // `- - item`: not line-based
    if (!indent) indent = src.slice(indLine, ind.offset);
    const from = bounds.length ? bounds[bounds.length - 1][1] : commentsAbove(src, indLine, indent);
    if (from > indLine || !/^(?:[ \t]*(?:#[^\n]*)?\n)*$/.test(src.slice(from, indLine))) return null;
    bounds.push([from, itemEnd(src, item, ind)]);
  }
  const blanks: string[] = [];
  const bodies: string[] = [];
  for (const [from, to] of bounds) {
    const chunk = src.slice(from, to);
    const blank = /^(?:[ \t]*\n)*/.exec(chunk)![0];
    blanks.push(blank);
    bodies.push(chunk.slice(blank.length));
  }
  return { head: src.slice(0, bounds[0][0]), tail: src.slice(bounds[bounds.length - 1][1]), blanks, bodies, indent };
}

/** Insert lines for `value` into a block sequence that is not line-based (`- - item`). */
function insertLines(text: string, seq: YAMLSeq, at: number, value: unknown): string | null {
  const token = seq.srcToken as CST.BlockSequence | undefined;
  if (!token || token.type !== "block-seq") return null;
  const items = dashItems(token);
  if (!items.length || items.length !== seq.items.length) return null;
  const src = text.endsWith("\n") ? text : text + "\n";
  const first = items[0].ind.offset;
  const pad = " ".repeat(first - lineStart(src, first));
  let out: string;
  if (at === 0) {
    out = src.slice(0, first) + itemLines(value, pad).slice(pad.length) + pad + src.slice(first);
  } else {
    const prev = items[at - 1];
    const pos = itemEnd(src, prev.item, prev.ind);
    out = src.slice(0, pos) + itemLines(value, pad) + src.slice(pos);
  }
  return text.endsWith("\n") ? out : out.replace(/\n$/, "");
}

/** Move `from` up over the comment lines directly above it that are indented like the item. */
function commentsAbove(src: string, from: number, indent: string): number {
  while (from > 0) {
    const prev = lineStart(src, from - 1);
    const line = src.slice(prev, from - 1);
    if (!line.startsWith(indent + "#")) break;
    from = prev;
  }
  return from;
}

function join(c: Chunks, original: string, blanks: string[], bodies: string[]): string {
  const out = c.head + bodies.map((b, i) => blanks[i] + b).join("") + c.tail;
  return original.endsWith("\n") ? out : out.replace(/\n$/, "");
}

function itemLines(value: unknown, indent: string): string {
  const doc = new Document([value]);
  const body = doc.toString({ lineWidth: 0, minContentWidth: 0, indentSeq: true, flowCollectionPadding: false });
  return body
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => (l ? indent + l : l))
    .join("\n") + "\n";
}

function seqAt(doc: Document, path: YamlPath): YAMLSeq {
  const node = path.length ? doc.getIn(path, true) : doc.contents;
  if (!isSeq(node)) throw new YamlEditError(`no list at ${formatPath(path)}`);
  return node;
}

/** Most items after the first are separated by a blank line: new ones get one too. */
function typicalBlank(blanks: string[]): string {
  const rest = blanks.slice(1);
  if (!rest.length) return "";
  return rest.filter((b) => b).length * 2 > rest.length ? "\n" : "";
}

// ---------------------------------------------------------------- items as source slots (`- - item`, `[a, b]`)

/** Null when the items do not all start in one column. */
function slots(text: string, seq: YAMLSeq): [number, number][] | null {
  const out: [number, number][] = [];
  let column = -1;
  for (const item of seq.items as (ParsedNode | null)[]) {
    if (!item?.range) return null;
    const from = item.range[0];
    const to = from + text.slice(from, item.range[1]).replace(/\s+$/, "").length;
    const col = from - lineStart(text, from);
    if (!seq.flow) {
      if (column >= 0 && col !== column) return null;
      column = col;
    }
    out.push([from, to]);
  }
  return out;
}

function fillSlots(text: string, ranges: [number, number][], sources: string[]): string {
  let out = text;
  for (let i = ranges.length - 1; i >= 0; i--) out = out.slice(0, ranges[i][0]) + sources[i] + out.slice(ranges[i][1]);
  return out;
}

function flowText(value: unknown): string {
  const doc = new Document([value]);
  visit(doc, {
    Map(_, n) {
      n.flow = true;
    },
    Seq(_, n) {
      n.flow = true;
    },
  });
  return doc
    .toString({ lineWidth: 0, flowCollectionPadding: false })
    .trim()
    .replace(/^\[|\]$/g, "");
}

function flowInsert(text: string, seq: YAMLSeq, at: number, value: unknown): string | null {
  const items = seq.items as (ParsedNode | null)[];
  const item = flowText(value);
  if (at > 0) {
    const prev = items[at - 1]?.range;
    return prev ? text.slice(0, prev[1]) + ", " + item + text.slice(prev[1]) : null;
  }
  const first = items[0]?.range;
  return first ? text.slice(0, first[0]) + item + ", " + text.slice(first[0]) : null;
}

/** Null when that would remove a comment. */
function flowDelete(text: string, seq: YAMLSeq, index: number): string | null {
  const items = seq.items as (ParsedNode | null)[];
  const r = items[index]?.range;
  if (!r) return null;
  let from: number;
  let to: number;
  if (items.length === 1) {
    const sr = (seq as unknown as ParsedNode).range;
    if (!sr) return null;
    return text.slice(0, sr[0]) + "[]" + text.slice(sr[0] + text.slice(sr[0], sr[1]).replace(/\s+$/, "").length);
  } else if (index > 0) {
    from = items[index - 1]!.range![1];
    to = r[1];
  } else {
    from = r[0];
    to = items[1]!.range![0];
  }
  if (text.slice(from, to).includes("#")) return null;
  return text.slice(0, from) + text.slice(to);
}

function pairOf(map: unknown, node: unknown): { key: ParsedNode | null; value: ParsedNode | null } | null {
  if (!isMap(map)) return null;
  for (const pair of map.items) if (pair.value === node) return pair as { key: ParsedNode | null; value: ParsedNode | null };
  return null;
}

/** Needs a plain one-line key. */
function colonAfter(text: string, key: ParsedNode | null): number | null {
  if (!key?.range) return null;
  const colon = text.indexOf(":", key.range[1]);
  if (colon < 0 || text.slice(key.range[1], colon).trim() !== "") return null;
  return colon + 1;
}

/** The first item of an empty `key:` or `key: []`; a comment on the key line stays. */
function firstItemPatch(text: string, key: ParsedNode | null, emptyValue: ParsedNode | null, value: unknown): string | null {
  const colon = colonAfter(text, key);
  if (colon === null || !key?.range) return null;
  const lineEnd = lineEndAfter(text, colon);
  let keyLine = text.slice(colon, lineEnd);
  if (emptyValue?.range) {
    const [from, to] = emptyValue.range;
    if (to > lineEnd || !/^\[\s*\]$/.test(text.slice(from, to).trim())) return null;
    keyLine = text.slice(colon, from).replace(/[ \t]+$/, "") + text.slice(to, lineEnd);
  }
  if (!keyLine.endsWith("\n")) keyLine += "\n";
  const indent = indentOf(text, key.range[0]) + "  ";
  return text.slice(0, colon) + keyLine + itemLines(value, indent) + text.slice(lineEnd);
}

export function insertItem(text: string, seqPath: YamlPath, value: unknown, index?: number): string {
  const doc = parseForEdit(text, true);
  const semantic = parseForEdit(text, true).clone();
  const target = seqAt(semantic, seqPath);
  const at = Math.max(0, Math.min(index ?? target.items.length, target.items.length));
  target.items.splice(at, 0, semantic.createNode(value));

  let patched: string | null = null;
  const seq = seqAt(doc, seqPath);
  const c = chunks(text, seq);
  if (c) {
    const bodies = [...c.bodies];
    bodies.splice(at, 0, itemLines(value, c.indent));
    const blanks = [...c.blanks, typicalBlank(c.blanks)];
    patched = join(c, text, blanks, bodies);
  } else if (!seq.flow) {
    patched = insertLines(text, seq, at, value);
  } else if (seq.items.length === 0) {
    const parent = seqPath.length > 1 ? doc.getIn(seqPath.slice(0, -1), true) : doc.contents;
    const pair = isMap(parent) && !parent.flow ? pairOf(parent, seq) : null;
    if (pair) patched = firstItemPatch(text, pair.key, seq as unknown as ParsedNode, value);
  } else {
    patched = flowInsert(text, seq, at, value);
  }
  return finish(text, semantic, patched);
}

export function moveItem(text: string, seqPath: YamlPath, from: number, to: number): string {
  const doc = parseForEdit(text, true);
  const semantic = parseForEdit(text, true).clone();
  const target = seqAt(semantic, seqPath);
  const n = target.items.length;
  if (from < 0 || from >= n || to < 0 || to >= n) throw new YamlEditError(`no item ${from} or ${to} in ${formatPath(seqPath)}`);
  if (from === to) return text;
  const [item] = target.items.splice(from, 1);
  target.items.splice(to, 0, item);

  let patched: string | null = null;
  const seq = seqAt(doc, seqPath);
  const c = chunks(text, seq);
  if (c) {
    const bodies = [...c.bodies];
    const [body] = bodies.splice(from, 1);
    bodies.splice(to, 0, body);
    patched = join(c, text, c.blanks, bodies);
  } else {
    const ranges = slots(text, seq);
    if (ranges) {
      const sources = ranges.map(([a, b]) => text.slice(a, b));
      const [moved] = sources.splice(from, 1);
      sources.splice(to, 0, moved);
      patched = fillSlots(text, ranges, sources);
    }
  }
  return finish(text, semantic, patched);
}

export function deleteAt(text: string, path: YamlPath): string {
  if (!path.length) throw new YamlEditError("cannot delete the whole document");
  const doc = parseForEdit(text, true);
  const semantic = parseForEdit(text, true).clone();
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1];
  const parent = parentPath.length ? semantic.getIn(parentPath, true) : semantic.contents;
  if (isSeq(parent) && typeof last === "number") {
    if (last < 0 || last >= parent.items.length) throw new YamlEditError(`no item at ${formatPath(path)}`);
    parent.items.splice(last, 1);
  } else if (isMap(parent)) {
    if (!parent.has(last)) throw new YamlEditError(`no key at ${formatPath(path)}`);
    parent.delete(last);
  } else {
    throw new YamlEditError(`nothing to delete at ${formatPath(path)}`);
  }

  let patched: string | null = null;
  const docParent = parentPath.length ? doc.getIn(parentPath, true) : doc.contents;
  const removed = removedRange(text, docParent, last);
  if (isSeq(docParent) && typeof last === "number") {
    patched = deleteItemPatch(text, doc, parentPath, docParent, last);
  } else if (isMap(docParent) && !docParent.flow && docParent.items.length > 1) {
    patched = deletePair(text, docParent, String(last));
  } else if (isMap(docParent) && !docParent.flow && docParent.items.length === 1) {
    // The last key: the mapping becomes `{}`.
    const r = (docParent as unknown as ParsedNode).range;
    if (r) patched = text.slice(0, r[0]) + "{}" + text.slice(r[0] + text.slice(r[0], r[1]).replace(/\s+$/, "").length);
  }
  return finish(text, semantic, patched === null || !removed ? patched : { text: patched, removed });
}

/** What a delete removes on purpose: the item's lines and the comment lines directly above it. */
function removedRange(text: string, parent: unknown, last: PathPart): [number, number] | null {
  const src = text.endsWith("\n") ? text : text + "\n";
  let start: number | undefined;
  let end: number | undefined;
  if (isSeq(parent) && typeof last === "number") {
    const token = parent.srcToken as CST.BlockSequence | CST.FlowCollection | undefined;
    if (token?.type === "block-seq") {
      const it = dashItems(token)[last];
      if (it) {
        start = it.ind.offset;
        end = itemEnd(src, it.item, it.ind);
      }
    } else {
      const item = parent.items[last] as ParsedNode | null;
      const ind = token?.items?.[last]?.start.find((t) => t.type === "comma") as CST.SourceToken | undefined;
      start = ind?.offset ?? item?.range?.[0];
      end = item?.range ? lineEndAfter(src, item.range[2]) : undefined;
    }
  } else if (isMap(parent)) {
    const token = parent.srcToken as CST.BlockMap | undefined;
    const index = parent.items.findIndex((p) => keyOf(p.key) === String(last));
    const item = token?.type === "block-map" ? token.items[index] : undefined;
    const key = item?.key as CST.SourceToken | undefined;
    if (item && key && "offset" in key) {
      start = key.offset;
      end = blockEnd(src, [item.key, item.sep, item.value], start - lineStart(src, start) + 1);
    } else {
      const pair = parent.items[index] as { key: ParsedNode | null; value: ParsedNode | null } | undefined;
      start = pair?.key?.range?.[0];
      const r = (pair?.value ?? pair?.key)?.range;
      end = r ? lineEndAfter(src, r[2]) : undefined;
    }
  }
  if (start === undefined || end === undefined) return null;
  let from = lineStart(text, start);
  while (from > 0) {
    const prev = lineStart(text, from - 1);
    if (!/^[ \t]*#/.test(text.slice(prev, from - 1))) break;
    from = prev;
  }
  return [from, end];
}

function deleteItemPatch(text: string, doc: Document.Parsed, seqPath: YamlPath, seq: YAMLSeq, index: number): string | null {
  if (seq.flow) return flowDelete(text, seq, index);
  const c = chunks(text, seq);
  if (c && seq.items.length > 1) {
    const bodies = c.bodies.filter((_, i) => i !== index);
    const blanks = c.blanks.slice(0, bodies.length);
    return join(c, text, blanks, bodies);
  }
  if (c && seq.items.length === 1) {
    // The only item: `key:` and its item lines become `key: []`; comments above the item go with it.
    const parent = seqPath.length > 1 ? doc.getIn(seqPath.slice(0, -1), true) : doc.contents;
    const pair = isMap(parent) && !parent.flow ? pairOf(parent, seq) : null;
    const colon = pair ? colonAfter(text, pair.key) : null;
    if (colon === null) return null;
    const lineEnd = lineEndAfter(text, colon);
    const src = text.endsWith("\n") ? text : text + "\n";
    if (lineEnd > c.head.length) return null;
    const out = text.slice(0, colon) + " []" + src.slice(colon, lineEnd) + src.slice(lineEnd, c.head.length) + c.tail;
    return text.endsWith("\n") ? out : out.replace(/\n$/, "");
  }
  // `- - item` lines: the items after the deleted one move up a slot, and the last slot's line goes.
  const ranges = slots(text, seq);
  if (!ranges || ranges.length < 2) return null;
  const lastItem = seq.items[ranges.length - 1] as ParsedNode;
  const lastLine = lineStart(text, ranges[ranges.length - 1][0]);
  const indicator = text.slice(lastLine, ranges[ranges.length - 1][0]);
  if (!/^ *- +$/.test(indicator)) return null;
  const sources = ranges.map(([a, b]) => text.slice(a, b));
  sources.splice(index, 1);
  const kept = fillSlots(text.slice(0, lastLine), ranges.slice(0, -1), sources);
  const end = lineEndAfter(text, lastItem.range![2] > ranges[ranges.length - 1][1] ? ranges[ranges.length - 1][1] : lastItem.range![2]);
  if (text.slice(ranges[ranges.length - 1][1], end).includes("#")) return null;
  return kept + text.slice(end);
}

function deletePair(text: string, map: YAMLMap, key: string): string | null {
  const token = map.srcToken as CST.BlockMap | undefined;
  if (!token || token.type !== "block-map") return null;
  const index = map.items.findIndex((p) => isPair(p) && keyOf(p.key) === key);
  const item = token.items[index];
  const keyTok = item?.key as CST.SourceToken | undefined;
  if (!keyTok || !("offset" in keyTok)) return null;
  const src = text.endsWith("\n") ? text : text + "\n";
  const to = blockEnd(src, [item.key, item.sep, item.value], keyTok.offset - lineStart(src, keyTok.offset) + 1);
  const startTok = (item.start[0] ?? keyTok) as CST.SourceToken;
  const from = lineStart(text, startTok.offset);
  const before = text.slice(from, keyTok.offset);
  if (/^[ \t]*$/.test(before.replace(/#[^\n]*\n/g, "").replace(/\n/g, ""))) return text.slice(0, from) + src.slice(to);
  // The first key of a `- key: value` item: the next key moves up onto the `- ` line.
  const next = token.items[index + 1]?.key as CST.SourceToken | undefined;
  if (index !== 0 || !next || !("offset" in next) || !/^[ \t]*- +$/.test(before)) return null;
  if (!/^ *$/.test(src.slice(to, next.offset))) return null;
  return text.slice(0, keyTok.offset) + src.slice(next.offset);
}

// ---------------------------------------------------------------- CV structure

export const LAYOUTS = ["entries", "entries-inline", "list", "pairs", "dated", "text", "publications"] as const;
export type Layout = (typeof LAYOUTS)[number];

/** An entry with an empty title, for the user to type into. */
export function newEntry(layout: string): unknown {
  if (layout === "entries" || layout === "entries-inline") return { title: "" };
  if (layout === "pairs") return { title: "", text: "" };
  return "";
}

export function newSection(layout: Layout, title = "New Section", entry: unknown = newEntry(layout), bib = "publications.bib"): Record<string, unknown> {
  if (layout === "publications") return { title, layout, bib };
  return { title, layout, entries: [entry] };
}

/** The order of keys, so an added key lands where people write it. */
const KEY_ORDER = ["title", "layout", "description", "location", "date", "subtitle", "note", "details", "text", "bullets"];

/** Adds a missing key (any value) to the mapping at `path`'s parent, before the next key in KEY_ORDER. */
export function addKey(text: string, path: YamlPath, value: unknown): string {
  const doc = parseForEdit(text, true);
  const key = String(path[path.length - 1]);
  const parent = doc.getIn(path.slice(0, -1), true);
  if (!isMap(parent)) throw new YamlEditError(`no mapping at ${formatPath(path.slice(0, -1))}`);
  if (parent.has(key)) throw new YamlEditError(`${formatPath(path)} exists`);
  const semantic = parseForEdit(text, true).clone();
  semantic.setIn(path, value);
  let patched: string | null = null;
  if (!parent.flow && parent.items.length) {
    const rank = (k: unknown) => (KEY_ORDER.includes(String(k)) ? KEY_ORDER.indexOf(String(k)) : KEY_ORDER.length);
    const next = parent.items.findIndex((p) => rank(keyOf(p.key)) > rank(key));
    const before = next > 0 ? (parent.items[next].key as ParsedNode | null) : null;
    if (before?.range) {
      const at = text.lastIndexOf("\n", before.range[0] - 1) + 1;
      patched = text.slice(0, at) + pairLines(key, value, indentOf(text, before.range[0])) + "\n" + text.slice(at);
    } else {
      patched = appendPair(text, parent, key, value);
    }
  }
  return finish(text, semantic, patched);
}

/** Replaces a list item with another value (a plain item becoming a mapping). */
export function replaceItem(text: string, path: YamlPath, value: unknown): string {
  const index = path[path.length - 1];
  if (typeof index !== "number") throw new YamlEditError(`${formatPath(path)} is not a list item`);
  return insertItem(deleteAt(text, path), path.slice(0, -1), value, index);
}

export function addSection(text: string, section: unknown, index?: number): string {
  const doc = parseForEdit(text, true);
  if (!isSeq(doc.get("sections", true))) {
    const semantic = parseForEdit(text, true).clone();
    semantic.set("sections", semantic.createNode([section]));
    let patched: string | null = null;
    if (!doc.has("sections")) {
      const block = stringify({ sections: [section] }, { lineWidth: 0 });
      const sep = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
      patched = text + sep + block;
    } else if (isMap(doc.contents) && !doc.contents.flow && doc.get("sections") == null) {
      // `sections:` with no value yet.
      const pair = doc.contents.items.find((p) => keyOf(p.key) === "sections") as { key: ParsedNode | null; value: ParsedNode | null } | undefined;
      const value = pair?.value;
      if (pair && (!value || !value.range || value.range[0] === value.range[1])) patched = firstItemPatch(text, pair.key, null, section);
    }
    return finish(text, semantic, patched);
  }
  return insertItem(text, ["sections"], section, index);
}

/** An anchor inside the node at `path` that an alias outside it uses, or null. */
export function reusedAnchor(text: string, path: YamlPath): string | null {
  const doc = parseCached(text);
  const node = doc.getIn(path, true);
  if (!node || typeof node !== "object") return null;
  const inside = new Set<unknown>();
  const anchors = new Set<string>();
  const collect = (n: unknown) => {
    inside.add(n);
    const anchor = (n as { anchor?: string }).anchor;
    if (anchor) anchors.add(anchor);
  };
  collect(node);
  visit(node as Node, { Node: (_, n) => collect(n), Pair: (_, p) => void inside.add(p) });
  if (!anchors.size) return null;
  let found: string | null = null;
  visit(doc, {
    Alias(_, a) {
      if (!inside.has(a) && anchors.has(a.source)) {
        found = a.source;
        return visit.BREAK;
      }
    },
  });
  return found;
}

export function referencedBibs(text: string): string[] {
  const doc = parseCached(text);
  const sections = doc.get("sections", true);
  const out: string[] = [];
  if (!isSeq(sections)) return out;
  for (const s of sections.items) {
    if (!isMap(s)) continue;
    const bib = s.get("bib");
    if (typeof bib === "string" && bib && !out.includes(bib)) out.push(bib);
  }
  return out;
}

/** No `version`, and v1 top-level keys or typed sections. */
export function looksLikeV1(text: string): boolean {
  const doc = parseCached(text);
  if (!isMap(doc.contents)) return false;
  const v = doc.get("version");
  if (v === 1) return true;
  if (doc.has("version")) return false;
  if (doc.has("heading") || doc.has("subheading")) return true;
  const sections = doc.get("sections", true);
  return isSeq(sections) && sections.items.some((s) => isMap(s) && s.has("type"));
}
