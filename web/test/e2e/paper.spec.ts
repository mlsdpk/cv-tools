import { at, expect, needLive, openApp, savedFiles, savedYaml, test } from "./fixtures";

const live = (page: import("@playwright/test").Page) => page.locator("#live");

for (const layout of ["Paper", "Split"]) {
  test.describe(layout, () => {
    test.beforeEach(async ({ page }) => {
      await openApp(page);
      await needLive(page);
      await page.getByRole("button", { name: layout, exact: true }).click();
      await expect(page.locator("#app")).toHaveAttribute("data-layout", layout.toLowerCase());
    });

    test("edits text in place and keeps the YAML comments", async ({ page }) => {
      const date = at(page, "sections.0.entries.0.date");
      await date.click();
      await expect(date).toHaveAttribute("data-editing", "");
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.insertText("Fall 2021 - Spring 2024");
      await page.keyboard.press("Enter");
      await expect.poll(() => savedYaml(page)).toContain("        date: Fall 2021 - Spring 2024\n");
      expect(await savedYaml(page)).toContain("# cv-tools v2 example. Build it with: cv-tools build examples/cv.yaml");
      await expect(at(page, "sections.0.entries.0.date")).toHaveText("Fall 2021 - Spring 2024");
    });

    test("entry actions move, add and delete entries, and keep focus on the action", async ({ page }) => {
      const titles = async () => [...(await savedYaml(page)).matchAll(/^ {6}- title: (.*)$/gm)].map((m) => m[1]).slice(2, 5);
      await at(page, "sections.1.entries.0.title").click();
      const tools = live(page).getByRole("toolbar", { name: "Entry actions" });
      await expect(tools.getByRole("button")).toHaveText(["Move up", "Move down", "Add entry below", "Delete"]);
      await expect(tools.getByRole("button", { name: "Move up" })).toHaveAttribute("aria-disabled", "true");

      await tools.getByRole("button", { name: "Move down" }).click();
      await expect.poll(titles).toEqual(["NextGen Robotics", "Tech Innovations Inc.", "Virtual Coding Academy"]);
      const focused = () => page.evaluate(() => (document.getElementById("live")!.shadowRoot!.activeElement as HTMLElement | null)?.textContent);
      await expect.poll(focused).toBe("Move down");
      await tools.getByRole("button", { name: "Move up" }).focus();
      await page.keyboard.press("Enter");
      await expect.poll(titles).toEqual(["Tech Innovations Inc.", "NextGen Robotics", "Virtual Coding Academy"]);

      await at(page, "sections.1.entries.0.title").click();
      await tools.getByRole("button", { name: "Add entry below" }).click();
      await expect(at(page, "sections.1.entries.1.title")).toHaveAttribute("data-editing", "");
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.insertText("Startup");
      await page.keyboard.press("Enter");
      await expect.poll(titles).toEqual(["Tech Innovations Inc.", "Startup", "NextGen Robotics"]);

      await tools.getByRole("button", { name: "Delete" }).click();
      await expect.poll(titles).toEqual(["Tech Innovations Inc.", "NextGen Robotics", "Virtual Coding Academy"]);
      await page.locator("#notice").getByRole("button", { name: "Undo" }).click();
      await expect.poll(titles).toEqual(["Tech Innovations Inc.", "Startup", "NextGen Robotics"]);
    });

    test("a selected entry shows its empty fields as placeholders that add the key", async ({ page }) => {
      await at(page, "sections.1.entries.0.title").click();
      for (const text of ["add location", "add note", "add detail line", "add bullet"]) await expect(live(page).getByRole("button", { name: text })).toBeVisible();
      await expect(live(page).getByRole("button", { name: "add date" })).toHaveCount(0);

      await live(page).getByRole("button", { name: "add location" }).click();
      await page.keyboard.insertText("Remote");
      await page.keyboard.press("Enter");
      await expect.poll(() => savedYaml(page)).toContain("      - title: Tech Innovations Inc.\n        location: Remote\n        date: July 2024 - Present\n");
      await expect(at(page, "sections.1.entries.0.location")).toHaveText("Remote");

      // By keyboard: Tab to a placeholder, Enter, type.
      await live(page).getByRole("button", { name: "add bullet" }).focus();
      await page.keyboard.press("Enter");
      await page.keyboard.insertText("Shipped it.");
      await page.keyboard.press("Enter");
      await expect.poll(() => savedYaml(page)).toContain("database restructuring.\n          - Shipped it.\n");

      await live(page).getByRole("button", { name: "add detail line" }).click();
      await page.keyboard.insertText("Team of five");
      await page.keyboard.press("Enter");
      await expect.poll(() => savedYaml(page)).toContain("        subtitle: Software Engineer\n        details:\n          - Team of five\n        bullets:\n");

      // A placeholder left empty adds nothing.
      await live(page).getByRole("button", { name: "add note" }).click();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      expect(await savedYaml(page)).not.toContain("note: ''");

      // A plain list item becomes a mapping for its first sub-item.
      await at(page, "sections.3.entries.0").click();
      await live(page).getByRole("button", { name: "add sub-item" }).click();
      await page.keyboard.insertText("Twice");
      await page.keyboard.press("Enter");
      await expect.poll(() => savedYaml(page)).toContain("      - text: Dean's List (2023, 2022)\n        bullets:\n          - Twice\n");
      await expect(page.locator("#app")).toHaveAttribute("data-valid", "valid");
    });

    test("adds an entry under a section and a section with one entry to type into", async ({ page }) => {
      await live(page).locator('[data-section="sections.6"] .cv-add-entry').click();
      await expect(at(page, "sections.6.entries.3.title")).toHaveAttribute("data-editing", "");
      // Left empty, the new entry goes again.
      await page.keyboard.press("Escape");
      await expect(at(page, "sections.6.entries.3.title")).toHaveCount(0);
      await page.waitForTimeout(700); // the save after the last change
      expect(await savedYaml(page)).not.toContain('title: ""');

      await live(page).getByRole("button", { name: "+ Add section" }).click();
      const form = live(page).getByRole("form", { name: "Add section" });
      await expect(form.getByLabel("Section title")).toHaveValue("Awards");
      await form.getByText("Pairs", { exact: true }).click();
      await expect(form.getByLabel("Section title")).toHaveValue("Skills");
      await form.getByLabel("Section title").fill("Languages");
      await form.getByRole("button", { name: "Add section" }).click();
      await expect(at(page, "sections.10.entries.0.title")).toHaveAttribute("data-editing", "");
      await page.keyboard.insertText("English");
      await page.keyboard.press("Enter");
      await expect.poll(() => savedYaml(page)).toMatch(/- title: Languages\n {4}layout: pairs\n {4}entries:\n {6}- title: English\n {8}text: ""\n$/);
      await expect(page.locator("#app")).toHaveAttribute("data-valid", "valid");
    });
  });
}

test("Enter keeps the focus on the edited value, and Enter edits it again", async ({ page }) => {
  await openApp(page);
  await needLive(page);
  await page.getByRole("button", { name: "Paper" }).click();
  const date = at(page, "sections.0.entries.0.date");
  await date.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("2020 -- 2024");
  await page.keyboard.press("Enter");
  await expect.poll(() => savedYaml(page)).toContain("date: 2020 -- 2024\n");
  await expect(date).toHaveAttribute("data-raw", "2020 -- 2024");
  const focused = () => page.evaluate(() => (document.getElementById("live")!.shadowRoot!.activeElement as HTMLElement | null)?.dataset.path ?? null);
  await expect.poll(focused).toBe("sections.0.entries.0.date");
  await expect(page.locator("#live [data-editing]")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(date).toHaveAttribute("data-editing", "");
});

test("shows the source text with markup while editing, and Escape cancels", async ({ page }) => {
  await openApp(page);
  await needLive(page);
  await page.getByRole("button", { name: "Paper" }).click();
  const note = at(page, "sections.0.entries.0.note");
  await note.click();
  await expect(note).toHaveText("**Magna Cum Laude**");
  await page.keyboard.insertText(" extra");
  await page.keyboard.press("Escape");
  await expect(note).toHaveText("Magna Cum Laude");
  await expect(page.locator(".cm-content")).toContainText("note: '**Magna Cum Laude**'");
  expect(await savedYaml(page)).toBe(""); // nothing was changed, so the example is still not saved
});

test("a publications section uses an existing .bib file or creates one", async ({ page }) => {
  await openApp(page);
  await needLive(page);
  await page.getByRole("button", { name: "New / Open" }).click();
  await page.getByRole("menuitem", { name: "New, minimal" }).click();
  await expect(at(page, "name")).toHaveText("Your Name");
  await live(page).getByRole("button", { name: "+ Add section" }).click();
  const form = live(page).getByRole("form", { name: "Add section" });
  await form.getByText("Publications", { exact: true }).click();
  await expect(form.getByLabel("BibTeX file")).toHaveValue("publications.bib");
  await form.getByRole("button", { name: "Add section" }).click();
  await expect.poll(async () => Object.keys(await savedFiles(page)).sort()).toEqual(["cv.yaml", "publications.bib"]);
  expect(await savedYaml(page)).toContain("  - title: Publications\n    layout: publications\n    bib: publications.bib\n");
  await expect(page.locator("#app")).toHaveAttribute("data-valid", "valid");
  await expect(live(page).locator(".cv-citation")).toHaveCount(1);
});

test("builds a small CV from New, minimal using only the page", async ({ page }) => {
  await openApp(page);
  await needLive(page);
  await page.getByRole("button", { name: "Paper" }).click();
  await page.getByRole("button", { name: "New / Open" }).click();
  await page.getByRole("menuitem", { name: "New, minimal" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0); // the example is not work: nothing to confirm
  const type = async (path: string, text: string) => {
    await at(page, path).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText(text);
    await page.keyboard.press("Enter");
    await expect(at(page, path)).toHaveText(text);
  };
  await type("name", "Ada Lovelace");
  await type("contact.0.0", "ada@example.org");
  await type("sections.0.entries.0.title", "Analytical Engine");
  await live(page).getByRole("button", { name: "add bullet" }).click();
  await page.keyboard.insertText("Wrote the first program.");
  await page.keyboard.press("Enter");
  await live(page).getByRole("button", { name: "+ Add section" }).click();
  const form = live(page).getByRole("form", { name: "Add section" });
  await form.getByText("Pairs", { exact: true }).click();
  await form.getByRole("button", { name: "Add section" }).click();
  await expect(at(page, "sections.1.entries.0.title")).toHaveAttribute("data-editing", "");
  await page.keyboard.insertText("Languages");
  await page.keyboard.press("Enter");
  await type("sections.1.entries.0.text", "English, French");
  await expect.poll(() => savedYaml(page)).toBe(`version: 2
name: Ada Lovelace

contact:
  - - ada@example.org

sections:
  - title: Experience
    layout: entries
    entries:
      - title: Analytical Engine
        date: 2024 - Present
        subtitle: Job Title
        bullets:
          - Wrote the first program.
  - title: Skills
    layout: pairs
    entries:
      - title: Languages
        text: English, French
`);
  await expect(page.locator("#app")).toHaveAttribute("data-valid", "valid");
  await expect(page.locator("#page-info")).toHaveText("Page 1 of 1");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("entry actions and adding have 44 px targets", async ({ page }) => {
    await openApp(page);
    await needLive(page);
    await at(page, "sections.1.entries.0.title").tap();
    const tools = live(page).getByRole("toolbar", { name: "Entry actions" });
    await expect(tools).toBeVisible();
    for (const b of [...(await tools.getByRole("button").all()), live(page).locator('[data-section="sections.1"] .cv-add-entry')]) {
      const box = (await b.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43.5);
      expect(box.width).toBeGreaterThanOrEqual(43.5);
    }
    await tools.getByRole("button", { name: "Move down" }).tap();
    await expect.poll(() => savedYaml(page)).toMatch(/- title: NextGen Robotics[\s\S]*- title: Tech Innovations Inc\./);
  });
});
