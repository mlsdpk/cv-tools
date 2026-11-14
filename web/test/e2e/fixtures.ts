import { expect, test as base, type Page } from "@playwright/test";

// WebKit reports a same-origin request cancelled by a reload as an access control failure.
const CANCELLED_BY_RELOAD = /(?:^|\/)127\.0\.0\.1:\d+\/\S* due to access control checks\.$/;

/** Every test fails on a console error or an uncaught exception; `allowConsole` lists expected ones. */
export const test = base.extend<{ consoleErrors: string[]; allowConsole: RegExp[] }>({
  allowConsole: [[], { option: true }],
  consoleErrors: [
    async ({ page, allowConsole }, use) => {
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error" && !CANCELLED_BY_RELOAD.test(m.text()) && !allowConsole.some((r) => r.test(m.text()))) errors.push(`${m.text()} (${m.location().url}:${m.location().lineNumber})`);
      });
      page.on("pageerror", (e) => {
        if (!CANCELLED_BY_RELOAD.test(e.message)) errors.push(`pageerror: ${e.message}`);
      });
      await use(errors);
      expect(errors, "console errors").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export async function openApp(page: Page, path = "./") {
  await page.goto(path);
  await waitReady(page);
}

/** Wait until cv-tools has validated the CV. A stub engine build fails unless CV_E2E_ALLOW_STUB=1. */
export async function waitReady(page: Page) {
  await expect(page.locator("#app")).toHaveAttribute("data-py", "ready", { timeout: 60_000 });
  await expect(page.locator("#app")).toHaveAttribute("data-valid", /valid|invalid|v1/);
  if (process.env.CV_E2E_ALLOW_STUB !== "1") {
    expect(await page.locator("#app").getAttribute("data-engine-kind"), "this build uses the pdfTeX stand-in (CV_TEX_STUB=1)").toBe("wasm");
  }
  await expect(page.locator("#app")).toHaveAttribute("data-python", /^3\.\d+/);
}

/** The app saves 0.4 s after an edit. */
export async function savedFiles(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("cv-tools:workspace");
    return raw ? ((JSON.parse(raw).files ?? {}) as Record<string, string>) : {};
  });
}

export async function savedYaml(page: Page): Promise<string> {
  return (await savedFiles(page))["cv.yaml"] ?? "";
}

export async function engineIsStub(page: Page): Promise<boolean> {
  return (await page.locator("#app").getAttribute("data-engine-kind")) === "stub";
}

export async function liveAvailable(page: Page): Promise<boolean> {
  await expect(page.locator("#app")).toHaveAttribute("data-live", /ready|unavailable/, { timeout: 30_000 });
  return (await page.locator("#app").getAttribute("data-live")) === "ready";
}

export async function needLive(page: Page) {
  expect(await liveAvailable(page), "this build of cv-tools has no HTML renderer").toBe(true);
}

/** Replace an editor line (found by its text) after its indentation. */
export async function replaceLine(page: Page, lineText: string | RegExp, text: string) {
  const line = page.locator(".cm-line", { hasText: lineText }).first();
  await line.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await page.keyboard.insertText(text);
}

export function livePage(page: Page) {
  return page.locator("#live");
}

/** A saved workspace before the app loads (once per test). */
export async function seed(page: Page, files: Record<string, string>) {
  await page.addInitScript((f) => {
    if (sessionStorage.getItem("cv-seeded")) return;
    sessionStorage.setItem("cv-seeded", "1");
    localStorage.setItem("cv-tools:workspace", JSON.stringify({ format: 2, files: f, savedAt: 1 }));
  }, files);
}

export function at(page: Page, path: string) {
  return page.locator(`#live [data-path="${path}"]`);
}

export async function paper(page: Page) {
  await page.getByRole("button", { name: "Paper", exact: true }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-layout", "paper");
}
