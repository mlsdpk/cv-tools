// One tab edits (it holds the writer lock); other tabs are read-only and follow its saves.
import { readFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, openApp, replaceLine, savedYaml, seed, test } from "./fixtures";

const CV1 = readFileSync(new URL("./data/cv1.yaml", import.meta.url), "utf8");

const writer = (p: Page) => expect(p.locator("#app")).toHaveAttribute("data-writer", "true", { timeout: 15_000 });
const reader = (p: Page) => expect(p.locator("#app")).toHaveAttribute("data-writer", "false", { timeout: 15_000 });

async function tab(context: BrowserContext, first = false) {
  const p = await context.newPage();
  if (first) await seed(p, { "cv.yaml": CV1 });
  await openApp(p);
  return p;
}

async function readOnlyBar(p: Page) {
  await expect(p.locator("#lock-bar")).toBeVisible();
  await expect(p.locator("#lock-bar")).toHaveText(/This CV is open in another tab\.\s*Use here/);
}

test("a second tab opens read-only and follows the tab that edits", async ({ context }) => {
  const a = await tab(context, true);
  const b = await tab(context);
  await writer(a);
  await reader(b);
  await readOnlyBar(b);
  await expect(a.locator("#lock-bar")).toBeHidden();
  await expect(b.locator("#file-state")).toContainText("read-only");
  // Typing in the read-only tab changes nothing.
  await b.bringToFront();
  await b.locator(".cm-line", { hasText: "name: Jane Doe" }).click();
  await b.keyboard.insertText("XYZ");
  await expect(b.locator(".cm-content")).not.toContainText("XYZ");
  await a.bringToFront();
  await replaceLine(a, "name: Jane Doe", "name: Edited In A");
  await expect.poll(() => savedYaml(a)).toContain("Edited In A");
  await expect(b.locator(".cm-content")).toContainText("name: Edited In A");
});

test("Use here moves editing to the other tab and back, keeping what was just typed", async ({ context }) => {
  const a = await tab(context, true);
  const b = await tab(context);
  await reader(b);
  await a.bringToFront();
  // Still inside the save delay when B asks for the lock.
  await replaceLine(a, "name: Jane Doe", "name: Typed Last In A");
  await b.locator("#use-here").click();
  await writer(b);
  await reader(a);
  await readOnlyBar(a);
  await expect(b.locator(".cm-content")).toContainText("name: Typed Last In A");
  await b.bringToFront();
  await replaceLine(b, "name: Typed Last In A", "name: Now In B");
  await expect.poll(() => savedYaml(b)).toContain("Now In B");
  await expect(a.locator(".cm-content")).toContainText("name: Now In B");
  await a.locator("#use-here").click();
  await writer(a);
  await reader(b);
  await a.bringToFront();
  await replaceLine(a, "name: Now In B", "name: Back In A");
  await expect.poll(() => savedYaml(a)).toContain("Back In A");
  await expect(b.locator(".cm-content")).toContainText("name: Back In A");
});

test("closing the editing tab lets another tab take over", async ({ context }) => {
  const a = await tab(context, true);
  const b = await tab(context);
  await reader(b);
  await a.close();
  await writer(b);
  await expect(b.locator("#lock-bar")).toBeHidden();
  await replaceLine(b, "name: Jane Doe", "name: After A Closed");
  await expect.poll(() => savedYaml(b)).toContain("After A Closed");
});

test("three tabs: one edits, the others follow, and Use here picks the editor", async ({ context }) => {
  const a = await tab(context, true);
  const b = await tab(context);
  const c = await tab(context);
  await writer(a);
  await reader(b);
  await reader(c);
  await c.locator("#use-here").click();
  await writer(c);
  await reader(a);
  await reader(b);
  await c.bringToFront();
  await replaceLine(c, "name: Jane Doe", "name: Edited In C");
  for (const p of [a, b]) await expect(p.locator(".cm-content")).toContainText("name: Edited In C");
  await c.close();
  await expect.poll(async () => (await Promise.all([a, b].map((p) => p.locator("#app").getAttribute("data-writer")))).sort().join()).toBe("false,true");
});

test("a crashed tab releases the lock", async ({ context, browserName }) => {
  test.skip(browserName !== "chromium", "only Chromium can crash a page on purpose");
  const a = await tab(context, true);
  const b = await tab(context);
  await reader(b);
  const cdp = await context.newCDPSession(a);
  void cdp.send("Page.crash").catch(() => {});
  await writer(b);
  await replaceLine(b, "name: Jane Doe", "name: After A Crashed");
  await expect.poll(() => savedYaml(b)).toContain("After A Crashed");
});

test.describe("without Web Locks", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "locks", { get: () => undefined });
    });
  });

  test("a lease in localStorage gives the same single writer", async ({ context }) => {
    const a = await tab(context, true);
    const b = await tab(context);
    await writer(a);
    await reader(b);
    await replaceLine(a, "name: Jane Doe", "name: Lease A");
    await expect(b.locator(".cm-content")).toContainText("name: Lease A");
    await b.locator("#use-here").click();
    await writer(b);
    await reader(a);
    await b.close();
    await writer(a);
  });
});
