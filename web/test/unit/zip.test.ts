import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readZip } from "../../scripts/prepare-assets.mjs";
import { crc32, zip } from "../../src/zip";

describe("zip", () => {
  it("computes CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
  it("writes archives that zip readers accept", () => {
    const bin = new Uint8Array([0, 1, 2, 255, 254]);
    const z = zip({ "cv.tex": "\\documentclass{resume}\n", "orcid.pdf": bin, "dir/é.txt": "ü" });
    const files = readZip(Buffer.from(z));
    expect(Object.keys(files)).toEqual(["cv.tex", "orcid.pdf", "dir/é.txt"]);
    expect(files["cv.tex"].toString()).toBe("\\documentclass{resume}\n");
    expect([...files["orcid.pdf"]]).toEqual([...bin]);
    expect(files["dir/é.txt"].toString()).toBe("ü");
    const dir = mkdtempSync(join(tmpdir(), "zip-"));
    writeFileSync(join(dir, "a.zip"), z);
    let unzip = "";
    try {
      unzip = execFileSync("unzip", ["-t", join(dir, "a.zip")], { encoding: "utf8" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return; // no unzip on this machine
    }
    expect(unzip).toMatch(/No errors detected/);
  });
  it("is deterministic", () => {
    expect(zip({ a: "x" })).toEqual(zip({ a: "x" }));
    expect(readFileSync).toBeTypeOf("function");
  });
  it("writes an empty archive", () => {
    expect(zip({}).length).toBe(22);
  });
});
