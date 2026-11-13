// The YAML and .bib editor: CodeMirror 6 with one state per file.

import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, undo } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { lintKeymap, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { Compartment, EditorState, type Extension, Text } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLineGutter, keymap, layer, lineNumbers, RectangleMarker } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { Document } from "yaml";
import { schemaCompletion } from "./completion";
import type { Diagnostic } from "./py/protocol";
import { parseCached, pathAt, rangeOf, type YamlPath } from "./yamlDoc";

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "#fff", color: "#000" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "20px", overflow: "auto" },
  ".cm-content": { padding: "10px 0", caretColor: "#000" },
  ".cm-gutters": { backgroundColor: "#fff", color: "#595959", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "30px", padding: "0 14px 0 0" },
  ".cm-activeLineBg": { backgroundColor: "#f2f2f2" },
  ".cm-activeLineGutter": { backgroundColor: "#f2f2f2", color: "#000" },
  // One colour, focused or not, on every line (the base theme dims an unfocused selection).
  ".cm-selectionLayer .cm-selectionBackground": { backgroundColor: "#d6d6d6 !important" },
  "&.cm-focused": { outline: "2px solid #000", outlineOffset: "-2px" },
  ".cm-cursor": { borderLeftColor: "#000", borderLeftWidth: "1.5px" },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy #000",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
  },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline dotted #404040", textUnderlineOffset: "3px" },
  ".cm-tooltip": { border: "1px solid #000", backgroundColor: "#fff", fontFamily: "var(--ui)", fontSize: "12px" },
  ".cm-diagnostic": { padding: "6px 10px", borderLeft: "none", maxWidth: "520px", whiteSpace: "pre-wrap" },
  ".cm-diagnostic-error": { borderLeft: "3px solid #000" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid #737373" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "#000", color: "#fff" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)" },
  ".cm-completionInfo": { padding: "6px 10px", maxWidth: "320px" },
  ".cm-completionDetail": { color: "#6b6b6b", fontStyle: "normal", marginLeft: "8px" },
  ".cm-sync-line": { backgroundColor: "#e8e8e8" },
  ".cm-panels": { backgroundColor: "#fff", color: "#000" },
});

/** The active line in a layer under the selection: a line background would hide the selection on that line. */
const activeLine = layer({
  above: false,
  class: "cm-activeLineLayer",
  update: (u) => u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged,
  markers(view) {
    const scroller = view.scrollDOM.getBoundingClientRect();
    const content = view.contentDOM.getBoundingClientRect();
    const left = (content.left - scroller.left) / view.scaleX + view.scrollDOM.scrollLeft;
    const top = view.documentTop - scroller.top + view.scrollDOM.scrollTop * view.scaleY;
    const lines = new Set(view.state.selection.ranges.map((r) => view.lineBlockAt(r.head).from));
    return [...lines].map((from) => {
      const block = view.lineBlockAt(from);
      return new RectangleMarker("cm-activeLineBg", left, (top + block.top) / view.scaleY, content.width / view.scaleX, block.height);
    });
  },
});

const highlight = HighlightStyle.define([
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: "#000", fontWeight: "600" },
  // 6.5:1 on white and 5.9:1 on the active line.
  { tag: tags.comment, color: "#595959", fontStyle: "italic" },
  { tag: [tags.string, tags.content, tags.number, tags.bool, tags.null, tags.keyword, tags.atom], color: "#262626" },
  { tag: [tags.punctuation, tags.separator, tags.squareBracket, tags.brace, tags.meta, tags.labelName, tags.typeName], color: "#404040" },
]);

export interface EditorCallbacks {
  onChange(file: string, text: string): void;
  /** `path` is the YAML path in cv.yaml, null in other files. */
  onCursor(file: string, path: YamlPath | null, line: number, col: number): void;
}

/** The offset of a 1-based line and column, the column counted in code points. */
export function offsetOf(doc: Text, line: number | null, col: number | null): number {
  if (!line || line < 1) return 0;
  if (line > doc.lines) return doc.length;
  const l = doc.line(line);
  let units = 0;
  let points = 1;
  for (const ch of l.text) {
    if (points >= (col ?? 1)) break;
    units += ch.length;
    points++;
  }
  return l.from + units;
}

export function toCmDiagnostics(doc: Text, diags: Diagnostic[]): CmDiagnostic[] {
  return diags.map((d) => {
    const from = offsetOf(doc, d.line, d.col);
    const line = doc.lineAt(from);
    const rest = line.text.slice(from - line.from).replace(/\s+(#.*)?$/, "");
    const to = Math.max(from + Math.min(rest.length, 200), Math.min(from + 1, line.to));
    return { from, to, severity: d.severity, message: d.message, source: "cv-tools" };
  });
}

export class Editor {
  readonly view: EditorView;
  private states = new Map<string, EditorState>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private parsed: { text: string; doc: Document.Parsed } | null = null;
  private silent = false;
  private readOnly = new Compartment();
  private isReadOnly = false;
  current = "cv.yaml";
  schema: Record<string, unknown> | null = null;

  constructor(
    parent: HTMLElement,
    private callbacks: EditorCallbacks,
  ) {
    this.view = new EditorView({ parent, state: this.create("cv.yaml", "") });
  }

  private extensions(file: string): Extension[] {
    const isYaml = /\.ya?ml$/i.test(file);
    const exts: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      drawSelection(),
      activeLine,
      history(),
      indentUnit.of("  "),
      EditorState.tabSize.of(2),
      keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap, ...lintKeymap, indentWithTab]),
      theme,
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      this.readOnly.of(EditorState.readOnly.of(this.isReadOnly)),
      EditorView.contentAttributes.of({ "aria-label": `${file} editor`, "aria-describedby": "editor-help", tabindex: "0" }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !this.silent) this.callbacks.onChange(file, u.state.doc.toString());
        if (u.docChanged || u.selectionSet) this.reportCursor(file, u.state);
      }),
    ];
    if (isYaml) {
      exts.push(yaml(), autocompletion({ override: [schemaCompletion(() => this.schema)], icons: false }));
    }
    return exts;
  }

  private create(file: string, text: string): EditorState {
    return EditorState.create({ doc: text, extensions: this.extensions(file) });
  }

  private reportCursor(file: string, state: EditorState) {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    let path: YamlPath | null = null;
    if (/\.ya?ml$/i.test(file)) {
      const text = state.doc.toString();
      if (this.parsed?.text !== text) this.parsed = { text, doc: parseCached(text) };
      path = pathAt(this.parsed.doc, text, head);
    }
    this.callbacks.onCursor(file, path, line.number, head - line.from + 1);
  }

  /** Keeps the undo history of files whose text is unchanged. */
  setFiles(files: Record<string, string>, show: string) {
    for (const name of [...this.states.keys()]) if (!(name in files)) this.states.delete(name);
    for (const [name, text] of Object.entries(files)) {
      const state = this.states.get(name);
      if (!state || state.doc.toString() !== text) this.states.set(name, this.create(name, text));
    }
    this.current = "";
    this.show(show in files ? show : "cv.yaml");
  }

  has(file: string) {
    return this.states.has(file) || this.current === file;
  }

  text(file: string): string | undefined {
    if (file === this.current) return this.view.state.doc.toString();
    return this.states.get(file)?.doc.toString();
  }

  show(file: string) {
    if (this.current && this.current !== file) this.states.set(this.current, this.view.state);
    if (this.current === file) return;
    const state = this.states.get(file) ?? this.create(file, "");
    this.current = file;
    this.silent = true;
    this.view.setState(state);
    this.silent = false;
    this.applyDiagnostics(file);
    this.reportCursor(file, this.view.state);
  }

  /** One undoable change that touches only the differing middle. */
  setText(file: string, text: string) {
    if (file !== this.current) {
      const state = this.states.get(file);
      if (!state) {
        this.states.set(file, this.create(file, text));
        this.callbacks.onChange(file, text);
        return;
      }
      const tr = state.update(diffChange(state.doc.toString(), text));
      this.states.set(file, tr.state);
      this.callbacks.onChange(file, text);
      return;
    }
    const old = this.view.state.doc.toString();
    if (old === text) return;
    this.view.dispatch({ ...diffChange(old, text), userEvent: "input.cv-tools", scrollIntoView: false });
  }

  undo() {
    undo(this.view);
  }

  setReadOnly(on: boolean) {
    if (on === this.isReadOnly) return;
    this.isReadOnly = on;
    const effects = this.readOnly.reconfigure(EditorState.readOnly.of(on));
    for (const [name, state] of this.states) this.states.set(name, state.update({ effects }).state);
    this.view.dispatch({ effects });
  }

  setDiagnostics(byFile: Map<string, Diagnostic[]>) {
    this.diagnostics = byFile;
    this.applyDiagnostics(this.current);
  }

  private applyDiagnostics(file: string) {
    const diags = this.diagnostics.get(file) ?? [];
    this.view.dispatch(setDiagnostics(this.view.state, toCmDiagnostics(this.view.state.doc, diags)));
  }

  reveal(path: YamlPath, focus = false) {
    if (this.current !== "cv.yaml") this.show("cv.yaml");
    const text = this.view.state.doc.toString();
    if (this.parsed?.text !== text) this.parsed = { text, doc: parseCached(text) };
    const range = rangeOf(this.parsed.doc, path);
    if (!range) return;
    this.view.dispatch({
      selection: { anchor: range.valueFrom, head: range.valueTo },
      effects: EditorView.scrollIntoView(range.valueFrom, { y: "center" }),
    });
    if (focus) this.view.focus();
  }

}

/** A change that replaces only the part of `a` that differs from `b`. */
export function diffChange(a: string, b: string) {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { changes: { from: start, to: endA, insert: b.slice(start, endB) } };
}
