import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeFiles, encodeFiles, LONG_LINK, MAX_SHARED_BYTES, readFragment, safeName, shareLink, ShareLinkError } from "../../src/share";

const files = {
  "cv.yaml": readFileSync(new URL("../../../examples/cv.yaml", import.meta.url), "utf8"),
  "publications.bib": readFileSync(new URL("../../../examples/publications.bib", import.meta.url), "utf8"),
};

describe("share links", () => {
  it("round-trips the workspace through the URL fragment", async () => {
    const link = await shareLink("https://example.org/cv-tools/?x=1#old", files);
    const url = new URL(link);
    expect(url.search).toBe("?x=1");
    expect(url.hash.startsWith("#cv=")).toBe(true);
    expect(url.hash).toMatch(/^#cv=[A-Za-z0-9_-]+$/);
    expect(await readFragment(url.hash)).toEqual(files);
  });
  it("keeps the example short enough for chat apps", async () => {
    const link = await shareLink("https://example.org/", files);
    expect(link.length).toBeLessThan(LONG_LINK);
  });
  it("round-trips non-ASCII text and empty files", async () => {
    const f = { "cv.yaml": "name: Zoë 😀 Ωμέγα\n", "a.bib": "" };
    expect(await decodeFiles(await encodeFiles(f))).toEqual(f);
  });
  it("ignores other fragments and rejects damaged links", async () => {
    expect(await readFragment("")).toBeNull();
    expect(await readFragment("#section")).toBeNull();
    await expect(readFragment("#cv=AAAA")).rejects.toThrow();
    await expect(decodeFiles(await encodeFiles({ "x.yaml": "a" }))).rejects.toThrow(/no cv.yaml/);
  });
  it("keeps .bib files in subdirectories and drops unsafe names", async () => {
    const out = await decodeFiles(
      await encodeFiles({ "cv.yaml": "a", "refs/pubs.bib": "p", "../evil.bib": "x", "/abs.bib": "x", "a\\b.bib": "x", "a//b.bib": "x", "ok.bib": "y" }),
    );
    expect(Object.keys(out).sort()).toEqual(["cv.yaml", "ok.bib", "refs/pubs.bib"]);
    expect(safeName("refs/2024/pubs.bib")).toBe(true);
    for (const bad of ["", ".", "a/../b", "./a", "a\u0000b", "/x"]) expect(safeName(bad), bad).toBe(false);
  });
  it("refuses a link that inflates past the size limit", async () => {
    // 3 MB of one character compresses to a few kB.
    const bomb = await encodeFiles({ "cv.yaml": "x".repeat(3 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(20_000);
    await expect(decodeFiles(bomb)).rejects.toThrow(ShareLinkError);
    await expect(decodeFiles(bomb)).rejects.toThrow(/larger than 2 MB/);
    expect(Object.keys(await decodeFiles(await encodeFiles({ "cv.yaml": "x".repeat(MAX_SHARED_BYTES - 1000) })))).toEqual(["cv.yaml"]);
  });
});
