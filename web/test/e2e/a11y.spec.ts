// Accessibility: axe-core in every layout, keyboard and touch.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "@playwright/test";
import { at, expect, liveAvailable, needLive, openApp, paper, replaceLine, test } from "./fixtures";

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

/** axe-core's violations on the page as it is (evaluated through the debugger, so the CSP does not block it). */
async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  const violations = await page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; nodes: { target: unknown }[] }[] }> } }).axe.run(document, {
      resultTypes: ["violations"],
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => JSON.stringify(n.target)).join(" ")}`);
  });
  return violations;
}

test.describe("axe-core finds no violation", () => {
  test("desktop layouts, the menus, the confirm dialog, the entry tools and the About page", async ({ page }) => {
    await openApp(page);
    await liveAvailable(page);
    await expect(page.locator("#app")).toHaveAttribute("data-pdf", "ready", { timeout: 90_000 });
    expect(await axe(page), "Split").toEqual([]);
    await page.getByRole("button", { name: "Other downloads" }).click();
    expect(await axe(page), "download menu").toEqual([]);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "New / Open" }).click();
    expect(await axe(page), "New / Open menu").toEqual([]);
    await page.keyboard.press("Escape");
    await replaceLine(page, "name: John Doe", "name: Jane Doe");
    await page.getByRole("button", { name: "New / Open" }).click();
    await page.getByRole("menuitem", { name: "New, minimal" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await axe(page), "confirm dialog").toEqual([]);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await paper(page);
    await at(page, "sections.1.entries.0.title").click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#live").getByRole("toolbar", { name: "Entry actions" })).toBeVisible();
    // Editing an icon link and leaving it keeps its name ("ORCID iD").
    await at(page, "contact.0.1.orcid").focus();
    await page.keyboard.press("Escape");
    await expect(at(page, "contact.0.1.orcid")).toHaveAttribute("aria-label", "ORCID iD");
    await at(page, "sections.1.entries.0.title").click();
    await page.keyboard.press("Escape");
    expect(await axe(page), "Paper, an entry selected").toEqual([]);
    await at(page, "sections.1.entries.0.bullets.0").click();
    await expect(at(page, "sections.1.entries.0.bullets.0")).toHaveAttribute("data-editing", "");
    expect(await axe(page), "Paper, a bullet being edited").toEqual([]);
    await page.keyboard.press("Escape");
    await page.locator("#live").getByRole("button", { name: "+ Add section" }).click();
    expect(await axe(page), "Add section").toEqual([]);
    await page.getByRole("button", { name: "YAML", exact: true }).click();
    expect(await axe(page), "YAML").toEqual([]);
    await page.goto("about.html");
    await expect(page.locator("table").first()).toBeVisible();
    expect(await axe(page), "About").toEqual([]);
  });

  test.describe("phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    test("CV and YAML tabs", async ({ page, browserName }) => {
      test.skip(browserName === "webkit", "isMobile is not supported in WebKit desktop");
      await openApp(page);
      await liveAvailable(page);
      expect(await axe(page), "phone CV").toEqual([]);
      await page.getByRole("tab", { name: "YAML", exact: true }).click();
      expect(await axe(page), "phone YAML").toEqual([]);
    });
  });
});

test("phone tabs and file tabs move with the arrow keys and keep focus", async ({ page }) => {
  await openApp(page);
  const files = page.locator("#file-tabs [role=tab]");
  await files.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#file-tabs [aria-selected=true]")).toHaveText("publications.bib");
  await expect(page.locator("#file-tabs [role=tab][aria-selected=true]")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#file-tabs [role=tab][aria-selected=true]")).toBeFocused();
  await expect(page.locator("#file-tabs [aria-selected=true]")).toHaveText("cv.yaml");
  await page.keyboard.press("End");
  await expect(page.locator("#file-tabs [aria-selected=true]")).toHaveText("publications.bib");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#app")).toHaveAttribute("data-phone", "true");
  await expect(page.getByRole("navigation", { name: "View" }).getByRole("tab")).toHaveCount(2);
  await page.getByRole("tab", { name: "CV", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "YAML", exact: true })).toBeFocused();
  await expect(page.getByRole("tab", { name: "YAML", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#editor-pane")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "CV", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("the confirm dialog gives focus back to its opener after Cancel and Escape", async ({ page }) => {
  await openApp(page);
  await replaceLine(page, "name: John Doe", "name: Jane Doe");
  const menu = page.getByRole("button", { name: "New / Open" });
  const open = async () => {
    await menu.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "New from example" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#replace")).toHaveAttribute("open", "");
    await expect(page.getByRole("button", { name: "Replace" })).toBeFocused();
  };
  await open();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await open();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(menu).toBeFocused();
  await expect(page.locator(".cm-content")).toContainText("name: Jane Doe");
});

test("the editor shows focus and says how to leave it", async ({ page }) => {
  await openApp(page);
  await page.locator(".cm-content").click();
  const outline = await page.locator(".cm-editor").evaluate((e) => getComputedStyle(e).outlineStyle);
  expect(outline).toBe("solid");
  const help = await page.locator(".cm-content").getAttribute("aria-describedby");
  await expect(page.locator(`#${help}`)).toContainText("press Escape, then Tab");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await expect(page.locator(".cm-content")).not.toBeFocused();
});

test.describe("Paper by keyboard", () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await needLive(page);
    await paper(page);
  });

  test("the entry tools come right before the entry's text in Tab order, and Delete moves focus to the next entry", async ({ page, browserName }) => {
    const entry = page.locator('#live [data-entry="sections.1.entries.0"]');
    await entry.locator("[data-path]").first().focus();
    await page.keyboard.press("Escape");
    expect(await entry.evaluate((e) => e.firstElementChild!.className)).toBe("cv-tools");
    const next = await page.locator('#live [data-entry="sections.1.entries.1"] [data-path$=".title"]').textContent();
    const tools = page.locator("#live").getByRole("toolbar", { name: "Entry actions" });
    if (browserName === "chromium") {
      // WebKit on macOS does not move focus to buttons with Tab by default.
      await page.keyboard.press("Shift+Tab");
    } else {
      await tools.getByRole("button", { name: "Delete" }).focus();
    }
    await expect(tools.getByRole("button", { name: "Delete" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => (document.getElementById("live")!.shadowRoot!.activeElement as HTMLElement | null)?.dataset.path)).toBe("sections.1.entries.0.title");
    await expect(page.locator('#live [data-entry="sections.1.entries.0"] [data-path$=".title"]')).toHaveText(next!);
  });

  test("Escape cancels Add section", async ({ page }) => {
    await page.getByRole("button", { name: "+ Add section" }).click();
    await expect(page.getByLabel("Section title")).toBeFocused();
    await page.getByRole("radio", { name: /List/ }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("radio", { name: /^Entries · jobs/ })).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "+ Add section" })).toBeFocused();
    await expect(page.getByRole("form", { name: "Add section" })).toHaveCount(0);
  });
});

test.describe("touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  test("entry tools and file tabs are at least 44 px on a phone, and the hint sits above the page", async ({ page, browserName }) => {
    test.skip(browserName === "webkit", "isMobile is not supported in WebKit desktop");
    await openApp(page);
    await needLive(page);
    await expect(page.locator("#paper-hint")).toHaveText("Tap any text to edit it");
    const hint = (await page.locator("#paper-hint").boundingBox())!;
    const pageBox = (await page.locator("#live").boundingBox())!;
    expect(hint.y).toBeLessThan(pageBox.y);
    await at(page, "sections.1.entries.1.title").tap();
    await expect(page.locator("#live .cv-tools")).toBeVisible();
    for (const name of ["Move up", "Move down", "Add entry below", "Delete"]) {
      const box = (await page.locator("#live .cv-tools").getByRole("button", { name }).boundingBox())!;
      expect(box.width, String(name)).toBeGreaterThanOrEqual(43.5);
      expect(box.height, String(name)).toBeGreaterThanOrEqual(43.5);
    }
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "YAML", exact: true }).tap();
    expect((await page.locator("#file-tabs [role=tab]").first().boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  });
});
