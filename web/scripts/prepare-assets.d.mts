export function readZip(buf: Buffer): Record<string, Buffer>;
export function writeLicenses(out: string): Promise<{ component: string; license: string; file: string; group: string }[]>;
export function writePreviewFonts(out: string): Promise<void>;
