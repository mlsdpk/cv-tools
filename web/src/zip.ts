// A store-only zip writer with a fixed timestamp, so the same files give the same bytes.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 1980-01-01 00:00, the zip epoch. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function zip(files: Record<string, Uint8Array | string>): Uint8Array {
  const enc = new TextEncoder();
  const entries = Object.entries(files).map(([name, content]) => {
    const data = typeof content === "string" ? enc.encode(content) : content;
    return { name: enc.encode(name), data, crc: crc32(data), offset: 0 };
  });
  const localSize = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length, 0);
  const centralSize = entries.reduce((n, e) => n + 46 + e.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let p = 0;
  const u16 = (v: number) => {
    view.setUint16(p, v, true);
    p += 2;
  };
  const u32 = (v: number) => {
    view.setUint32(p, v, true);
    p += 4;
  };
  for (const e of entries) {
    e.offset = p;
    u32(0x04034b50);
    u16(20); // version needed
    u16(0x0800); // UTF-8 names
    u16(0); // stored
    u16(DOS_TIME);
    u16(DOS_DATE);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.name.length);
    u16(0);
    out.set(e.name, p);
    p += e.name.length;
    out.set(e.data, p);
    p += e.data.length;
  }
  const central = p;
  for (const e of entries) {
    u32(0x02014b50);
    u16(20); // version made by
    u16(20);
    u16(0x0800);
    u16(0);
    u16(DOS_TIME);
    u16(DOS_DATE);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.name.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(e.offset);
    out.set(e.name, p);
    p += e.name.length;
  }
  const centralLength = p - central;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(entries.length);
  u16(entries.length);
  u32(centralLength);
  u32(central);
  u16(0);
  return out;
}
