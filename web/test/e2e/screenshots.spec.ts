// Screenshots for a visual check (test/screenshots/, gitignored).
import { expect, liveAvailable, openApp, test } from "./fixtures";

const OUT = "test/screenshots";

test.describe("screenshots", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "one browser is enough");

  test("desktop layouts", async ({ page }) => {
    await openApp(page);
    await liveAvailable(page);
    await expect(page.locator("#app")).toHaveAttribute("data-pdf", "ready", { timeout: 60_000 });
    // Split, editing a date on the page.
    await page.locator('#live [data-path="sections.1.entries.0.date"]').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/split.png` });
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Other downloads" }).click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/download-menu.png` });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "New / Open" }).click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/open-menu.png` });
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Paper" }).click();
    await page.locator('#live [data-path="sections.1.entries.0.date"]').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/paper.png` });
    await page.keyboard.press("Escape");
    // A new entry with its title being typed, and a selected section.
    await page.locator('#live [data-section="sections.1"] .cv-add-entry').click();
    await page.keyboard.type("New Co");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/new-entry.png` });
    await page.keyboard.press("Escape");
    await page.locator('#live [data-path="sections.3.title"]').click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/section-selected.png` });
    await page.locator("#live").getByRole("button", { name: "+ Add section" }).click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/add-section.png` });
    await page.keyboard.press("Escape");

    // An invalid edit on the page: the status line under the hint.
    await page.locator('#live [data-path="sections.1.entries.1.subtitle"]').click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText("Robotics Engineer 😀");
    await page.keyboard.press("Enter");
    await expect(page.locator("#paper-status")).toBeVisible();
    await page.screenshot({ path: `${OUT}/paper-error.png` });
    await page.locator("#paper-status").getByRole("button", { name: "Undo" }).click();

    await page.getByRole("button", { name: "New / Open" }).click();
    await page.getByRole("menuitem", { name: "New, minimal" }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/confirm.png` });
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "YAML", exact: true }).click();
    await page.locator(".cm-content").focus();
    await page.keyboard.press("ControlOrMeta+Home");
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowDown");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/yaml.png` });
  });

  test("a three-page CV", async ({ page }) => {
    await openApp(page);
    await liveAvailable(page);
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    for (let i = 0; i < 6; i++) {
      await page.keyboard.insertText(`\n  - title: Extra ${i}\n    layout: list\n    entries:\n      - One item of this extra section, long enough to wrap onto a second line of the page.\n      - Another item.\n      - A third item.\n`);
    }
    await expect(page.locator("#app")).toHaveAttribute("data-pdf-pages", "3", { timeout: 60_000 });
    await page.getByRole("button", { name: "Paper" }).click();
    await page.locator("#live").evaluate((h) => h.shadowRoot!.querySelectorAll(".cv-page")[1].scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/three-pages.png` });
    await page.setViewportSize({ width: 1440, height: 3600 });
    await page.getByRole("button", { name: "Split" }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/three-pages-split.png` });
  });

  test.describe("phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    test("phone layouts", async ({ page }) => {
      await openApp(page);
      await liveAvailable(page);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/phone-cv.png` });
      await page.getByRole("tab", { name: "YAML" }).click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}/phone-yaml.png` });
    });
  });
});
