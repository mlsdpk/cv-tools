const ENGINE_FAILURE = /out of bounds memory access|unreachable|webassembly|wasm|compileerror|runtimeerror/i;

export function startErrorMessage(e: unknown): string {
  const detail = e instanceof Error ? e.message : String(e);
  if (ENGINE_FAILURE.test(detail)) {
    return "cv-tools could not start in this browser. Please update your browser, or use Chrome or Firefox.";
  }
  return `cv-tools could not start: ${detail}`;
}
