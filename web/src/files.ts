// Opening files and writing them back (File System Access API where available, else picker and download).

export interface OpenedFile {
  name: string;
  text: string;
  handle?: FileSystemFileHandle;
  /** To notice a change on disk before writing back. */
  lastModified?: number;
  eol: "\n" | "\r\n";
}

/** The line end a text uses: CRLF when most of its line ends are CRLF. */
export function eolOf(text: string): "\n" | "\r\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  return crlf > 0 && crlf * 2 >= lf ? "\r\n" : "\n";
}

type PickerWindow = Window & {
  showOpenFilePicker?: (options: unknown) => Promise<FileSystemFileHandle[]>;
};

const ACCEPT = { "text/yaml": [".yaml", ".yml"], "text/x-bibtex": [".bib"] };

export function isCvFile(name: string): boolean {
  return /\.(ya?ml|bib)$/i.test(name);
}

async function readFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, "");
  } catch {
    throw new Error(`${file.name} is not valid UTF-8 text`);
  }
}

export async function pickFiles(input: HTMLInputElement): Promise<OpenedFile[]> {
  const w = window as PickerWindow;
  if (typeof w.showOpenFilePicker === "function") {
    let handles: FileSystemFileHandle[];
    try {
      handles = await w.showOpenFilePicker({ multiple: true, types: [{ description: "CV files", accept: ACCEPT }] });
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return [];
      throw e;
    }
    return Promise.all(handles.map(async (handle) => opened(await handle.getFile(), handle)));
  }
  return new Promise((resolve, reject) => {
    input.value = "";
    input.onchange = () => {
      readFiles([...(input.files ?? [])]).then(resolve, reject);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

async function opened(file: File, handle?: FileSystemFileHandle): Promise<OpenedFile> {
  const text = await readFile(file);
  return { name: file.name, text, handle, lastModified: file.lastModified, eol: eolOf(text) };
}

export async function readFiles(files: File[]): Promise<OpenedFile[]> {
  const out: OpenedFile[] = [];
  for (const f of files) if (isCvFile(f.name)) out.push(await opened(f));
  return out;
}

/** A DataTransfer is only readable during the drop event: everything is requested before the first await. */
export async function droppedFiles(dt: DataTransfer): Promise<OpenedFile[]> {
  const items = [...dt.items].filter((i) => i.kind === "file");
  const requests = items.map((item) => {
    const file = item.getAsFile();
    const getHandle = (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle;
    let handle: Promise<FileSystemHandle | null> = Promise.resolve(null);
    if (file && isCvFile(file.name) && getHandle) {
      try {
        handle = Promise.resolve(getHandle.call(item)).catch(() => null);
      } catch {
        // no handle: the file is still read
      }
    }
    return { file, handle };
  });
  if (!items.length) requests.push(...[...dt.files].map((file) => ({ file, handle: Promise.resolve(null) })));
  const out: OpenedFile[] = [];
  for (const { file, handle } of requests) {
    if (!file || !isCvFile(file.name)) continue;
    const h = await handle;
    out.push(await opened(file, h && h.kind === "file" ? (h as FileSystemFileHandle) : undefined));
  }
  return out;
}

export type WriteBack =
  | { ok: true; lastModified?: number }
  | { ok: false; reason: "unsupported" | "permission" | "changed" | "error"; message?: string; lastModified?: number };

/** With `expectLastModified`, a file changed on disk is not overwritten (reason "changed") unless `overwrite`. */
export async function writeBack(
  handle: FileSystemFileHandle,
  text: string,
  options: { eol?: "\n" | "\r\n"; expectLastModified?: number; overwrite?: boolean } = {},
): Promise<WriteBack> {
  const h = handle as FileSystemFileHandle & {
    queryPermission?: (d: unknown) => Promise<PermissionState>;
    requestPermission?: (d: unknown) => Promise<PermissionState>;
    createWritable?: () => Promise<FileSystemWritableFileStream>;
  };
  if (!h.createWritable) return { ok: false, reason: "unsupported" };
  try {
    const mode = { mode: "readwrite" };
    if (h.queryPermission && (await h.queryPermission(mode)) !== "granted") {
      if (!h.requestPermission || (await h.requestPermission(mode)) !== "granted") return { ok: false, reason: "permission" };
    }
    if (options.expectLastModified !== undefined && !options.overwrite) {
      const now = (await h.getFile()).lastModified;
      if (now !== options.expectLastModified) return { ok: false, reason: "changed", lastModified: now };
    }
    const body = options.eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text;
    const w = await h.createWritable();
    await w.write(body);
    await w.close();
    let lastModified: number | undefined;
    try {
      lastModified = (await h.getFile()).lastModified;
    } catch {
      lastModified = undefined;
    }
    return { ok: true, lastModified };
  } catch (e) {
    return { ok: false, reason: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

export function download(name: string, data: Uint8Array | string, type: string) {
  const blob = new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
