import { expect, openApp, test, waitReady } from "./fixtures";

test("works offline after the first visit", async ({ page, context, browserName }) => {
  await openApp(page);
  const supported = await page.evaluate(() => "serviceWorker" in navigator);
  test.skip(!supported, `${browserName} has no service worker here`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // The worker caches the app shell on install and everything else (Pyodide, the engine) when warmed.
  const manifest = await page.evaluate(async () => {
    const text = await (await fetch("./sw.js")).text();
    const json = /const MANIFEST = (\[.*?\]);\n/s.exec(text)![1];
    // The TeX font pack is cached when a CV first needs it, not ahead.
    return (JSON.parse(json) as { url: string; warm: boolean }[]).filter((e) => e.warm).map((e) => new URL(e.url, location.href).href);
  });
  expect(manifest).toEqual(expect.arrayContaining([expect.stringMatching(/\/engine-[0-9a-f]+\/busytex\.wasm$/), expect.stringMatching(/\/pyodide-[0-9a-f]+\/pyodide\.asm\.wasm$/)]));
  await expect
    .poll(
      async () =>
        page.evaluate(async (want) => {
          const names = (await caches.keys()).filter((n) => n.startsWith("cv-tools-"));
          if (!names.length) return want;
          const have = new Set((await (await caches.open(names[0])).keys()).map((r) => r.url));
          return want.filter((u) => !have.has(u));
        }, manifest),
      { timeout: 90_000, message: "files not yet cached" },
    )
    .toEqual([]);

  await context.setOffline(true);
  await page.reload();
  await waitReady(page);
  await expect(page.locator("#app")).toHaveAttribute("data-valid", "valid");
  await expect(page.locator("#app")).toHaveAttribute("data-pdf", "ready", { timeout: 60_000 });
  await context.setOffline(false);
});
