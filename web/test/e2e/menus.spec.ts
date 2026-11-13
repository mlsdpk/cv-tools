// The top bar: New / Open, downloads, the confirm before replacing a CV with Undo, and the links.
import { readFileSync } from "node:fs";
import { expect, openApp, replaceLine, savedYaml, test, waitReady } from "./fixtures";

const SITE = JSON.parse(readFileSync(new URL("../../site.config.json", import.meta.url), "utf8")) as { repository: string; coffee: string | null };

test("the menus have short items, open from the keyboard and close with Escape", async ({ page }) => {
  await openApp(page);
  for (const [button, menu, items] of [
    ["Other downloads", "Downloads", ["PDF", "LaTeX for Overleaf", "YAML", "Copy share link"]],
    ["New / Open", "New or open", ["New, minimal", "New from example", "Open file…"]],
  ] as const) {
    const trigger = page.getByRole("button", { name: button });
    await trigger.click();
    const m = page.getByRole("menu", { name: menu });
    await expect(m).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(m.getByRole("menuitem")).toHaveText([...items]);
    await expect(m.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(m.getByRole("menuitem").nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(m).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  await expect(page.getByText("pdfLaTeX in your browser")).toHaveCount(0);
});

test("the GitHub and coffee links open in a new tab", async ({ page }) => {
  await openApp(page);
  const github = page.getByRole("link", { name: "cv-tools on GitHub" });
  await expect(github).toHaveAttribute("href", `https://github.com/${SITE.repository}`);
  const coffee = page.getByRole("link", { name: "Buy me a coffee" });
  if (SITE.coffee) await expect(coffee).toHaveAttribute("href", SITE.coffee);
  else await expect(coffee).toBeHidden();
  for (const link of SITE.coffee ? [github, coffee] : [github]) {
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
});

test("replacing a CV asks first, can download the current one, and Undo brings it back after a reload", async ({ page }) => {
  await openApp(page);
  await replaceLine(page, "name: John Doe", "name: My Own Work");
  await expect.poll(() => savedYaml(page)).toContain("My Own Work");
  const dialog = page.getByRole("dialog", { name: "Replace the current CV?" });
  const newMinimal = async () => {
    await page.getByRole("button", { name: "New / Open" }).click();
    await page.getByRole("menuitem", { name: "New, minimal" }).click();
    await expect(dialog).toBeVisible();
  };

  await newMinimal();
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download current CV" }).click();
  expect((await download).suggestedFilename()).toBe("cv.zip");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await savedYaml(page)).toContain("My Own Work");

  await newMinimal();
  await dialog.getByRole("button", { name: "Replace" }).click();
  await expect.poll(() => savedYaml(page)).toContain("name: Your Name");
  await expect(page.locator("#notice")).toContainText("Started a new CV.");

  // The undo snapshot survives a reload, and Undo swaps the two CVs.
  await page.reload();
  await waitReady(page);
  await expect(page.locator(".cm-content")).toContainText("name: Your Name");
  await page.locator("#notice").getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => savedYaml(page)).toContain("My Own Work");
  await expect(page.locator("#notice")).toContainText("Restored the previous CV.");
  await page.locator("#notice").getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => savedYaml(page)).toContain("name: Your Name");

  // Dismissed, the offer does not come back after a reload.
  await page.locator("#notice").getByRole("button", { name: "Dismiss" }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("cv-tools:undo")!).offer)).toBe(false);
  await page.reload();
  await waitReady(page);
  await expect(page.locator("#notice")).toBeHidden();

  // New from example asks too.
  await page.getByRole("button", { name: "New / Open" }).click();
  await page.getByRole("menuitem", { name: "New from example" }).click();
  await dialog.getByRole("button", { name: "Replace" }).click();
  await expect.poll(() => savedYaml(page)).toContain("name: John Doe");
});
