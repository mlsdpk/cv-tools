import { expect, openApp, test, waitReady } from "./fixtures";

test("switches between Split, Paper and YAML", async ({ page }) => {
  await openApp(page);
  const editor = page.locator("#editor-pane");
  const preview = page.locator("#preview-pane");
  await expect(editor).toBeVisible();
  await expect(preview).toBeVisible();
  await expect(page.getByRole("button", { name: "Split" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Paper" }).click();
  await expect(editor).toBeHidden();
  await expect(preview).toBeVisible();
  await expect(page.locator("#status")).toBeHidden();
  await expect(page.locator("#paper-hint")).toBeVisible();
  await expect(page.locator("#page-info")).toHaveText(/^Page 1 of \d$/);

  await page.getByRole("button", { name: "YAML", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(preview).toBeHidden();
  await expect(page.locator("#status")).toBeVisible();

  // The layout is remembered.
  await page.reload();
  await waitReady(page);
  await expect(page.getByRole("button", { name: "YAML", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(preview).toBeHidden();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("shows YAML and CV tabs and icon buttons", async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole("button", { name: "New or open" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Download", exact: true })).toBeVisible();
    await expect(page.locator("#layout-switch")).toBeHidden();
    const cvTab = page.getByRole("tab", { name: "CV" });
    await expect(cvTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#preview-pane")).toBeVisible();
    await expect(page.locator("#editor-pane")).toBeHidden();
    await page.getByRole("tab", { name: "YAML" }).click();
    await expect(page.locator("#editor-pane")).toBeVisible();
    await expect(page.locator("#preview-pane")).toBeHidden();
    // Nothing is wider than the screen.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await expect(page.getByRole("menu", { name: "Downloads" })).toBeVisible();
  });
});
