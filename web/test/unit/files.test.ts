import { describe, expect, it } from "vitest";
import { droppedFiles, eolOf, writeBack } from "../../src/files";

/** A DataTransfer whose items, like the browser's, are readable only until the first await. */
function fakeDrop(files: File[], handles = true) {
  let open = true;
  const items = files.map((f) => ({
    kind: "file",
    getAsFile: () => (open ? f : null),
    getAsFileSystemHandle: handles
      ? () => (open ? Promise.resolve({ kind: "file", name: f.name, getFile: async () => f }) : Promise.resolve(null))
      : undefined,
  }));
  queueMicrotask(() => (open = false));
  return { items, files } as unknown as DataTransfer;
}

describe("dropping files", () => {
  it("opens every dropped file, with its handle, in any order", async () => {
    const yaml = new File(["version: 2\r\nname: Dropped\r\n"], "dropped.yaml");
    const bib = new File(["@misc{x, title={T}}\n"], "mine.bib");
    for (const order of [[yaml, bib], [bib, yaml]]) {
      const out = await droppedFiles(fakeDrop(order));
      expect(out.map((f) => f.name).sort()).toEqual(["dropped.yaml", "mine.bib"]);
      expect(out.every((f) => f.handle)).toBe(true);
    }
    const y = (await droppedFiles(fakeDrop([yaml])))[0];
    expect(y.eol).toBe("\r\n");
    expect(y.lastModified).toBe(yaml.lastModified);
  });
  it("skips other files and works without handles", async () => {
    const out = await droppedFiles(fakeDrop([new File(["x"], "photo.png"), new File(["a: 1\n"], "cv.yml")], false));
    expect(out.map((f) => f.name)).toEqual(["cv.yml"]);
    expect(out[0].handle).toBeUndefined();
  });
});

describe("writing back", () => {
  const handle = (opts: { lastModified?: number; permission?: PermissionState; fail?: boolean } = {}) => {
    const written: string[] = [];
    let modified = opts.lastModified ?? 1000;
    const h = {
      kind: "file",
      name: "cv.yaml",
      queryPermission: async () => opts.permission ?? "granted",
      requestPermission: async () => opts.permission ?? "granted",
      getFile: async () => ({ lastModified: modified }),
      createWritable: async () => ({
        write: async (t: string) => {
          if (opts.fail) throw new Error("disk full");
          written.push(t);
        },
        close: async () => {
          modified += 1;
        },
      }),
    };
    return { h: h as unknown as FileSystemFileHandle, written };
  };

  it("keeps Windows line ends", async () => {
    const { h, written } = handle();
    expect((await writeBack(h, "a: 1\nb: 2\n", { eol: "\r\n" })).ok).toBe(true);
    expect(written[0]).toBe("a: 1\r\nb: 2\r\n");
    expect(eolOf("a\r\nb\r\n")).toBe("\r\n");
    expect(eolOf("a\nb\n")).toBe("\n");
  });
  it("does not overwrite a file that changed on disk unless asked", async () => {
    const { h, written } = handle({ lastModified: 2000 });
    expect(await writeBack(h, "x", { expectLastModified: 1000 })).toMatchObject({ ok: false, reason: "changed", lastModified: 2000 });
    expect(written).toEqual([]);
    const r = await writeBack(h, "x", { expectLastModified: 1000, overwrite: true });
    expect(r).toMatchObject({ ok: true, lastModified: 2001 });
  });
  it("reports a refused permission and a failed write", async () => {
    expect(await writeBack(handle({ permission: "denied" }).h, "x")).toMatchObject({ ok: false, reason: "permission" });
    expect(await writeBack(handle({ fail: true }).h, "x")).toMatchObject({ ok: false, reason: "error", message: "disk full" });
    expect(await writeBack({ kind: "file" } as unknown as FileSystemFileHandle, "x")).toMatchObject({ ok: false, reason: "unsupported" });
  });
});
