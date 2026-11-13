// The Latin Modern Math face: its range matches cv_tools' FONT_RANGES and its WOFF2 is well formed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { writePreviewFonts } from "../../scripts/prepare-assets.mjs";
import { sfntTables } from "../../scripts/woff2.mjs";

const REPO = resolve(process.cwd(), "..");
const python = process.env.CV_TOOLS_PYTHON ?? resolve(REPO, ".venv/bin/python");
const css = readFileSync(resolve(process.cwd(), "src/fonts.css"), "utf8");

describe("Latin Modern Math", () => {
  it.skipIf(!existsSync(python) && !process.env.CV_TOOLS_PYTHON)("covers exactly FONT_RANGES", () => {
    const r = spawnSync(python, ["-c", "from cv_tools.render.html import FONT_RANGES; print(FONT_RANGES['latinmodern-math'])"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const rules = [...css.matchAll(/font-family: "Latin Modern Math";[^}]*unicode-range: ([^;]+);/g)].map((m) => m[1]);
    expect(rules).toHaveLength(2);
    for (const range of rules) expect(range).toBe(r.stdout.trim());
  });

  it("is written as a well-formed WOFF2 that holds the whole pinned font", async () => {
    const out = mkdtempSync(join(tmpdir(), "cv-fonts-"));
    await writePreviewFonts(out);
    const w = readFileSync(join(out, "fonts", "latinmodern-math.woff2"));
    expect(w.toString("latin1", 0, 4)).toBe("wOF2");
    expect(w.readUInt32BE(8)).toBe(w.length);
    const numTables = w.readUInt16BE(12);
    // Read the directory back and decompress the tables.
    let p = 48;
    const lengths: [string, number][] = [];
    for (let i = 0; i < numTables; i++) {
      expect(w[p++]).toBe(63);
      const tag = w.toString("latin1", p, p + 4);
      p += 4;
      let n = 0;
      for (;;) {
        const b = w[p++];
        n = n * 128 + (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      lengths.push([tag, n]);
    }
    const data = brotliDecompressSync(w.subarray(p, p + w.readUInt32BE(20)));
    const { tables } = sfntTables(rebuild(lengths, data));
    expect(tables.map((t) => t.tag)).toContain("MATH");
    expect(tables.map((t) => t.tag)).toContain("CFF ");
    expect(data.length).toBe(lengths.reduce((s, [, n]) => s + n, 0));
  });
});

/** An sfnt from the WOFF2 directory and table stream (enough for sfntTables). */
function rebuild(lengths: [string, number][], data: Buffer): Buffer {
  const head = Buffer.alloc(12 + 16 * lengths.length);
  head.writeUInt16BE(lengths.length, 4);
  let offset = head.length;
  let at = 0;
  const bodies: Buffer[] = [];
  lengths.forEach(([tag, n], i) => {
    head.write(tag, 12 + 16 * i, "latin1");
    head.writeUInt32BE(offset, 12 + 16 * i + 8);
    head.writeUInt32BE(n, 12 + 16 * i + 12);
    bodies.push(data.subarray(at, at + n));
    offset += n;
    at += n;
  });
  return Buffer.concat([head, ...bodies]);
}
