import { describe, expect, it } from "vitest";
import { startErrorMessage } from "../../src/startError";

describe("startErrorMessage", () => {
  it("asks to update the browser when WebAssembly fails", () => {
    for (const m of [
      "Out of bounds memory access (evaluating '_PyRun_SimpleString(r)')",
      "RuntimeError: unreachable executed",
      "WebAssembly.instantiate(): Wasm code generation disallowed",
    ]) {
      expect(startErrorMessage(new Error(m))).toMatch(/update your browser/);
    }
  });

  it("keeps other errors as they are", () => {
    expect(startErrorMessage(new Error("Failed to fetch"))).toBe("cv-tools could not start: Failed to fetch");
    expect(startErrorMessage("offline")).toBe("cv-tools could not start: offline");
  });
});
