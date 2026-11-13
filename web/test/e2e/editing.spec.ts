// Editing text on the page keeps the layout: only an underline and the caret appear.
import type { Page } from "@playwright/test";
import { at, expect, needLive, openApp, paper, savedYaml, test } from "./fixtures";

/** Every value's box on the page. */
function boxes(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(() => {
    const out: Record<string, number[]> = {};
    for (const el of document.getElementById("live")!.shadowRoot!.querySelectorAll<HTMLElement>("[data-path]")) {
      const r = el.getBoundingClientRect();
      out[el.dataset.path!] = [r.left, r.top, r.width, r.height];
    }
    return out;
  });
}

/** The viewport position of character `i` of a value (its left edge, mid height). */
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

const FIELDS: [string, string, number][] = [
  // path, raw value, character clicked
  ["name", "John Doe", 2],
  ["sections.1.title", "Professional Experience", 5],
  ["sections.1.entries.0.date", "July 2024 - Present", 6],
  ["sections.1.entries.0.title", "Tech Innovations Inc.", 7],
  ["sections.2.entries.0.note", "Supervisor: Dr. Eve Code", 12],
  ["sections.1.entries.0.bullets.1", "Led a team of developers in designing scalable software architectures.", 30],
  ["sections.0.entries.1.details.0", "Supervisor: Dr. Bob Builder", 4],
  ["sections.6.entries.1.text", "Python, Java, C++, SQL, JavaScript", 9],
  ["sections.8.entries.0.date", "Nov. 2023", 1],
  ["sections.3.entries.1", "Best Paper Award at Tech Innovations Conference (2023)", 11],
  ["contact.1.0", "johndoe@email.com", 4],
];

for (const layout of ["Paper", "Split"]) {
  test(`${layout}: editing keeps every value in place and types at the click`, async ({ page }) => {
    test.setTimeout(180_000);
    await openApp(page);
    await needLive(page);
    if (layout === "Paper") await paper(page);
    await expect(page.locator("#app")).toHaveAttribute("data-pdf", "ready", { timeout: 120_000 });
    for (const [path, raw, i] of FIELDS) {
      const el = at(page, path);
      await el.scrollIntoViewIfNeeded();
      // Selecting an entry shows its placeholders; editing must not move anything after that.
      await el.click();
      await page.keyboard.press("Escape");
      await expect(page.locator("#live [data-editing]")).toHaveCount(0);
      // The selection's page split runs once the press is over.
      await page.waitForTimeout(50);
      const before = await boxes(page);
      const { x, y } = await charAt(page, path, i);
      await page.mouse.click(x, y);
      await expect(el).toHaveAttribute("data-editing", "");
      await expect(el).toHaveCSS("text-decoration-line", "underline");
      const during = await boxes(page);
      for (const [p, b] of Object.entries(before)) {
        const d = during[p];
        if (p === path && path === "sections.8.entries.0.date") {
          // The month and year columns become one line of text; the box stays.
          expect(Math.abs(d[0] - b[0]), p).toBeLessThanOrEqual(1);
          expect(Math.abs(d[1] - b[1]), p).toBeLessThanOrEqual(1);
          continue;
        }
        for (let k = 0; k < 4; k++) expect(Math.abs(d[k] - b[k]), `${p} moved while editing ${path}`).toBeLessThanOrEqual(1);
      }
      const caret = await page.evaluate(() => {
        const root = document.getElementById("live")!.shadowRoot!;
        const sel = document.getSelection()!;
        // A bullet or a heading is edited through a span inside it.
        return { focused: (root.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-path]")?.dataset.path, collapsed: sel.rangeCount === 1 && sel.getRangeAt(0).collapsed };
      });
      expect(caret).toEqual({ focused: path, collapsed: true });
      await page.keyboard.insertText("X");
      await page.keyboard.press("Enter");
      // Enter in a bullet or list entry starts the next one; Enter again leaves it.
      if (/bullets|sections\.3\.entries/.test(path)) await page.keyboard.press("Enter");
      await expect.poll(() => savedYaml(page), { message: path }).toContain(raw.slice(0, i) + "X" + raw.slice(i));
      await expect(page.locator("#live [data-editing]")).toHaveCount(0);
    }
  });
}

test("Split: a value clicked on the page is edited there and selected in the YAML", async ({ page }) => {
  await openApp(page);
  await needLive(page);
  const date = at(page, "sections.0.entries.0.date");
  await date.click();
  await expect(date).toHaveAttribute("data-editing", "");
  await expect(page.locator("#st-path")).toHaveText("sections[0].entries[0].date");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("2021 - 2024");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-content")).toContainText("date: 2021 - 2024");
  await expect.poll(() => savedYaml(page)).toContain("        date: 2021 - 2024\n");
});
