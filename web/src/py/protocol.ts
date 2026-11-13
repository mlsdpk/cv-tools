// Messages between the main thread and the py worker.

export interface Diagnostic {
  /** "cv.yaml", a .bib file name, or null for an error without a file. */
  file: string | null;
  line: number | null;
  col: number | null;
  message: string;
  severity: "error" | "warning";
}

export interface PyResult {
  ok: boolean;
  diagnostics?: Diagnostic[];
  warnings?: string[];
  /** The bridge caught an exception that is not a cv-tools error. */
  internal?: boolean;
  traceback?: string;
}

export interface ValidateResult extends PyResult {
  format?: "v1" | "v2";
  bibs?: string[];
}

export interface TexResult extends PyResult {
  tex?: string;
  /** Support files (resume.cls, orcid.pdf), base64. */
  files?: Record<string, string>;
}

export interface HtmlResult extends PyResult {
  unavailable?: boolean;
  html?: string;
  css?: string | null;
}

export interface MigrateResult extends PyResult {
  text?: string;
}

export interface SchemaResult extends PyResult {
  schema?: unknown;
}

export interface VersionResult extends PyResult {
  cvTools?: string;
  python?: string;
}

export type Files = Record<string, string>;

export interface PyApi {
  validate(text: string, files: Files): ValidateResult;
  renderTex(text: string, files: Files): TexResult;
  renderHtml(text: string, files: Files): HtmlResult;
  migrate(text: string): MigrateResult;
  schema(): SchemaResult;
  version(): VersionResult;
}

export type Request =
  | { id: number; type: "init"; root: string; totalBytes?: number }
  | { id: number; type: "call"; method: keyof PyApi; args: unknown[] };

export type Response =
  | { id: number; type: "result"; value: unknown }
  | { id: number; type: "error"; message: string }
  | { type: "progress"; stage: string; done: number; total: number };
