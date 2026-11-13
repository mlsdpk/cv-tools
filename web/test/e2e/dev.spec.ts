// The dev server: the tex worker imports the engine glue at runtime, which only this test covers.
import { spawn, type ChildProcess } from "node:child_process";
import { expect, test, waitReady } from "./fixtures";

test("the PDF compiles in the Vite dev server too", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "one browser is enough");
  test.setTimeout(180_000);
  const port = 4300 + Math.floor(Math.random() * 500);
  const vite: ChildProcess = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("../../", import.meta.url).pathname,
    stdio: "ignore",
    env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" },
  });
  try {
    const url = `http://127.0.0.1:${port}/`;
    await expect.poll(async () => fetch(url).then((r) => r.ok, () => false), { timeout: 60_000 }).toBe(true);
    await page.goto(url);
    await waitReady(page);
    await expect(page.locator("#app")).toHaveAttribute("data-pdf", "ready", { timeout: 120_000 });
    await expect(page.locator("#st-engine")).toHaveText(/^pdfLaTeX · \d+\.\d s$/);
  } finally {
    vite.kill();
  }
});
