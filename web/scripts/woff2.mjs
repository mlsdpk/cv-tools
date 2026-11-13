// Deterministic WOFF2 encoder for CFF fonts (null transforms only), so content hashes stay stable.
import { brotliCompressSync, constants } from "node:zlib";

function base128(n) {
  const out = [];
  do {
    out.unshift(n & 0x7f);
    n = Math.floor(n / 128);
  } while (n > 0);
  for (let i = 0; i < out.length - 1; i++) out[i] |= 0x80;
  return out;
}

export function sfntTables(font) {
  const buf = Buffer.from(font);
  const flavor = buf.readUInt32BE(0);
  const n = buf.readUInt16BE(4);
  const tables = [];
  for (let i = 0; i < n; i++) {
    const p = 12 + 16 * i;
    const tag = buf.toString("latin1", p, p + 4);
    const offset = buf.readUInt32BE(p + 8);
    const length = buf.readUInt32BE(p + 12);
    tables.push({ tag, data: buf.subarray(offset, offset + length) });
  }
  return { flavor, tables };
}

export function woff2(font) {
  const { flavor, tables } = sfntTables(font);
  if (tables.some((t) => t.tag === "glyf" || t.tag === "loca")) throw new Error("woff2.mjs encodes CFF fonts only (this font has glyf/loca)");
  const dir = [];
  for (const t of tables) dir.push(63, ...Buffer.from(t.tag, "latin1"), ...base128(t.data.length)); // 63: tag follows, transform 0 (null)
  const stream = Buffer.concat(tables.map((t) => t.data));
  const compressed = brotliCompressSync(stream, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_FONT, [constants.BROTLI_PARAM_SIZE_HINT]: stream.length },
  });
  const totalSfntSize = 12 + 16 * tables.length + tables.reduce((s, t) => s + ((t.data.length + 3) & ~3), 0);
  const headerLength = 48;
  const body = Buffer.concat([Buffer.from(dir), compressed]);
  const length = (headerLength + body.length + 3) & ~3;
  const out = Buffer.alloc(length);
  out.write("wOF2", 0, "latin1");
  out.writeUInt32BE(flavor, 4);
  out.writeUInt32BE(length, 8);
  out.writeUInt16BE(tables.length, 12);
  out.writeUInt16BE(0, 14);
  out.writeUInt32BE(totalSfntSize, 16);
  out.writeUInt32BE(compressed.length, 20);
  out.writeUInt16BE(1, 24); // major version
  out.writeUInt16BE(0, 26);
  body.copy(out, headerLength);
  return out;
}
