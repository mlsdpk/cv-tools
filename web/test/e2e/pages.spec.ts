// One page view, split into page boxes where the PDF's pages start.
import type { Page } from "@playwright/test";
import { at, expect, needLive, openApp, savedYaml, test } from "./fixtures";

const live = (page: Page) => page.locator("#live");

/** Each page box's height and the bottom of its content, in CSS pixels at zoom 1. */
function pageBoxes(page: Page) {
  return page.evaluate(() => {
    const root = document.getElementById("live")!.shadowRoot!;
    return [...root.querySelectorAll<HTMLElement>(".cv-document > .cv-page")].map((p) => {
      const box = p.getBoundingClientRect();
      const scale = box.width / p.offsetWidth;
      const last = [...p.querySelectorAll(".cv-line, .cv-bullet, .cv-section-title, .cv-list-item, .cv-citation, .cv-dated-row, .cv-pair")].at(-1);
      return { height: box.height / scale, bottom: last ? (last.getBoundingClientRect().bottom - box.top) / scale : 0 };
    });
  });
}

test("the page is split by height until the first PDF, then where the PDF's pages start", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  // Hold the TeX engine so the first PDF waits.
  await page.route(/\/engine[^/]*\//, async (route) => {
    await held;
    await route.continue();
  });
  await openApp(page);
  await needLive(page);
  await expect(live(page)).toHaveAttribute("data-pages-from", "estimate");
  await expect(live(page)).toHaveAttribute("data-pages", "2");
  await expect(page.locator("#page-info")).toHaveText("Page 1 of 2");
  release();
  await expect(page.locator("#app")).toHaveAttribute("data-pdf", "ready", { timeout: 120_000 });
  await expect(live(page)).toHaveAttribute("data-pages-from", "pdf");
  await expect(live(page)).toHaveAttribute("data-pages", "2");
  // Scrolling to the second page updates the label.
  await page.locator("#live").evaluate((h) => h.shadowRoot!.querySelectorAll(".cv-page")[1].scrollIntoView());
  await expect(page.locator("#page-info")).toHaveText("Page 2 of 2");
});

test("content for three pages: page boxes, the page count and editing keep working", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  await needLive(page);
  await expect(page.locator("#app")).toHaveAttribute("data-pdf", "ready", { timeout: 120_000 });

  // Sections typed into the YAML, after the last one.
  const block = (i: number) =>
    `\n  - title: Extra ${i}\n    layout: entries\n    entries:\n      - title: Company ${i}\n        date: 2020 - 2021\n        subtitle: Role ${i}\n        bullets:\n          - Built a system that handled a great many requests every single day.\n          - Wrote the documentation and trained the team that took it over.\n`;
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  for (let i = 0; i < 4; i++) await page.keyboard.insertText(block(i));

  // Sections and entries added on the page.
  for (let i = 0; i < 3; i++) {
    await live(page).getByRole("button", { name: "+ Add section" }).click();
    const form = live(page).getByRole("form", { name: "Add section" });
    await form.getByLabel("Section title").fill(`Page Section ${i}`);
    await form.getByText("Entries", { exact: true }).click();
    await form.getByRole("button", { name: "Add section" }).click();
    await expect(at(page, `sections.${14 + i}.title`)).toHaveText(`Page Section ${i}`);
    // The new section's entry is ready to type into.
    await expect(at(page, `sections.${14 + i}.entries.0.title`)).toHaveAttribute("data-editing", "");
    await page.keyboard.insertText(`Added on page ${i}`);
    await page.keyboard.press("Enter");
    await expect.poll(() => savedYaml(page)).toContain(`title: Added on page ${i}`);
  }

  await expect(page.locator("#app")).toHaveAttribute("data-pdf-pages", "3", { timeout: 60_000 });
  await expect(live(page)).toHaveAttribute("data-pages-from", "pdf");
  await expect(live(page)).toHaveAttribute("data-pages", "3");
  await expect(page.locator("#page-info")).toHaveText(/^Page \d of 3$/);
  // With nothing selected, page boxes keep letter height; TeX may shrink vertical glue to fit a page, which CSS cannot.
  await live(page).locator(".cv-page").first().click({ position: { x: 10, y: 10 } });
  await expect(live(page).locator(".cv-tools")).toHaveCount(0);
  for (const box of await pageBoxes(page)) {
    expect(box.height).toBeLessThanOrEqual(1056 * 1.06);
  }

  // Editing a value on the last page still updates the YAML and the page.
  const title = at(page, "sections.16.entries.0.title");
  await title.scrollIntoViewIfNeeded();
  await title.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("Added on page 2 and more");
  await page.keyboard.press("Enter");
  await expect.poll(() => savedYaml(page)).toContain("title: Added on page 2 and more");
  await expect(at(page, "sections.16.entries.0.title")).toHaveText("Added on page 2 and more");
  // And the YAML still drives the page.
  await page.locator(".cm-line", { hasText: "title: Extra 3" }).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" Renamed");
  await expect(at(page, "sections.13.title")).toHaveText("Extra 3 Renamed");
  await expect(live(page)).toHaveAttribute("data-pages", "3");
});
