// The YAML editor's selection: one colour on every line, over the active line, focused or not.
import { inflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { expect, openApp, test } from "./fixtures";

/** The grey level of one screen pixel (a 1x1 PNG: the first pixel needs no unfiltering). */
async function grey(page: Page, x: number, y: number): Promise<number> {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 }, scale: "css" });
  let at = 8;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return raw[1];
}

test("selected text is one colour on every line, over the active line, focused or not", async ({ page }) => {
  await openApp(page);
  await page.locator(".cm-line", { hasText: "name: John Doe" }).click();
  await page.keyboard.press("Home");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+End");
  const samples = async () => {
    const rects = await page.locator(".cm-selectionBackground").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
    expect(rects.length).toBeGreaterThanOrEqual(2);
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const right = Math.max(...rects.map((r) => r.right));
    const left = Math.min(...rects.map((r) => r.left));
    // Past the text on the first and middle lines, and in the line padding of the last one.
    return [await grey(page, right - 2, top + 3), await grey(page, right - 2, (top + bottom) / 2), await grey(page, left + 2, bottom - 3)];
  };
  expect(await samples(), "focused").toEqual([214, 214, 214]);
  // The active line shows past the selection's end on the cursor line.
  const line = (await page.locator(".cm-activeLineBg").boundingBox())!;
  expect(await grey(page, line.x + line.width - 4, line.y + line.height / 2)).toBe(242);
  await page.locator("#st-valid").click();
  await expect(page.locator(".cm-editor")).not.toHaveClass(/cm-focused/);
  expect(await samples(), "not focused").toEqual([214, 214, 214]);
});
