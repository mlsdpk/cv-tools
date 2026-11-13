import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZip } from "../../scripts/prepare-assets.mjs";
import { engineIsStub, expect, openApp, replaceLine, savedFiles, savedYaml, test } from "./fixtures";

const REPO = new URL("../../../", import.meta.url).pathname;
const V1 = join(REPO, "examples/v1/cv.yaml");
/** The Python with cv-tools installed, for comparisons with the CLI: $CV_TOOLS_PYTHON or the repository's .venv. */
const PYTHON = process.env.CV_TOOLS_PYTHON ?? join(REPO, ".venv/bin/python");
const HAS_PYTHON = spawnSync(PYTHON, ["-c", "import cv_tools"]).status === 0;

/** Use the <input type=file> path instead of the File System Access picker, which tests cannot drive. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });
});

test("opens a v1 file and migrates it to v2", async ({ page }) => {
  await openApp(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "New / Open" }).click();
  await page.getByRole("menuitem", { name: "Open file…" }).click();
  await (await chooser).setFiles(V1);
  await expect(page.locator("#notice")).toContainText("uses the v1 format");
  await expect(page.locator("#app")).toHaveAttribute("data-valid", "v1");
  await expect(page.locator("#file-state")).toContainText("cv.yaml");
  await page.locator("#notice").getByRole("button", { name: "Migrate to v2" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Replace" }).click();
  await expect(page.locator("#notice")).toContainText("Migrated to v2");
  await expect.poll(() => savedYaml(page)).toMatch(/^version: 2$/m);
  const yaml = await savedYaml(page);
  expect(yaml).toMatch(/^version: 2$/m);
  expect(yaml).toContain("# mandatory");
  // The v1 example refers to publications.bib, which the workspace already has from the example.
  await expect(page.locator("#app")).toHaveAttribute("data-valid", "valid");
});

test("opens dropped files after asking, and Undo brings back the previous CV", async ({ page }) => {
  await openApp(page);
  await replaceLine(page, "name: John Doe", "name: My Own Work");
  await expect.poll(() => savedYaml(page)).toContain("My Own Work");
  const text = "version: 2\nname: Dropped Person\nsections: []\n";
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.items.add(new File([t], "dropped.yaml", { type: "text/yaml" }));
    for (const type of ["dragenter", "dragover", "drop"]) {
      window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
  }, text);
  await expect(page.getByRole("dialog")).toContainText("dropped.yaml replaces the CV you have open");
  await page.getByRole("dialog").getByRole("button", { name: "Replace" }).click();
  await expect.poll(() => savedYaml(page)).toBe(text);
  await expect(page.locator("#file-state")).toContainText("dropped.yaml");
  await expect(page.locator("#drop")).toBeHidden();
  await page.locator("#notice").getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => savedYaml(page)).toContain("My Own Work");
  await expect(page.locator("#file-state")).toContainText("cv.yaml");
});

test("share link round trip", async ({ page, browser }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (t: string) => ((window as unknown as { copied: string }).copied = t) },
    });
  });
  await openApp(page);
  await replaceLine(page, "name: John Doe", "name: Shared Person");
  await expect.poll(() => savedYaml(page)).toContain("Shared Person");
  await page.getByRole("button", { name: "Other downloads" }).click();
  await page.getByRole("menuitem", { name: /Copy share link/ }).click();
  await expect(page.locator("#notice")).toContainText("Share link copied");
  const link = await page.evaluate(() => (window as unknown as { copied: string }).copied);
  expect(link).toMatch(/#cv=[A-Za-z0-9_-]+$/);

  const other = await browser.newContext();
  const page2 = await other.newPage();
  await openApp(page2, link);
  await expect.poll(() => savedYaml(page2)).toContain("name: Shared Person");
  expect(Object.keys(await savedFiles(page2)).sort()).toEqual(["cv.yaml", "publications.bib"]);
  expect(new URL(page2.url()).hash).toBe("");
  await other.close();
});

test("downloads the LaTeX source, the YAML with its .bib and the PDF", async ({ page }) => {
  await openApp(page);
  const dir = mkdtempSync(join(tmpdir(), "cv-tools-e2e-"));

  await page.getByRole("button", { name: "Other downloads" }).click();
  let dl = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "LaTeX for Overleaf" }).click();
  let file = await dl;
  expect(file.suggestedFilename()).toBe("cv-latex.zip");
  await file.saveAs(join(dir, "latex.zip"));
  const latex = readZip(readFileSync(join(dir, "latex.zip")));
  expect(Object.keys(latex).sort()).toEqual(["cv.tex", "orcid.pdf", "resume.cls"]);
  if (HAS_PYTHON) {
    // The same .tex as the CLI renders from the same files.
    const cli = execFileSync(PYTHON, ["-c", "import sys; from cv_tools import api; sys.stdout.write(api.render_tex(api.load(sys.argv[1])).tex)", join(REPO, "examples/cv.yaml")], {
      encoding: "utf8",
    });
    expect(latex["cv.tex"].toString("utf8")).toBe(cli);
  }

  await page.getByRole("button", { name: "Other downloads" }).click();
  dl = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "YAML", exact: true }).click();
  file = await dl;
  expect(file.suggestedFilename()).toBe("cv.zip");
  await file.saveAs(join(dir, "cv.zip"));
  const sources = readZip(readFileSync(join(dir, "cv.zip")));
  expect(sources["cv.yaml"].toString("utf8")).toBe(readFileSync(join(REPO, "examples/cv.yaml"), "utf8"));
  expect(sources["publications.bib"].toString("utf8")).toBe(readFileSync(join(REPO, "examples/publications.bib"), "utf8"));

  dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF" }).click();
  file = await dl;
  expect(file.suggestedFilename()).toBe("cv.pdf");
  const pdfPath = join(dir, "cv.pdf");
  await file.saveAs(pdfPath);
  const pdf = readFileSync(pdfPath);
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");

  // Pixel comparison with the CLI (native pdflatex). Needs the real engine, pdflatex, pdftoppm and Pillow.
  if (await engineIsStub(page)) return;
  const tools = spawnSync("sh", ["-c", "command -v pdflatex && command -v pdftoppm"], { env: { ...process.env, PATH: `/Library/TeX/texbin:${process.env.PATH}` } });
  if (tools.status !== 0 || !HAS_PYTHON) return;
  const env = { ...process.env, PATH: `/Library/TeX/texbin:${process.env.PATH}` };
  execFileSync(PYTHON, ["-m", "cv_tools", "build", join(REPO, "examples/cv.yaml"), "-o", join(dir, "cli.pdf")], { env });
  const script = join(dir, "compare.py");
  writeFileSync(
    script,
    `import subprocess, sys, glob
from PIL import Image, ImageChops
d = sys.argv[1]
for n in ("cv", "cli"):
    subprocess.run(["pdftoppm", "-r", "150", "-png", f"{d}/{n}.pdf", f"{d}/{n}"], check=True)
a = sorted(glob.glob(f"{d}/cv-*.png")); b = sorted(glob.glob(f"{d}/cli-*.png"))
assert len(a) == len(b) > 0, (len(a), len(b))
bad = 0
for x, y in zip(a, b):
    diff = ImageChops.difference(Image.open(x).convert("RGB"), Image.open(y).convert("RGB"))
    bad += sum(1 for p in diff.getdata() if p != (0, 0, 0))
print(bad)
`,
  );
  const differing = execFileSync(PYTHON, [script, dir], { env, encoding: "utf8" }).trim();
  expect(Number(differing), "differing pixels between the browser PDF and the CLI PDF").toBe(0);
});
