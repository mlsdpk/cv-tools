// Share links: the files deflated into the URL fragment (#cv=...), which browsers never send to a server.

export type Files = Record<string, string>;

const PREFIX = "cv=";
/** Links longer than this may be cut by chat apps and mail clients. */
export const LONG_LINK = 8000;
/** A CV with its .bib files is far smaller. */
export const MAX_SHARED_BYTES = 2 * 1024 * 1024;

export class ShareLinkError extends Error {}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pump(data: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new ShareLinkError(`the shared CV is larger than ${Math.round(limit / 1024 / 1024)} MB when unpacked, so it was not opened`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A relative path (`refs/pubs.bib`), never absolute, with `..`, a backslash or a control character. */
export function safeName(name: string): boolean {
  if (!name || name.length > 255 || name.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(name)) return false;
  return name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export async function encodeFiles(files: Files): Promise<string> {
  const json = JSON.stringify({ v: 1, files });
  return toBase64Url(await pump(new TextEncoder().encode(json), new CompressionStream("deflate-raw")));
}

export async function decodeFiles(data: string, limit = MAX_SHARED_BYTES): Promise<Files> {
  let bytes: Uint8Array;
  try {
    bytes = await pump(fromBase64Url(data), new DecompressionStream("deflate-raw"), limit);
  } catch (e) {
    if (e instanceof ShareLinkError) throw e;
    throw new ShareLinkError("the link is damaged or cut off");
  }
  let parsed: { v?: number; files?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ShareLinkError("the link is damaged or cut off");
  }
  if (!parsed || parsed.v !== 1 || !parsed.files || typeof parsed.files !== "object") throw new ShareLinkError("it is not a cv-tools share link");
  const files: Files = {};
  for (const [name, text] of Object.entries(parsed.files as Record<string, unknown>)) {
    if (typeof text === "string" && safeName(name)) files[name] = text;
  }
  if (typeof files["cv.yaml"] !== "string") throw new ShareLinkError("the share link holds no cv.yaml");
  return files;
}

export async function shareLink(base: string, files: Files): Promise<string> {
  const url = new URL(base);
  url.hash = PREFIX + (await encodeFiles(files));
  return url.href;
}

/** Null when the fragment is not a share link. */
export async function readFragment(hash: string): Promise<Files | null> {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!h.startsWith(PREFIX)) return null;
  return decodeFiles(h.slice(PREFIX.length));
}
