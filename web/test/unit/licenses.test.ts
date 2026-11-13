import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as assets from "../../scripts/prepare-assets.mjs";

interface Notice {
  component: string;
  license: string;
  file: string;
  group: "cv-tools" | "python" | "fonts";
}

// Pinned downloads are cached under web/.cache, so only the first run needs the network.
const { writeLicenses } = assets as unknown as { writeLicenses: (out: string) => Promise<Notice[]> };

const repo = resolve(__dirname, "..", "..", "..");
const lock = JSON.parse(readFileSync(resolve(__dirname, "..", "..", "node_modules", "pyodide", "pyodide-lock.json"), "utf8"));

describe("licence notices", () => {
  let out: string;
  let notices: Notice[];
  const find = (re: RegExp) => notices.find((n) => re.test(n.component));
  const text = (n: Notice | undefined) => readFileSync(join(out, n!.file), "utf8");

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "cv-licenses-"));
    notices = await writeLicenses(out);
  }, 120000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("writes a non-empty file for every notice", () => {
    expect(notices.length).toBeGreaterThan(10);
    for (const n of notices) {
      expect(n.file).toMatch(/^licenses\//);
      expect(["cv-tools", "python", "fonts"]).toContain(n.group);
      expect(n.license).toMatch(/\S/);
      expect(statSync(join(out, n.file)).size, n.file).toBeGreaterThan(0);
    }
  });

  it("ships cv-tools' own MIT licence", () => {
    const n = find(/^cv-tools$/);
    expect(n).toMatchObject({ license: "MIT", file: "licenses/cv-tools.txt", group: "cv-tools" });
    expect(text(n)).toBe(readFileSync(join(repo, "LICENSE"), "utf8"));
  });

  it("ships the PSF licence of the CPython in Pyodide's lock", () => {
    const n = find(new RegExp(`^CPython ${lock.info.python.replace(/\./g, "\\.")}$`));
    expect(n).toMatchObject({ license: "PSF-2.0", group: "python" });
    expect(text(n)).toContain("PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2");
  });

  it("ships the notices of the C libraries linked into Pyodide's core", () => {
    const expected: [RegExp, string, string][] = [
      [/^Pyodide /, "MPL-2.0", "Mozilla Public License Version 2.0"],
      [/^zlib /, "Zlib", "Jean-loup Gailly and Mark Adler"],
      [/^libffi /, "MIT", "Anthony Green, Red Hat, Inc and others"],
      [/^bzip2 /, "bzip2-1.0.6", "Julian R Seward"],
      [/^XZ Utils .*liblzma/, "LicenseRef-Public-Domain", "liblzma is in the public domain"],
      [/^mpdecimal /, "BSD-2-Clause", "Stefan Krah"],
      [/^Expat /, "MIT", "Expat maintainers"],
      [/^HACL\*/, "MIT", "HACL* Contributors"],
      [/^mimalloc /, "MIT", "Microsoft Corporation, Daan Leijen"],
      [/^Zstandard /, "BSD-3-Clause", "Meta Platforms"],
      [/^SQLite /, "blessing", "May you do good and not evil"],
      [/^Emscripten /, "MIT OR NCSA", "Emscripten authors"],
      [/^musl libc/, "MIT", "Rich Felker"],
      [/^LLVM libc\+\+/, "Apache-2.0 WITH LLVM-exception", "LLVM Exceptions to the Apache 2.0 License"],
    ];
    for (const [re, license, needle] of expected) {
      const n = find(re);
      expect(n, re.source).toMatchObject({ license, group: "python" });
      expect(text(n), re.source).toContain(needle);
    }
    const incorporated = text(find(/^CPython .*incorporated/));
    for (const s of ["Mersenne Twister", "SipHash24", "strtod and dtoa", "mimalloc"]) expect(incorporated).toContain(s);
  });

  it("ships the OFL of the preview fonts with their copyright lines", () => {
    const cmu = find(/^Computer Modern Unicode \(cm-unicode\)$/);
    expect(cmu).toMatchObject({ license: "OFL-1.1", file: "licenses/fonts/cm-unicode-OFL.txt", group: "fonts" });
    expect(text(cmu)).toContain("Copyright (C) 2003-2009, Andrey V. Panov");
    expect(text(cmu)).toContain("SIL OPEN FONT LICENSE Version 1.1");

    const fa = find(/^FontAwesome 4$/);
    expect(fa).toMatchObject({ license: "OFL-1.1", file: "licenses/fonts/FontAwesome-4-OFL.txt", group: "fonts" });
    expect(text(fa)).toContain("Copyright Dave Gandy 2016. All rights reserved.");
    expect(text(fa)).toContain("Version 4.6.3");
    expect(text(fa)).toContain("SIL OPEN FONT LICENSE");
  });
});
