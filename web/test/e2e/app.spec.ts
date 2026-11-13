import { readFileSync } from "node:fs";
import { expect, liveAvailable, openApp, replaceLine, savedYaml, test, waitReady } from "./fixtures";

const EXAMPLE = readFileSync(new URL("../../../examples/cv.yaml", import.meta.url), "utf8");

test.describe("first load", () => {
  test("shows the example, validates it and renders the preview", async ({ page }) => {
    await openApp(page);
    await expect(page.locator("#st-valid")).toHaveText(/^valid · schema v2/);
    await expect(page.locator("#file-tabs [role=tab]")).toHaveText(["cv.yaml", "publications.bib"]);
    // The example is not saved until it is changed.
    await expect(page.locator("#file-state")).toContainText("example");
    expect(await savedYaml(page)).toBe("");
    await replaceLine(page, "name: John Doe", "name: John Doe");
    await page.keyboard.type("X");
    await expect.poll(() => savedYaml(page)).toBe(EXAMPLE.replace("name: John Doe", "name: John DoeX"));
    await expect(page.locator("#file-state")).toContainText("saved in this browser");
    if (await liveAvailable(page)) {
      await expect(page.locator("#live .cv-document")).toContainText("Fictional University");
    } else {
      await expect(page.locator("#preview-message")).toContainText("no live preview");
    }
  });

  test("keeps the workspace across reloads", async ({ page }) => {
    await openApp(page);
    await replaceLine(page, "name: John Doe", "name: Jane Roe");
    await expect.poll(() => savedYaml(page)).toContain("name: Jane Roe");
    await page.reload();
    await waitReady(page);
    await expect(page.locator(".cm-content")).toContainText("name: Jane Roe");
  });
});

test.describe("editing the YAML", () => {
  test("updates the preview and shows cv-tools errors in the editor", async ({ page }) => {
    await openApp(page);
    const live = await liveAvailable(page);
    await replaceLine(page, "name: John Doe", "name: Jane Roe");
    if (live) await expect(page.locator("#live .cv-document")).toContainText(/Jane Roe/i);

    await replaceLine(page, "layout: entries-inline", "layout: entrie");
    await expect(page.locator("#app")).toHaveAttribute("data-valid", "invalid");
    await expect(page.locator("#st-valid")).toContainText("did you mean 'entries'");
    await expect(page.locator(".cm-lintRange-error")).toHaveCount(1);
    await expect(page.locator(".cm-lintRange-error")).toHaveText("entrie");
    // The last good preview stays.
    if (live) await expect(page.locator("#live .cv-document")).toContainText("Fictional University");

    await replaceLine(page, "layout: entrie", "layout: entries-inline");
    await expect(page.locator("#app")).toHaveAttribute("data-valid", "valid");
    await expect(page.locator(".cm-lintRange-error")).toHaveCount(0);
  });

  test("reports characters pdfLaTeX cannot print at their position", async ({ page }) => {
    await openApp(page);
    await replaceLine(page, "name: John Doe", "name: John 😀 Doe");
    await expect(page.locator("#app")).toHaveAttribute("data-valid", "invalid");
    await expect(page.locator("#st-valid")).toContainText(/U\+1F600/);
    await expect(page.locator(".cm-lintRange-error")).toHaveCount(1);
  });

  test("shows the YAML path and position under the cursor", async ({ page }) => {
    await openApp(page);
    await page.locator(".cm-line", { hasText: "date: September 2021 - June 2024" }).click();
    await page.keyboard.press("End");
    await expect(page.locator("#st-path")).toHaveText("sections[0].entries[0].date");
    await expect(page.locator("#st-pos")).toHaveText(/^Ln 19, Col \d+$/);
    if (await liveAvailable(page)) {
      await expect(page.locator('#live [data-path="sections.0.entries.0.date"]')).toHaveClass(/cv-sync/);
    }
  });

  test("completes keys from the JSON Schema", async ({ page }) => {
    await openApp(page);
    await page.locator(".cm-line", { hasText: "date: August 2018 - May 2021" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    // Explicit completion (CodeMirror binds Ctrl-Space, and Alt-` on macOS) lists the keys this entry may still have.
    await page.keyboard.press(process.platform === "darwin" ? "Alt+Backquote" : "Control+Space");
    const options = page.locator(".cm-tooltip-autocomplete li");
    await expect(options.first()).toBeVisible();
    const labels = await options.allTextContents();
    expect(labels.some((l) => l.startsWith("note"))).toBe(true);
    expect(labels.some((l) => l.startsWith("bullets"))).toBe(true);
    expect(labels.some((l) => l.startsWith("subtitle"))).toBe(false); // already present
    expect(labels.some((l) => l.startsWith("layout"))).toBe(false); // a section key, not an entry key
    await page.keyboard.press("Escape");
    // Typing completes too, and a section offers its layout values.
    await page.keyboard.type("no");
    await expect(options.filter({ hasText: /^note/ })).toHaveCount(1);
    // CodeMirror ignores Enter for 75 ms after the list opens (interactionDelay).
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await expect.poll(() => savedYaml(page)).toContain("        date: August 2018 - May 2021\n        note: \n");
    await replaceLine(page, "layout: entries-inline", "layout: e");
    await expect(options.filter({ hasText: /^entries-inline$/ })).toHaveCount(1);
  });

  test("edits the .bib file in its own tab", async ({ page }) => {
    await openApp(page);
    await page.getByRole("tab", { name: "publications.bib" }).click();
    await expect(page.locator(".cm-content")).toContainText("@");
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText("@article{broken,\n");
    await expect(page.locator("#app")).toHaveAttribute("data-valid", "invalid");
  });
});

test("the PDF compiles quietly in the background after a change", async ({ page }) => {
  await openApp(page);
  await expect(page.locator("#app")).toHaveAttribute("data-pdf", "ready", { timeout: 60_000 });
  await expect(page.locator("#st-engine")).toHaveText(/(pdfLaTeX|PDF engine stub) · \d+\.\d s/);
  await expect(page.locator("#paper-status")).toBeHidden();
  const before = Number(await page.locator("#app").getAttribute("data-pdf-for"));
  await replaceLine(page, "name: John Doe", "name: Jane Roe");
  await expect.poll(async () => Number(await page.locator("#app").getAttribute("data-pdf-for")), { timeout: 30_000 }).toBeGreaterThan(before);
  await expect(page.locator("#live")).toHaveAttribute("data-pages-from", "pdf");
});
