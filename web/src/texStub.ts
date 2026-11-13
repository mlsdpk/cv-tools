// A stand-in for src/tex/client.ts (CV_TEX_STUB=1): a placeholder PDF naming the files it received.

export interface CompileResult {
  pdf: Uint8Array;
  log: string;
  ms: number;
}

export interface CompileOptions {
  sourceDateEpoch?: number;
}

export type EngineProgress = { loaded: number; total: number; phase?: string };

export const isStub = true;

export function configure(_options: { baseUrl?: string }): void {}

export async function init(onProgress?: (p: EngineProgress) => void): Promise<void> {
  onProgress?.({ loaded: 1, total: 1, phase: "stub engine" });
}

function pdfString(s: string): string {
  return "(" + s.replace(/[\\()]/g, (c) => "\\" + c).replace(/[^\x20-\x7e]/g, "?") + ")";
}

/** A valid one-page US Letter PDF showing `lines` in Helvetica. */
export function placeholderPdf(lines: string[]): Uint8Array {
  const text = lines.map((l, i) => `BT /F1 ${i === 0 ? 16 : 11} Tf 72 ${700 - i * 22} Td ${pdfString(l)} Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

export async function compile(files: Record<string, Uint8Array>, options: CompileOptions = {}): Promise<CompileResult> {
  const start = performance.now();
  const tex = files["cv.tex"] ? new TextDecoder().decode(files["cv.tex"]) : "";
  const name = /\\name\{([^}]*)\}/.exec(tex)?.[1] ?? "";
  const pdf = placeholderPdf([
    "PDF engine not built yet (stub)",
    `cv.tex: ${tex.length} characters${name ? `, name ${name}` : ""}`,
    `files: ${Object.keys(files).sort().join(", ")}`,
    options.sourceDateEpoch !== undefined ? `SOURCE_DATE_EPOCH ${options.sourceDateEpoch}` : "",
  ]);
  return { pdf, log: "stub engine: no TeX run\n", ms: performance.now() - start };
}
