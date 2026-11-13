// New deploys while the app is open: the update waits for the user, old pages keep working, and the app always starts offline.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import type { Page } from "@playwright/test";
import { finishSite } from "../../scripts/sw-plugin";
import { BASE } from "../../scripts/site.mjs";
import { expect, replaceLine, savedYaml, test, waitReady } from "./fixtures";

const DIST = new URL("../../dist/", import.meta.url).pathname;
const TEMPLATE = readFileSync(new URL("../../src/sw.js", import.meta.url), "utf8");
const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm",
  ".json": "application/json", ".woff2": "font/woff2", ".yaml": "text/yaml", ".bib": "text/plain", ".gz": "application/gzip",
  ".whl": "application/zip", ".zip": "application/zip", ".txt": "text/plain", ".md": "text/plain",
};

/** A static server for a copy of the site under BASE, with no caching. `net.offline` drops every request. */
function serve(root: string): Promise<{ url: string; server: Server; net: { offline: boolean } }> {
  const net = { offline: false };
  const server = createServer((req, res) => {
    if (net.offline) {
      req.socket.destroy();
      return;
    }
    let p = decodeURIComponent(new URL(req.url!, "http://x").pathname);
    if (!p.startsWith(BASE)) {
      res.writeHead(404).end();
      return;
    }
    p = p.slice(BASE.length - 1);
    if (p.endsWith("/")) p += "index.html";
    const file = normalize(join(root, p));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}${BASE}`, server, net })));
}

/** Deploy a new build into `root`: new names for the PDF viewer chunk and the main bundle, old files deleted. */
function deploy(root: string, tag = "v2") {
  const dir = join(root, "assets");
  const find = (re: RegExp) => readdirSync(dir).find((f) => re.test(f))!;
  const pdfOld = find(/^pdf-.*\.js$/);
  const mainOld = find(/^main-.*\.js$/);
  const pdfNew = pdfOld.replace(/(-v\d)?\.js$/, `-${tag}.js`);
  const mainNew = mainOld.replace(/(-v\d)?\.js$/, `-${tag}.js`);
  writeFileSync(join(dir, pdfNew), readFileSync(join(dir, pdfOld), "utf8") + `\n// deploy ${tag}\n`);
  rmSync(join(dir, pdfOld));
  const main = readFileSync(join(dir, mainOld), "utf8");
  expect(main).toContain(pdfOld);
  writeFileSync(join(dir, mainNew), main.replaceAll(pdfOld, pdfNew) + `\n// deploy ${tag}\n`);
  rmSync(join(dir, mainOld));
  for (const html of ["index.html", "about.html"]) {
    const p = join(root, html);
    writeFileSync(p, readFileSync(p, "utf8").replaceAll(mainOld, mainNew));
  }
  return finishSite(root, TEMPLATE).build;
}

// "" while the page is navigating (a reload in progress).
const buildOf = (page: Page) => page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="cv-build"]')?.content ?? "").catch(() => "");
const cacheNames = (page: Page) => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("cv-tools-")).sort());

test("a new version waits for the user, and an open page of the old build keeps working", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "one browser is enough for the service worker lifecycle");
  test.setTimeout(240_000);
  const root = mkdtempSync(join(tmpdir(), "cv-tools-site-"));
  cpSync(DIST, root, { recursive: true });
  const { url, server } = await serve(root);
  const context = await browser.newContext();
  try {
    const a = await context.newPage();
    await a.goto(url);
    await waitReady(a);
    await a.evaluate(() => navigator.serviceWorker.ready);
    await a.reload();
    await waitReady(a);
    await expect.poll(() => a.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const oldBuild = await buildOf(a);
    const b = await context.newPage();
    await b.goto(url);
    await waitReady(b);

    const newBuild = deploy(root);
    expect(newBuild).not.toBe(oldBuild);
    for (const p of [a, b]) await p.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
    await expect(a.locator("#notice")).toContainText("A new version of cv-tools is available");
    await expect(b.locator("#notice")).toContainText("A new version of cv-tools is available");

    // Page A takes the update; page B stays on the old build and keeps working.
    await a.bringToFront();
    await replaceLine(a, "name: John Doe", "name: Before Update");
    await a.locator("#notice").getByRole("button", { name: "Reload" }).click();
    await expect.poll(() => buildOf(a), { timeout: 30_000 }).toBe(newBuild);
    await waitReady(a);
    await expect(a.locator(".cm-content")).toContainText("name: Before Update");
    expect(await savedYaml(a)).toContain("name: Before Update");

    await b.bringToFront();
    await expect(b.locator("#notice")).toContainText("updated in another tab");
    expect(await buildOf(b)).toBe(oldBuild);
    // The old build's PDF viewer chunk is gone from the server; the old cache still serves it.
    await expect(b.locator("#app")).toHaveAttribute("data-pdf", "ready", { timeout: 90_000 });
    expect(await cacheNames(b)).toEqual([`cv-tools-${newBuild}`, `cv-tools-${oldBuild}`].sort());

    // Once no page of the old build is open, its cache goes.
    await b.close();
    await a.reload();
    await waitReady(a);
    await expect.poll(() => cacheNames(a)).toEqual([`cv-tools-${newBuild}`]);
  } finally {
    await context.close();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const update = async (page: Page) => {
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting), { timeout: 120_000 }).toBe(true);
};

async function pdfWorks(page: Page) {
  await expect(page.locator("#app")).toHaveAttribute("data-pdf", "ready", { timeout: 120_000 });
}

test("three deploys with tabs opened and closed and offline reloads always leave an app that starts", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "one browser is enough for the service worker lifecycle");
  test.setTimeout(600_000);
  const root = mkdtempSync(join(tmpdir(), "cv-tools-site-"));
  cpSync(DIST, root, { recursive: true });
  const { url, server, net } = await serve(root);
  const context = await browser.newContext();
  const open = async () => {
    const p = await context.newPage();
    await p.goto(url);
    await waitReady(p);
    return p;
  };
  try {
    const t1 = await open();
    await t1.evaluate(() => navigator.serviceWorker.ready);
    await t1.reload();
    await waitReady(t1);
    await t1.evaluate(
      () =>
        new Promise<void>((resolve) => {
          navigator.serviceWorker.addEventListener("message", (e) => e.data?.type === "warm-done" && resolve());
          navigator.serviceWorker.controller!.postMessage({ type: "warm" });
        }),
    );

    // v2 waits while v1 pages open and close; a v1 page saying hello must not delete v2's cache.
    const v2 = deploy(root, "v2");
    await update(t1);
    const t2 = await open();
    await t2.waitForTimeout(1000);
    expect(await cacheNames(t2)).toContain(`cv-tools-${v2}`);
    await t1.close();
    await t2.close();
    net.offline = true;
    const t3 = await open();
    expect(await buildOf(t3)).toBe(v2);
    net.offline = false;

    // v3 is taken in a new tab; the v2 tab keeps working, and the v3 tab reloads offline.
    const v3 = deploy(root, "v3");
    await update(t3);
    const t4 = await open();
    expect(await buildOf(t4)).toBe(v2);
    await t4.locator("#notice").getByRole("button", { name: "Reload" }).click();
    await expect.poll(() => buildOf(t4), { timeout: 60_000 }).toBe(v3);
    await waitReady(t4);
    await expect(t3.locator("#notice")).toContainText("updated in another tab");
    await t3.bringToFront();
    await pdfWorks(t3);
    await t3.close();
    net.offline = true;
    await t4.reload();
    await waitReady(t4);
    expect(await buildOf(t4)).toBe(v3);
    await pdfWorks(t4);
  } finally {
    net.offline = false;
    await context.close();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the build stamps every page and versions Pyodide and the engine by content", async () => {
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  const build = /<meta name="cv-build" content="([0-9a-f]+)"/.exec(html)![1];
  const sw = readFileSync(join(DIST, "sw.js"), "utf8");
  expect(sw).toContain(JSON.stringify(build));
  const manifest = JSON.parse(/const MANIFEST = (\[.*?\]);\n/s.exec(sw)![1]) as { url: string; lazy: boolean; warm: boolean }[];
  const urls = manifest.map((e) => e.url);
  expect(urls.some((u) => /^pyodide-[0-9a-f]{10}\/pyodide\.asm\.wasm$/.test(u))).toBe(true);
  expect(urls.some((u) => /^engine-[0-9a-f]{10}\/busytex\.wasm$/.test(u))).toBe(true);
  expect(urls.filter((u) => /licenses\/|sources\//.test(u))).toEqual([]);
  expect(manifest.find((e) => /texmf-extra\.tar\.gz$/.test(e.url))).toMatchObject({ lazy: true, warm: false });
  expect(existsSync(join(DIST, "pyodide"))).toBe(false);
  expect(existsSync(join(DIST, "engine"))).toBe(false);
  // The JSON Schema ships with the site (in the manifest, not copied after the build).
  expect(urls).toContain("schema/v2.json");
});

test("the Latin Modern Math face loads for a math symbol, and only then", async ({ page }) => {
  const fetched: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("latinmodern-math")) fetched.push(r.url());
  });
  await page.goto("./");
  await waitReady(page);
  await page.waitForTimeout(500);
  expect(fetched).toEqual([]);
  const status = await page.evaluate(async () => {
    await document.fonts.load('16px "Latin Modern Math"', "\u223C");
    return [...document.fonts].filter((f) => f.family.replace(/"/g, "") === "Latin Modern Math").map((f) => f.status);
  });
  expect(status).toContain("loaded");
  expect(fetched.length).toBeGreaterThan(0);
});
