// YAML anchors and aliases on the page (web-spec 4.3).
import { readFileSync } from "node:fs";
import { expect, needLive, openApp, paper, savedYaml, seed, test } from "./fixtures";

const CV1 = readFileSync(new URL("./data/cv1.yaml", import.meta.url), "utf8");

test.beforeEach(async ({ page }) => {
  await seed(page, { "cv.yaml": CV1 });
  await openApp(page);
  await needLive(page);
  await paper(page);
});

test("a value through an alias is read-only, with a hint to edit it in the YAML", async ({ page }) => {
  const via = page.locator('#live [data-via-alias="t"]');
  await expect(via).toHaveCount(1);
  await expect(via).not.toHaveAttribute("data-path", /.*/);
  await expect(via).toHaveAttribute("title", /YAML alias/);
  await via.click();
  await expect(page.locator("#live [data-editing]")).toHaveCount(0);
  await expect(page.locator("#notice")).toContainText("Defined through a YAML alias");
});

test("editing the anchored value highlights its aliases and says how many places changed", async ({ page }) => {
  const anchored = page.locator('#live [data-anchor="t"]');
  await anchored.click();
  await expect(anchored).toHaveAttribute("data-editing", "");
  await expect(page.locator('#live [data-via-alias="t"]')).toHaveClass(/cv-alias-peer/);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("Talk renamed");
  await page.keyboard.press("Enter");
  await expect(page.locator("#notice")).toContainText("Also changed 1 other place");
  await expect.poll(() => savedYaml(page)).toContain("        text: &t Talk renamed\n");
  expect(await savedYaml(page)).toContain("        text: *t\n");
  await expect(page.locator('#live [data-via-alias="t"]')).toHaveText("Talk renamed");
  await expect(page.locator(".cv-alias-peer")).toHaveCount(0);
});

test.describe("the aliases fixture of cv-tools", () => {
  const FIXTURE = new URL("../../../tests/fixtures/aliases/", import.meta.url).pathname;
  test.use({});
  test("aliased items keep their handles, aliased content is read-only, and reused entries stay put", async ({ page }) => {
    await page.evaluate(
      (f) => localStorage.setItem("cv-tools:workspace", JSON.stringify({ format: 2, files: f, savedAt: 2 })),
      { "cv.yaml": readFileSync(FIXTURE + "cv.yaml", "utf8"), "publications.bib": readFileSync(FIXTURE + "publications.bib", "utf8") },
    );
    await page.reload();
    await expect(page.locator("#app")).toHaveAttribute("data-live", "ready", { timeout: 60_000 });
    await paper(page);
    // `- *base` is an item of its own: it keeps data-entry and gets data-via-alias.
    const aliasItem = page.locator('#live [data-entry="sections.0.entries.2"]');
    await expect(aliasItem).toHaveAttribute("data-via-alias", "base");
    await expect(aliasItem.locator("[data-path]")).toHaveCount(0);
    // The section reused through *sec has no structural attributes on its entries.
    await expect(page.locator('#live [data-via-alias="sec"][data-entry]')).toHaveCount(0);
    // Every editable element outside aliased content has a path; nothing aliased is editable.
    const bad = await page.evaluate(() =>
      [...document.getElementById("live")!.shadowRoot!.querySelectorAll("[data-via-alias] [data-cv-edit], [data-via-alias][data-cv-edit]")].length,
    );
    expect(bad).toBe(0);
    // An entry that other places reuse is neither deleted nor moved.
    const yaml = await savedYaml(page);
    const refusal = "This entry is reused elsewhere through &base. Edit the YAML to change it.";
    const tools = page.locator("#live .cv-tools");
    await page.locator('#live [data-path="sections.0.entries.0.title"]').click();
    await page.keyboard.press("Escape");
    await tools.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("#notice")).toContainText(refusal);
    await expect(page.locator("#notice").getByRole("button", { name: "Delete anyway" })).toHaveCount(0);
    await tools.getByRole("button", { name: "Move down" }).click();
    await expect(page.locator("#notice")).toContainText(refusal);
    await page.waitForTimeout(500);
    expect(await savedYaml(page)).toBe(yaml);
    // Moving the alias item is safe and happens at once.
    await aliasItem.click();
    await tools.getByRole("button", { name: "Move up" }).click();
    await expect.poll(async () => (await savedYaml(page)).indexOf("      - *base\n") < (await savedYaml(page)).indexOf("      - <<: *base")).toBe(true);
    // Editing the anchored title counts its two copies (the merge and the alias item), not every aliased value.
    await page.locator('#live [data-path="sections.0.entries.0.title"]').click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText("Base renamed");
    await page.keyboard.press("Enter");
    await expect(page.locator("#notice")).toContainText("Also changed 2 other places");
  });
});
