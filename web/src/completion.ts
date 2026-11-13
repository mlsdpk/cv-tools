// Key and value completion from the JSON Schema; an `if` on `layout` is decided by the data, so a section offers its layout's keys.

import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { isMap, isSeq, parseDocument } from "yaml";
import { pathAt, type YamlPath } from "./yamlDoc";

type Schema = Record<string, unknown> & {
  $ref?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  prefixItems?: Schema[];
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  if?: Schema;
  then?: Schema;
  else?: Schema;
  enum?: unknown[];
  const?: unknown;
  description?: string;
  type?: string | string[];
  required?: string[];
};

function resolveRef(root: Schema, ref: string): Schema | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    node = (node as Record<string, unknown> | undefined)?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node as Schema | undefined;
}

function typeOf(data: unknown): string {
  if (data === null) return "null";
  if (Array.isArray(data)) return "array";
  if (typeof data === "number") return Number.isInteger(data) ? "integer" : "number";
  return typeof data; // string, boolean, object
}

/** Undefined when a required key is missing (a mapping still being typed). */
function ifMatches(cond: Schema, data: unknown): boolean | undefined {
  if (cond.type !== undefined) {
    const types = Array.isArray(cond.type) ? cond.type : [cond.type];
    const t = typeOf(data);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return false;
  }
  if ("const" in cond && data !== cond.const) return false;
  if (cond.enum && !cond.enum.includes(data)) return false;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return !cond.required?.length && !cond.properties;
  const obj = data as Record<string, unknown>;
  for (const [key, sub] of Object.entries(cond.properties ?? {})) {
    if (key in obj && ifMatches(sub, obj[key]) === false) return false;
  }
  for (const key of cond.required ?? []) if (!(key in obj)) return undefined;
  return true;
}

/** The schemas that describe a node: every branch, with `if`/`then` decided by the data. */
export function expand(root: Schema, schema: Schema | undefined, data: unknown, depth = 0): Schema[] {
  if (!schema || depth > 20) return [];
  const out: Schema[] = [schema];
  if (schema.$ref) out.push(...expand(root, resolveRef(root, schema.$ref), data, depth + 1));
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    for (const sub of schema[key] ?? []) out.push(...expand(root, sub, data, depth + 1));
  }
  if (schema.if) {
    // Unknown data (a mapping being typed) takes both branches.
    const match = data === undefined ? undefined : ifMatches(schema.if, data);
    const branch = match === undefined ? [schema.then, schema.else] : [match ? schema.then : schema.else];
    for (const b of branch) if (b) out.push(...expand(root, b, data, depth + 1));
  }
  return out;
}

function childSchemas(root: Schema, schemas: Schema[], part: string | number, data: unknown): Schema[] {
  const out: Schema[] = [];
  for (const s of schemas) {
    if (typeof part === "number") {
      if (s.prefixItems?.[part]) out.push(...expand(root, s.prefixItems[part], data));
      else if (s.items) out.push(...expand(root, s.items, data));
    } else if (s.properties?.[part]) {
      out.push(...expand(root, s.properties[part], data));
    }
  }
  return out;
}

export function schemasAt(root: Schema, data: unknown, path: YamlPath): Schema[] {
  let schemas = expand(root, root, data);
  let node: unknown = data;
  for (const part of path) {
    node = node && typeof node === "object" ? (node as Record<string | number, unknown>)[part] : undefined;
    schemas = childSchemas(root, schemas, part, node);
    if (!schemas.length) break;
  }
  return schemas;
}

export interface KeyInfo {
  key: string;
  description?: string;
  required: boolean;
}

export function keysAt(root: Schema, data: unknown, path: YamlPath): KeyInfo[] {
  const seen = new Map<string, KeyInfo>();
  const required = new Set<string>();
  for (const s of schemasAt(root, data, path)) {
    for (const r of s.required ?? []) required.add(r);
    for (const [key, sub] of Object.entries(s.properties ?? {})) {
      const desc = sub.description ?? (sub.$ref ? resolveRef(root, sub.$ref)?.description : undefined);
      const prev = seen.get(key);
      if (!prev) seen.set(key, { key, description: desc, required: false });
      else if (!prev.description && desc) prev.description = desc;
    }
  }
  return [...seen.values()].map((k) => ({ ...k, required: required.has(k.key) }));
}

/** The literal values (`enum`, `const`) allowed at `path`. */
export function valuesAt(root: Schema, data: unknown, path: YamlPath): unknown[] {
  const out: unknown[] = [];
  for (const s of schemasAt(root, data, path)) {
    for (const v of s.enum ?? []) if (!out.includes(v)) out.push(v);
    if ("const" in s && !out.includes(s.const)) out.push(s.const);
  }
  return out;
}

const MARK = "cvtoolscompletionmark";

export function schemaCompletion(getSchema: () => Schema | null) {
  return (context: CompletionContext): CompletionResult | null => {
    const schema = getSchema();
    if (!schema) return null;
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const text = context.state.doc.toString();

    // A key: `  par|` or `  - par|`
    const keyMatch = /^(\s*)(?:-\s+)*([A-Za-z_-]*)$/.exec(before);
    if (keyMatch) {
      const word = keyMatch[2];
      if (!word && !context.explicit) return null;
      const from = context.pos - word.length;
      const after = line.text.slice(context.pos - line.from);
      const restOfWord = /^[A-Za-z_-]*/.exec(after)![0];
      const probe = text.slice(0, from) + MARK + ": 0" + text.slice(context.pos + restOfWord.length);
      const doc = parseDocument(probe);
      if (doc.errors.length) return null;
      const path = pathAt(doc as never, probe, from);
      if (path[path.length - 1] !== MARK) return null;
      const parent = path.slice(0, -1);
      const data = doc.toJS();
      const node = parent.reduce<unknown>((n, p) => (n && typeof n === "object" ? (n as never)[p] : undefined), data);
      const present = new Set(node && typeof node === "object" ? Object.keys(node) : []);
      const options: Completion[] = keysAt(schema, data, parent)
        .filter((k) => !present.has(k.key) || k.key === MARK)
        .filter((k) => k.key !== MARK)
        .map((k, i) => ({
          label: k.key,
          apply: k.key + ": ",
          type: "property",
          detail: k.required ? "required" : undefined,
          info: k.description,
          boost: k.required ? 10 - i / 100 : -i / 100,
        }));
      return options.length ? { from, options, validFor: /^[A-Za-z_-]*$/ } : null;
    }

    // A value with a fixed set of choices: `    layout: ent|`
    const valueMatch = /^(\s*)(?:-\s+)*([A-Za-z_-]+):\s*([A-Za-z0-9_-]*)$/.exec(before);
    if (valueMatch) {
      const word = valueMatch[3];
      const from = context.pos - word.length;
      const doc = parseDocument(text);
      if (doc.errors.length && !isMap(doc.contents) && !isSeq(doc.contents)) return null;
      const keyOffset = line.from + before.lastIndexOf(valueMatch[2] + ":");
      const path = pathAt(doc as never, text, keyOffset);
      if (path[path.length - 1] !== valueMatch[2]) return null;
      const values = valuesAt(schema, doc.toJS(), path).filter((v): v is string | number => typeof v === "string" || typeof v === "number");
      if (!values.length) return null;
      return { from, options: values.map((v) => ({ label: String(v), type: "enum" })), validFor: /^[A-Za-z0-9_-]*$/ };
    }
    return null;
  };
}
