// Editing on the page: new entries, lists, focus, sections, the header, and what never moves.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { at, expect, needLive, openApp, paper, replaceLine, savedYaml, test } from "./fixtures";

const live = (page: Page) => page.locator("#live");

/** The path (or "+path" for a placeholder) of the focused element on the page. */
function focused(page: Page) {
  return page.evaluate(() => {
    const a = document.getElementById("live")!.shadowRoot!.activeElement as HTMLElement | null;
    const owner = a?.closest<HTMLElement>("[data-cv-add], [data-path]");
    return owner?.dataset.cvAdd ? `+${owner.dataset.cvAdd}` : (owner?.dataset.path ?? a?.textContent ?? null);
  });
}

/** The viewport position of character `i` of a value's text (its left edge, mid height). */
function charAt(page: Page, path: string, i: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ path, i }) => {
      const el = document.getElementById("live")!.shadowRoot!.querySelector(`[data-path="${path}"]`)!;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n = i;
      for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
        if (n < t.length) {
          const range = document.createRange();
          range.setStart(t, n);
          range.setEnd(t, n + 1);
          const r = range.getBoundingClientRect();
          return { x: r.left + Math.min(1, r.width / 4), y: r.top + r.height / 2 };
        }
        n -= t.length;
      }
      throw new Error(`no character ${i} in ${path}`);
    },
    { path, i },
  );
}

/** The caret to the end of the line (Home and End do not move it on macOS). */
const lineEnd = (page: Page) => page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await needLive(page);
});

test("new entries start with an empty title to type into, and go again when left empty", async ({ page }) => {
  await live(page).locator('[data-section="sections.1"] .cv-add-entry').click();
  const title = at(page, "sections.1.entries.2.title");
  await expect(title).toHaveAttribute("data-editing", "");
  await expect(title).toHaveText("");
  // The empty fields are placeholders; nothing is filled in.
  for (const name of ["add location", "add date", "add subtitle", "add note", "add detail line", "add bullet"]) await expect(live(page).getByRole("button", { name, exact: true })).toBeVisible();
  await page.keyboard.insertText("Startup");
  // Its spaces do not stretch with the justified line.
  await expect(title).toHaveCSS("display", "inline-block");
  await page.keyboard.press("Enter");
  await expect.poll(() => savedYaml(page)).toContain("      - title: Startup\n\n  - title: Teaching and Volunteering");

  // Add entry below, then click away: the empty entry is removed.
  await live(page).getByRole("toolbar", { name: "Entry actions" }).getByRole("button", { name: "Add entry below" }).click();
  await expect(at(page, "sections.1.entries.3.title")).toHaveAttribute("data-editing", "");
  await at(page, "sections.0.entries.0.title").click();
  await expect(at(page, "sections.1.entries.3.title")).toHaveCount(0);
  await page.waitForTimeout(700); // the save after the last change
  const yaml = await savedYaml(page);
  expect(yaml).not.toContain('title: ""');
  expect(yaml).not.toMatch(/New entry|Subtitle|date: Date/);
  await expect(page.locator("#app")).toHaveAttribute("data-valid", "valid");

  // Keys typed before the new title is ready go into it.
  await live(page).locator('[data-section="sections.0"] .cv-add-entry').click();
  await page.keyboard.type("Quick");
  await expect(at(page, "sections.0.entries.2.title")).toHaveText("Quick");
  await page.keyboard.press("Escape");

  // Add section keeps one entry to type into; left empty, the section keeps "+ Add entry" in view.
  await live(page).getByRole("button", { name: "+ Add section" }).click();
  const form = live(page).getByRole("form", { name: "Add section" });
  await form.getByText("Entries", { exact: true }).click();
  await form.getByRole("button", { name: "Add section" }).click();
  await expect(at(page, "sections.10.entries.0.title")).toHaveAttribute("data-editing", "");
  await page.keyboard.press("Escape");
  await expect(at(page, "sections.10.entries.0.title")).toHaveCount(0);
  await expect.poll(() => savedYaml(page)).toMatch(/- title: Experience\n {4}layout: entries\n {4}entries: \[\]\n$/);
  await at(page, "name").click();
  await page.keyboard.press("Escape");
  await expect(live(page).locator('[data-section="sections.10"] .cv-add-entry')).toHaveCSS("opacity", "1");
});

test("Enter in a bullet starts the next one, and an empty item is removed", async ({ page }) => {
  const bullet = at(page, "sections.1.entries.1.bullets.0");
  await bullet.click();
  await lineEnd(page);
  await page.keyboard.insertText(" Fast.");
  await page.keyboard.press("Enter");
  // The editor follows the new bullet, which is typed in the bullet's own style.
  await expect(page.locator("#st-path")).toHaveText("sections[1].entries[1].bullets[1]");
  // Typing straight away goes into the new bullet, before any render.
  await page.keyboard.insertText("Second.");
  await expect(live(page).locator("[data-editing]")).toHaveCSS("font-style", "normal");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("Third.");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(live(page).locator("[data-editing]")).toHaveCount(0);
  await expect
    .poll(() => savedYaml(page))
    .toContain("industrial robots. Fast.\n          - Second.\n          - Third.\n          - Collaborated with cross-functional teams");
  await expect.poll(() => focused(page)).toBe("sections.1.entries.1.bullets.2");

  // Sub-items and list entries work the same.
  await at(page, "sections.7.entries.0.bullets.1").click();
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("Journal of Robotics");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await at(page, "sections.3.entries.2").click();
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("Teaching Award (2021)");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect.poll(() => savedYaml(page)).toContain("(JMLR)\n          - Journal of Robotics\n      - text: Conferences");
  await expect.poll(() => savedYaml(page)).toContain("Fictional University (2024)\n      - Teaching Award (2021)\n\n  - newpage");

  // Clearing a bullet, a detail line or a contact item deletes it; no `- ""` and no trailing "|".
  for (const path of ["sections.1.entries.1.bullets.1", "sections.2.entries.0.details.1", "contact.1.1"]) {
    await at(page, path).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await page.keyboard.press("Enter");
  }
  await expect.poll(() => savedYaml(page)).toContain("  - - johndoe@email.com\n\nsections:");
  const yaml = await savedYaml(page);
  expect(yaml).not.toContain("- Second.");
  expect(yaml).not.toContain("Imaginaria, Wonderland\n        bullets");
  expect(yaml).not.toMatch(/- (""|'')/);
  await expect(live(page).locator(".cv-contact").nth(1)).toHaveText("johndoe@email.com");
  await expect(page.locator("#app")).toHaveAttribute("data-valid", "valid");
});

test("focus stays on the same field or placeholder after a commit and re-render", async ({ page }) => {
  await paper(page);
  // Type into a title and Tab to the next placeholder: the render keeps focus there.
  const title = at(page, "sections.1.entries.0.title");
  await title.click();
  await lineEnd(page);
  await page.keyboard.insertText(" Ltd");
  await page.keyboard.press("Tab");
  await expect.poll(() => focused(page)).toBe("+sections.1.entries.0.location");
  await expect.poll(() => savedYaml(page)).toContain("title: Tech Innovations Inc. Ltd\n");
  await page.waitForTimeout(600);
  expect(await focused(page)).toBe("+sections.1.entries.0.location");
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => focused(page)).toBe("sections.1.entries.0.title");
  await page.keyboard.press("Escape");

  // Enter again edits with the caret at the end; a click puts it where it lands.
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("!");
  await page.keyboard.press("Enter");
  await expect.poll(() => savedYaml(page)).toContain("title: Tech Innovations Inc. Ltd!\n");
  await expect(title).not.toHaveAttribute("data-editing", "");
  const { x, y } = await charAt(page, "sections.1.entries.0.title", 4);
  await page.mouse.click(x, y);
  await expect(title).toHaveAttribute("data-editing", "");
  await page.keyboard.insertText("X");
  await page.keyboard.press("Enter");
  await expect.poll(() => savedYaml(page)).toContain("title: TechX Innovations Inc. Ltd!\n");

  // Undo after Delete gives focus back to the restored entry.
  await at(page, "sections.2.entries.1.title").click();
  await page.keyboard.press("Escape");
  await live(page).getByRole("toolbar").getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => savedYaml(page)).not.toContain("Tech Youth Initiative");
  await page.locator("#notice").getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => focused(page)).toBe("sections.2.entries.1.title");
  await expect(live(page).locator(".cv-entry-active")).toHaveAttribute("data-entry", "sections.2.entries.1");
});

test("a click in a link's text puts the caret in the text, never in the URL", async ({ page }) => {
  await paper(page);
  const path = "sections.0.entries.0.details.0";
  await at(page, path).click();
  await page.keyboard.press("Escape");
  const shown = (await at(page, path).textContent())!;
  const { x, y } = await charAt(page, path, shown.indexOf("Computing"));
  await page.mouse.click(x, y);
  await expect(at(page, path)).toHaveAttribute("data-editing", "");
  await page.keyboard.insertText("X");
  await page.keyboard.press("Enter");
  await expect.poll(() => savedYaml(page)).toContain("['Quantum XComputing'](https://en.wikipedia.org/wiki/Quantum_computing)");
});

test("sections: the title selects the section, with move, delete and an added description", async ({ page }) => {
  await paper(page);
  await at(page, "sections.3.title").click();
  const tools = live(page).getByRole("toolbar", { name: "Section actions" });
  await expect(tools.getByRole("button")).toHaveText(["Move up", "Move down", "Delete section"]);
  await page.keyboard.press("Escape");
  await tools.getByRole("button", { name: "Move up" }).click();
  await expect.poll(async () => [...(await savedYaml(page)).matchAll(/^ {2}- title: (.*)$/gm)].map((m) => m[1]).slice(0, 4)).toEqual([
    "Education",
    "Professional Experience",
    "Honors and Awards",
    "Teaching and Volunteering",
  ]);
  await expect.poll(() => focused(page)).toBe("Move up");

  await live(page).getByRole("button", { name: "add description" }).click();
  await page.keyboard.insertText("Selected awards.");
  await page.keyboard.press("Enter");
  await expect.poll(() => savedYaml(page)).toContain("  - title: Honors and Awards\n    layout: list\n    description: Selected awards.\n    entries:\n");

  await at(page, "sections.2.title").click();
  await page.keyboard.press("Escape");
  await live(page).getByRole("toolbar", { name: "Section actions" }).getByRole("button", { name: "Delete section" }).click();
  const ask = page.getByRole("dialog");
  await expect(ask).toContainText("Delete the section 'Honors and Awards' and its entries?");
  await ask.getByRole("button", { name: "Cancel" }).click();
  expect(await savedYaml(page)).toContain("Honors and Awards");
  await live(page).getByRole("toolbar", { name: "Section actions" }).getByRole("button", { name: "Delete section" }).click();
  await ask.getByRole("button", { name: "Delete section" }).click();
  await expect.poll(() => savedYaml(page)).not.toContain("Honors and Awards");
  await page.locator("#notice").getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => savedYaml(page)).toContain("Honors and Awards");
});

test("the header: a selected contact item shows add contact on each line, which adds plain text", async ({ page }) => {
  await paper(page);
  await at(page, "contact.1.0").click();
  const add = live(page).getByRole("button", { name: "add contact" });
  await expect(add).toHaveCount(2);
  await add.nth(1).click();
  await page.keyboard.insertText("+1 555 0100");
  await page.keyboard.press("Enter");
  await expect.poll(() => savedYaml(page)).toContain("    - Curriculum Vitae, {date}\n    - +1 555 0100\n");
});

test("an invalid YAML or a v1 file greys the page out and says why", async ({ page }) => {
  await replaceLine(page, "layout: entries-inline", "layout: entries-inlinex");
  await expect(page.locator("#app")).toHaveAttribute("data-valid", "invalid");
  await expect(page.locator("#paper-hint")).toHaveText("Fix the YAML error to edit on the page");
  await expect(live(page)).toHaveClass(/cv-blocked/);
  await at(page, "sections.1.entries.0.title").click();
  await expect(live(page).locator("[data-editing]")).toHaveCount(0);
  await page.locator(".cm-content").click();
  await replaceLine(page, "layout: entries-inlinex", "layout: entries-inline");
  await expect(page.locator("#app")).toHaveAttribute("data-valid", "valid");
  await expect(page.locator("#paper-hint")).toHaveText("Click any text to edit it");
  await expect(live(page)).not.toHaveClass(/cv-blocked/);

  // Opening a v1 file shows that file, greyed out, with the migrate offer.
  const v1 = readFileSync(new URL("../../../examples/v1/cv.yaml", import.meta.url), "utf8").replace("John Doe", "Old Format Person");
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.items.add(new File([t], "old.yaml", { type: "text/yaml" }));
    for (const type of ["dragenter", "dragover", "drop"]) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, v1);
  await page.getByRole("dialog").getByRole("button", { name: "Replace" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-valid", "v1");
  await expect(live(page).locator(".cv-name")).toHaveText("Old Format Person");
  await expect(page.locator("#paper-hint")).toHaveText("Migrate to v2 to edit on the page");
  await expect(page.locator("#hint-migrate")).toBeVisible();
  await page.locator("#hint-migrate").click();
  await page.getByRole("dialog").getByRole("button", { name: "Replace" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-valid", "valid");
  await expect(page.locator("#paper-hint")).toHaveText("Click any text to edit it");
});

test("Add section ends the last page, outside page breaks, and shows the BibTeX file only for Publications", async ({ page }) => {
  await paper(page);
  const add = live(page).locator(".cv-add");
  expect(await add.evaluate((a) => a.parentElement!.matches(".cv-page:last-child") && a.previousElementSibling!.matches(".cv-section"))).toBe(true);
  await live(page).getByRole("button", { name: "+ Add section" }).click();
  const form = live(page).getByRole("form", { name: "Add section" });
  await expect(form.getByText("BibTeX file")).toBeHidden();
  await form.getByText("Publications", { exact: true }).click();
  await expect(form.getByText("BibTeX file")).toBeVisible();
  await form.getByText("Pairs", { exact: true }).click();
  await expect(form.getByText("BibTeX file")).toBeHidden();
  // The whole form is in view.
  const box = (await form.boundingBox())!;
  const view = (await page.locator("#preview-scroll").boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(view.y - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(view.y + view.height + 1);
  await expect(live(page)).toHaveAttribute("data-pages", "2");
});

test("nothing jumps: notices float, the YAML mark shows only with editor focus, and edits are left aligned", async ({ page }) => {
  const before = (await page.locator("#preview-scroll").boundingBox())!;
  await page.locator(".cm-line", { hasText: "date: July 2024 - Present" }).click();
  await expect(live(page).locator(".cv-sync")).toHaveCount(1);
  await expect(live(page).locator(".cv-sync")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.locator("#st-valid").click();
  await expect(live(page).locator(".cv-sync")).toHaveCount(0);

  // A notice is an overlay.
  await at(page, "sections.2.entries.1.title").click();
  await page.keyboard.press("Escape");
  await live(page).getByRole("toolbar").getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("#notice")).toBeVisible();
  expect(await page.locator("#preview-scroll").boundingBox()).toEqual(before);
  await expect(page.locator("#notice")).toHaveCSS("position", "fixed");

  // A justified detail line is left aligned while it is edited.
  const detail = at(page, "sections.0.entries.0.details.0");
  await detail.click();
  await expect(detail).toHaveCSS("text-align", "left");
  await page.keyboard.press("Escape");
});

test("the selection outline stays inside its row", async ({ page }) => {
  await paper(page);
  // A dated row: the outline is no taller than the row with its tools.
  const row = live(page).locator('[data-entry="sections.8.entries.1"]');
  await at(page, "sections.8.entries.1.text").click();
  await page.keyboard.press("Escape");
  const outline = await row.evaluate((r) => {
    const s = getComputedStyle(r, "::after");
    return { top: s.top, bottom: s.bottom, border: s.borderTopWidth };
  });
  expect(outline).toEqual({ top: "0px", bottom: "0px", border: "1px" });
});

test("editing chrome never changes the page breaks or the page count", async ({ page }) => {
  await paper(page);
  await expect(page.locator("#app")).toHaveAttribute("data-pdf", "ready", { timeout: 120_000 });
  const pdfPages = (await page.locator("#app").getAttribute("data-pdf-pages"))!;
  /** The values on each page, without the editing chrome. */
  const content = () =>
    live(page).evaluate((h) =>
      [...h.shadowRoot!.querySelectorAll(".cv-document > .cv-page")].map((p) => [...p.querySelectorAll("[data-path]")].map((e) => e.getAttribute("data-path")).join(" ")),
    );
  const before = await content();
  const check = async (step: string) => {
    await expect(live(page), step).toHaveAttribute("data-pages", pdfPages);
    await expect(live(page), step).toHaveAttribute("data-pages-from", "pdf");
    await expect(page.locator("#page-info"), step).toHaveText(new RegExp(` of ${pdfPages}$`));
    expect(await content(), step).toEqual(before);
  };
  // The last entry on the full first page, with its tools and an open placeholder.
  await at(page, "sections.3.entries.2").click();
  await page.keyboard.press("Escape");
  await check("entry selected");
  await live(page).getByRole("button", { name: "add sub-item" }).click();
  await page.keyboard.insertText("Twice");
  await check("placeholder open");
  await page.keyboard.press("Escape");
  // An entry with many placeholders, then the Add section form at the end of the last page.
  await at(page, "sections.2.entries.1.title").click();
  await page.keyboard.press("Escape");
  await check("entry with placeholders");
  await live(page).getByRole("button", { name: "+ Add section" }).click();
  await expect(live(page).getByRole("form", { name: "Add section" })).toBeVisible();
  await check("Add section form");
});

test("+ Add entry of the last section and + Add section do not overlap", async ({ page }) => {
  await paper(page);
  await live(page).getByRole("button", { name: "+ Add section" }).click();
  const form = live(page).getByRole("form", { name: "Add section" });
  await form.getByText("List", { exact: true }).click();
  await form.getByRole("button", { name: "Add section" }).click();
  await expect(at(page, "sections.10.entries.0")).toHaveAttribute("data-editing", "");
  await page.keyboard.insertText("Program committee");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  // Measured together, as a render can replace both.
  const gap = () =>
    live(page).evaluate((h) => {
      const r = h.shadowRoot!;
      const entry = r.querySelector('[data-section="sections.10"] .cv-add-entry')?.getBoundingClientRect();
      const add = r.querySelector(".cv-add-section")?.getBoundingClientRect();
      return entry && add ? add.top - entry.bottom : null;
    });
  await expect.poll(gap).not.toBeNull();
  expect(await gap()).toBeGreaterThanOrEqual(0);
});

test("required fields left empty show a placeholder at text size, and a section title keeps its rule", async ({ page }) => {
  await paper(page);
  for (const path of ["name", "sections.1.title", "sections.6.entries.0.title"]) {
    await at(page, path).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await page.keyboard.press("Enter");
  }
  await expect.poll(() => savedYaml(page)).toMatch(/^name: (''|"")$/m);
  const name = at(page, "name");
  await expect(name).toHaveAttribute("data-ph", "add name");
  const ph = await name.evaluate((e) => {
    const s = getComputedStyle(e, "::before");
    return { content: s.content, size: s.fontSize, transform: s.textTransform };
  });
  expect(ph.content).toBe('"add name"');
  expect(parseFloat(ph.size)).toBeLessThan(16);
  expect(ph.transform).toBe("none");
  await expect(at(page, "sections.1.title")).toHaveAttribute("data-ph", "add title");
  await expect(at(page, "sections.6.entries.0.title")).toHaveAttribute("data-ph", "add title");
  const rule = await at(page, "sections.1.title").evaluate((h) => ({ width: h.getBoundingClientRect().width, body: h.nextElementSibling!.getBoundingClientRect().width, border: getComputedStyle(h).borderBottomStyle }));
  expect(rule.border).toBe("solid");
  expect(rule.width).toBeGreaterThan(rule.body * 0.9);
  // Easy to click back into.
  await at(page, "name").click();
  await expect(at(page, "name")).toHaveAttribute("data-editing", "");
});

test("Escape discards the typed text and offers Undo", async ({ page }) => {
  await paper(page);
  const date = at(page, "sections.0.entries.0.date");
  await date.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("Spring 2020");
  await page.keyboard.press("Escape");
  await expect(date).toHaveText("September 2021 - June 2024");
  await expect(page.locator("#notice-text")).toHaveText("Edit cancelled.");
  await page.locator("#notice").getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => savedYaml(page)).toContain("date: Spring 2020\n");
});

test("a click while a render is pending is kept and starts its edit after the render", async ({ page }) => {
  await paper(page);
  // Clearing a bullet removes it, which moves the paths of the bullets after it.
  await at(page, "sections.1.entries.0.bullets.0").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await at(page, "sections.1.entries.0.bullets.2").click();
  await expect(at(page, "sections.1.entries.0.bullets.1")).toHaveAttribute("data-editing", "");
  await expect(at(page, "sections.1.entries.0.bullets.1")).toContainText("Improved system performance");
});

test("the top bar names the saved work after a reload", async ({ page }) => {
  await at(page, "name").click();
  await page.keyboard.insertText("X");
  await page.keyboard.press("Enter");
  await expect(page.locator("#file-state")).toHaveText("cv.yaml · saved in this browser");
  // A reload during the first PDF's downloads would log their cancellation.
  await expect(page.locator("#app")).toHaveAttribute("data-pdf", "ready", { timeout: 120_000 });
  await page.reload();
  await expect(page.locator("#app")).toHaveAttribute("data-py", "ready", { timeout: 60_000 });
  await expect(page.locator("#file-state")).toHaveText("cv.yaml · saved in this browser");
});

test.describe("touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("placeholders and small fields have 44 px hit areas, and + Add entry stays clear of the next section", async ({ page }) => {
    await at(page, "sections.1.entries.0.title").tap();
    const hit = async (sel: string) =>
      live(page).evaluate((h, sel) => {
        const el = h.shadowRoot!.querySelector<HTMLElement>(sel)!;
        const s = getComputedStyle(el, "::after");
        const r = el.getBoundingClientRect();
        const zoom = r.width / el.offsetWidth || 1;
        return { height: (r.height / zoom - parseFloat(s.top) - parseFloat(s.bottom)) * zoom, width: (r.width / zoom - parseFloat(s.left) - parseFloat(s.right)) * zoom };
      }, sel);
    for (const sel of ['[data-cv-add="sections.1.entries.0.location"]', '[data-path="sections.1.entries.0.date"]']) {
      const { height, width } = await hit(sel);
      expect(height, sel).toBeGreaterThanOrEqual(43.5);
      expect(width, sel).toBeGreaterThanOrEqual(43.5);
    }
    const addEntry = (await live(page).locator('[data-section="sections.1"] .cv-add-entry').boundingBox())!;
    const next = (await at(page, "sections.2.title").boundingBox())!;
    expect(addEntry.y + addEntry.height).toBeLessThanOrEqual(next.y);
    const github = (await page.locator("#github").boundingBox())!;
    expect(github.width).toBeGreaterThanOrEqual(44);
    expect(github.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe("1280 px", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Split: the entry tools render at a readable size, whatever the page zoom", async ({ page }) => {
    await at(page, "sections.1.entries.0.title").click();
    const tools = live(page).locator(".cv-tools");
    await expect(tools).toBeVisible();
    const size = await tools.evaluate((t) => {
      const zoom = t.getBoundingClientRect().width / (t as HTMLElement).offsetWidth;
      return parseFloat(getComputedStyle(t).fontSize) * zoom;
    });
    expect(size).toBeGreaterThanOrEqual(10.9);
  });
});

test("a bullet being edited is no textbox itself; a span inside it is", async ({ page }) => {
  const bullet = at(page, "sections.1.entries.0.bullets.0");
  await bullet.click();
  await expect(bullet).toHaveAttribute("data-editing", "");
  await expect(bullet).not.toHaveAttribute("role", "textbox");
  await expect(bullet.getByRole("textbox")).toHaveCount(1);
});
