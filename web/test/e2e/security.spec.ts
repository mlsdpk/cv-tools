// Security: the CSP, hostile share links, links in the preview and the share link size cap.
import { deflateRawSync } from "node:zlib";
import { CSP } from "../../scripts/site.mjs";
import { expect, liveAvailable, needLive, openApp, paper, test } from "./fixtures";

const link = (files: Record<string, string>) => "./#cv=" + deflateRawSync(Buffer.from(JSON.stringify({ v: 1, files }))).toString("base64url");

const HOSTILE = String.raw`version: 2
name: "<img src=x onerror=alert(1)>"
contact:
  - - url: "javascript:alert(1)"
    - "<script>alert(2)</script>"
    - url: "https://evil.example/\"><img src=x onerror=alert(3)>"
sections:
  - title: "<svg onload=alert(4)>"
    layout: list
    entries:
      - "[click](javascript:alert(5))"
      - "[x](  JaVa	ScRiPt:alert(6))"
      - latex: "</code><img src=https://evil.example/ping.png>"
      - "**<style>@import 'https://evil.example/x.css';</style>**"
      - "[a](https://evil.example/\" onmouseover=\"alert(7))"
      - "[real link](https://example.org/target)"
      - text: "<iframe srcdoc='<script>alert(8)</script>'>"
  - title: Pubs
    layout: publications
    bib: pubs.bib
`;
const BIB = String.raw`@article{x,
  author = {Doe, John and <img src=x onerror=alert(9)>},
  title = {<script>alert(10)</script> \href{javascript:alert(11)}{click} \url{https://evil.example/u}},
  journal = {J <svg onload=alert(12)>},
  year = {2024},
  url = {javascript:alert(13)}
}
`;

test("every page carries the Content-Security-Policy", async ({ page }) => {
  // Wait for Python first: leaving the page while Pyodide downloads makes WebKit log the aborted fetch.
  await openApp(page);
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content")).toBe(CSP);
  // The background PDF loads the TeX worker; WebKit reports a worker cut off by navigation as an error.
  await expect(page.locator("#app")).toHaveAttribute("data-pdf", "ready", { timeout: 90_000 });
  await page.goto("about.html");
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content")).toBe(CSP);
  expect(CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
});

test("the app runs under the policy: no violation while loading, previewing and compiling", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await openApp(page);
  await liveAvailable(page);
  await expect(page.locator("#app")).toHaveAttribute("data-pdf", "ready", { timeout: 90_000 });
  await page.goto("about.html");
  await expect(page.locator("table").first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
});

test.describe("a hostile share link", () => {
  test("renders nothing active, makes no request elsewhere and opens no window", async ({ page, context }) => {
    const foreign: string[] = [];
    context.on("request", (r) => {
      const u = new URL(r.url());
      if (!["127.0.0.1", "localhost"].includes(u.hostname) && !/^(blob|data|about):/.test(r.url())) foreign.push(r.url());
    });
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    const popups: string[] = [];
    context.on("page", (p) => popups.push(p.url()));
    await openApp(page, link({ "cv.yaml": HOSTILE, "pubs.bib": BIB }));
    await needLive(page);
    await expect(page.locator("#notice")).toContainText("raw LaTeX");
    const dom = await page.evaluate(() => {
      const root = document.getElementById("live")!.shadowRoot!;
      const bad: string[] = [];
      for (const el of root.querySelectorAll("*")) {
        const tag = el.tagName.toLowerCase();
        if (["script", "img", "iframe", "style", "link", "object", "embed", "form", "input", "animate", "image"].includes(tag)) bad.push(`<${tag}>`);
        for (const a of el.attributes) {
          if (/^on/i.test(a.name) || a.name === "srcdoc" || a.name === "style" || a.name === "target") bad.push(`${tag}[${a.name}]`);
          if (a.name === "href" && !/^(https?:|mailto:)/i.test(a.value)) bad.push(`${tag}[href=${a.value}]`);
        }
      }
      return { bad, hrefs: [...root.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")) };
    });
    expect(dom.bad).toEqual([]);
    expect(dom.hrefs).toContain("https://example.org/target");

    const real = page.locator("#live a[href='https://example.org/target']");
    const before = page.url();
    await real.click();
    await paper(page);
    await real.click();
    await page.keyboard.press("Escape");
    await real.click({ button: "middle" });
    await page.keyboard.press("Escape");
    await real.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    expect(page.url()).toBe(before);
    expect(popups).toEqual([]);
    expect(dialogs).toEqual([]);
    expect(foreign).toEqual([]);
  });

  test("a link that inflates past 2 MB is refused with a clear message", async ({ page }) => {
    await openApp(page, link({ "cv.yaml": "version: 2\nname: Big\n" + "#".repeat(3 * 1024 * 1024) }));
    await expect(page.locator("#notice")).toContainText("larger than 2 MB");
    expect(new URL(page.url()).hash).toBe("");
    await expect(page.locator(".cm-content")).toContainText("John Doe");
  });

  test("a shared CV is saved in this browser only after it validated", async ({ page }) => {
    await openApp(page, link({ "cv.yaml": "version: 2\nname: Broken\nsections: nope\n" }));
    await expect(page.locator("#app")).toHaveAttribute("data-valid", "invalid");
    await expect(page.locator("#file-state")).toContainText("saved once it is valid");
    expect(await page.evaluate(() => localStorage.getItem("cv-tools:workspace"))).toBeNull();
    await page.locator(".cm-line", { hasText: "sections: nope" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+Home");
    await page.keyboard.insertText("sections: []");
    await expect(page.locator("#app")).toHaveAttribute("data-valid", "valid");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("cv-tools:workspace") ?? "")).toContain("sections: []");
  });
});
