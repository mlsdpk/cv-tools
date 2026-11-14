// The editing tools never cover text or move it, and page boxes have the PDF's margins.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { at, expect, needLive, openApp, test } from "./fixtures";

/** Boxes of every line of text on the page, outside the editing tools. */
function textBoxes(page: Page): Promise<{ text: string; box: number[] }[]> {
  return page.evaluate(() => {
    const root = document.getElementById("live")!.shadowRoot!;
    const out: { text: string; box: number[] }[] = [];
    const walker = document.createTreeWalker(root.querySelector(".cv-document")!, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      if (!n.data.trim() || n.parentElement!.closest("[data-cv-ui]")) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width && r.height) out.push({ text: n.data.trim().slice(0, 30), box: [r.left, r.top, r.right, r.bottom] });
    }
    return out;
  });
}

const toolbarBox = (page: Page) => page.locator("#live .cv-tools").evaluate((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; });

const ENTRIES = ["sections.1.entries.0.title", "sections.0.entries.1.title", "sections.3.entries.1", "sections.6.entries.0.text", "sections.8.entries.0.text"];

for (const [name, viewport, layout] of [
  ["Split", { width: 1440, height: 900 }, "Split"],
  ["Paper", { width: 1440, height: 900 }, "Paper"],
  ["phone", { width: 390, height: 844 }, null],
] as const) {
  test(`${name}: the entry tools sit in their own row and cover no text`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openApp(page);
    await needLive(page);
    if (layout) await page.getByRole("button", { name: layout, exact: true }).click();
    for (const path of ENTRIES) {
      await at(page, path).click();
      await page.keyboard.press("Escape");
      await expect(page.locator("#live .cv-tools")).toBeVisible();
      const [l, t, r, b] = await toolbarBox(page);
      for (const { text, box } of await textBoxes(page)) {
        const overlaps = box[0] < r - 0.5 && box[2] > l + 0.5 && box[1] < b - 0.5 && box[3] > t + 0.5;
        expect(overlaps, `the tools of ${path} cover "${text}"`).toBe(false);
      }
    }
  });
}

test("with nothing selected, the editing tools change no line of the page", async ({ page }) => {
  await openApp(page);
  await needLive(page);
  await page.getByRole("button", { name: "Paper" }).click();
  // Select an entry, then leave it: nothing stays selected.
  await at(page, "sections.1.entries.0.title").click();
  await page.keyboard.press("Escape");
  await page.locator("#live .cv-page").first().click({ position: { x: 10, y: 10 } });
  await expect(page.locator("#live .cv-tools")).toHaveCount(0);
  // Hover a section and focus its "+ Add entry": both show it without moving anything.
  await page.locator('#live [data-section="sections.2"]').hover();
  await expect(page.locator('#live [data-section="sections.2"] > .cv-add-entry')).toHaveCSS("opacity", "1");
  await expect(page.locator('#live [data-section="sections.5"] > .cv-add-entry')).toHaveCSS("opacity", "0");
  const editable = await textBoxes(page);
  const plain = await page.evaluate(() => {
    const host = document.getElementById("live")!;
    host.classList.remove("cv-editable");
    host.shadowRoot!.querySelectorAll("[data-cv-ui]").forEach((e) => e.remove());
  }).then(() => textBoxes(page));
  expect(editable.length).toBe(plain.length);
  editable.forEach((e, i) => {
    for (let k = 0; k < 4; k++) expect(Math.abs(e.box[k] - plain[i].box[k]), `"${e.text}" moved`).toBeLessThanOrEqual(1);
  });
});

test("every page box starts its first line where the PDF does", async ({ page }) => {
  test.setTimeout(150_000);
  await openApp(page);
  await needLive(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  for (let i = 0; i < 6; i++) {
    await page.keyboard.insertText(`\n  - title: Extra ${i}\n    layout: list\n    entries:\n      - One item of this extra section, long enough to wrap onto a second line of the page.\n      - Another item.\n      - A third item.\n`);
  }
  await expect(page.locator("#app")).toHaveAttribute("data-pdf-pages", "3", { timeout: 60_000 });
  await expect(page.locator("#live")).toHaveAttribute("data-pages-from", "pdf");
  await page.getByRole("button", { name: "Paper" }).click();

  // The baseline of each page's first line, in CSS pixels from the top of the page box.
  const html = await page.evaluate(() => {
    const root = document.getElementById("live")!.shadowRoot!;
    return [...root.querySelectorAll<HTMLElement>(".cv-document > .cv-page")].map((p) => {
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let n = walker.nextNode() as Text | null;
      while (n && (!n.data.trim() || n.parentElement!.closest("[data-cv-ui]"))) n = walker.nextNode() as Text | null;
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
      n!.before(probe);
      const scale = p.getBoundingClientRect().width / p.offsetWidth;
      const y = (probe.getBoundingClientRect().top - p.getBoundingClientRect().top) / scale;
      probe.remove();
      return y;
    });
  });

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF" }).click();
  const pdf = readFileSync((await (await download).path())!);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(pdf) }).promise;
  const tex: number[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const items = (await p.getTextContent()).items.filter((it) => "str" in it && it.str.trim()) as { transform: number[] }[];
    tex.push(((p.view[3] - items[0].transform[5]) * 96) / 72);
  }
  expect(html.length).toBe(tex.length);
  html.forEach((y, i) => expect(Math.abs(y - tex[i]), `page ${i + 1}: HTML ${y.toFixed(1)} px, PDF ${tex[i].toFixed(1)} px`).toBeLessThanOrEqual(2));
});

// iOS WebKit lays out text wrongly under CSS zoom (desktop engines do not show it), so the page is scaled with a transform.
test("phone: the page is scaled with a transform and its box takes the scaled size", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await needLive(page);
  await expect(page.locator("#live .cv-page").first()).toBeVisible();
  const measure = () =>
    page.evaluate(() => {
      const host = document.getElementById("live")!;
      const root = host.shadowRoot!;
      const zoomed = [document.documentElement, ...document.querySelectorAll("*"), ...root.querySelectorAll("*")]
        .filter((e) => getComputedStyle(e).zoom !== "1")
        .map((e) => `${e.tagName.toLowerCase()}.${e.className}`);
      const text = root.querySelector<HTMLElement>('[data-path="sections.1.entries.0.title"]')!;
      const pages = [...root.querySelectorAll<HTMLElement>(".cv-document > .cv-page")];
      const first = pages[0].getBoundingClientRect();
      const last = pages.at(-1)!.getBoundingClientRect();
      const box = host.getBoundingClientRect();
      const scroller = document.getElementById("preview-scroll")!;
      return {
        zoomed,
        scale: first.width / pages[0].offsetWidth,
        text: { screen: text.getBoundingClientRect().height, layout: text.offsetHeight },
        box: { left: box.left, top: box.top, width: box.width, height: box.height },
        pages: { left: first.left, top: first.top, width: first.width, height: last.bottom - first.top },
        overflow: [document.documentElement.scrollWidth - document.documentElement.clientWidth, scroller.scrollWidth - scroller.clientWidth],
      };
    });
  const check = async (step: string) => {
    const m = await measure();
    expect(m.zoomed, step).toEqual([]);
    expect(m.scale, step).toBeLessThan(0.6);
    // offsetHeight is rounded to a whole layout pixel.
    expect(Math.abs(m.text.screen - m.text.layout * m.scale), step).toBeLessThan(m.scale);
    for (const k of ["left", "top", "width", "height"] as const) expect(Math.abs(m.box[k] - m.pages[k]), `${step}: ${k}`).toBeLessThan(1);
    expect(m.overflow, step).toEqual([0, 0]);
  };
  await check("on load");
  // Selecting an entry adds its tools and makes the page taller.
  await at(page, "sections.1.entries.0.title").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#live .cv-tools")).toBeVisible();
  await check("with an entry selected");
  // Scrolled to the end, the last page ends one padding above the bottom of the view.
  const gap = await page.locator("#preview-scroll").evaluate((s) => {
    s.scrollTo(0, s.scrollHeight);
    const pages = document.getElementById("live")!.shadowRoot!.querySelectorAll(".cv-document > .cv-page");
    return s.getBoundingClientRect().top + s.clientTop + s.clientHeight - pages[pages.length - 1].getBoundingClientRect().bottom - parseFloat(getComputedStyle(s).paddingBottom);
  });
  expect(Math.abs(gap)).toBeLessThan(1);
});
