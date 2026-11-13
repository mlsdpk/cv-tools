export function woff2(font: Uint8Array): Buffer;
export function sfntTables(font: Uint8Array): { flavor: number; tables: { tag: string; data: Buffer }[] };
