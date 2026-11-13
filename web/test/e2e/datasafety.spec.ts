// Data safety: the user never loses or silently corrupts their CV.
import { readFileSync } from "node:fs";
import { at, expect, needLive, openApp, paper, replaceLine, savedFiles, savedYaml, seed, test, waitReady } from "./fixtures";

const CV1 = readFileSync(new URL("./data/cv1.yaml", import.meta.url), "utf8");
const V1 = new URL("../../../examples/v1/cv.yaml", import.meta.url).pathname;
const skills = (y: string) => [...y.matchAll(/- title: (Lang|Tools|Other)/g)].map((m) => m[1]).join(",");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });
});

async function undoFiles(page: import("@playwright/test").Page) {
  return page.evaluate(() => (JSON.parse(localStorage.getItem("cv-tools:undo") ?? "{}").files ?? {}) as Record<string, string>);
}

const replace = (page: import("@playwright/test").Page) => page.getByRole("dialog").getByRole("button", { name: "Replace" }).click();

test("opening a v1 file and migrating ask first and keep the replaced CV for Undo", async ({ page }) => {
  await seed(page, { "cv.yaml": CV1 });
  await openApp(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "New / Open" }).click();
  await page.getByRole("menuitem", { name: "Open file…" }).click();
  await (await chooser).setFiles(V1);
  await replace(page);
  await expect.poll(async () => (await undoFiles(page))["cv.yaml"]).toBe(CV1);
  await page.locator("#notice").getByRole("button", { name: "Migrate to v2" }).click();
  await replace(page);
  await expect(page.locator("#notice")).toContainText("Migrated to v2");
  await expect.poll(() => savedYaml(page)).toMatch(/^version: 2$/m);
  expect((await undoFiles(page))["cv.yaml"]).toBe(readFileSync(V1, "utf8"));
  await page.locator("#notice").getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => savedYaml(page)).toBe(readFileSync(V1, "utf8"));
});

test("a storage read failure never replaces the saved CV with the example", async ({ page }) => {
  await seed(page, { "cv.yaml": CV1 });
  await page.addInitScript(() => {
    if (sessionStorage.getItem("cv-read-fails")) {
      Storage.prototype.getItem = function () {
        throw new DOMException("transient", "UnknownError");
      };
      IDBObjectStore.prototype.get = function () {
        throw new DOMException("transient", "UnknownError");
      };
    }
  });
  await openApp(page);
  await page.evaluate(() => sessionStorage.setItem("cv-read-fails", "1"));
  await page.reload();
  await waitReady(page);
  await expect(page.locator("#notice")).toContainText("This browser blocks storage for this site");
  // Typing in this tab does not save over the unreadable record.
  await replaceLine(page, "name: John Doe", "name: Typed While Broken");
  await page.waitForTimeout(800);
  await expect(page.locator("#file-state")).toContainText("not saved");
  await page.evaluate(() => sessionStorage.removeItem("cv-read-fails"));
  page.on("dialog", (d) => d.accept());
  await page.reload();
  await waitReady(page);
  expect(await savedYaml(page)).toBe(CV1);
});

test("an unknown saved record is kept aside once, and the example is not saved until edited", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("s")) return;
    sessionStorage.setItem("s", "1");
    localStorage.setItem("cv-tools:workspace", JSON.stringify({ v: 2, files: { "main.yaml": "version: 2\nname: Precious\n" } }));
  });
  await openApp(page);
  await expect(page.locator("#notice")).toContainText("could not be read");
  const kept = () => page.evaluate(() => Object.entries(localStorage).filter(([k, v]) => k.startsWith("cv-tools:quarantine:") && v.includes("Precious")).length);
  expect(await kept()).toBe(1);
  await expect(page.locator("#file-state")).toContainText("example");
  await page.reload();
  await waitReady(page);
  await page.reload();
  await waitReady(page);
  expect(await kept()).toBe(1);
});

test("with storage blocked, the app says so instead of calling the CV unreadable", async ({ page }) => {
  await page.addInitScript(() => {
    for (const m of ["getItem", "setItem", "removeItem"] as const) {
      Storage.prototype[m] = function () {
        throw new DOMException("The operation is insecure.", "SecurityError");
      };
    }
    IDBFactory.prototype.open = function () {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
  });
  await openApp(page);
  await expect(page.locator("#notice")).toContainText("This browser blocks storage for this site");
  await expect(page.locator("#notice")).not.toContainText("could not be");
  await replaceLine(page, "name: John Doe", "name: Typed");
  await expect(page.locator("#file-state")).toContainText("not saved: browser storage is blocked");
});

test("a CV saved by a newer version is kept aside when the user starts fresh", async ({ page }) => {
  const future = JSON.stringify({ format: 99, files: { "cv.yaml": "version: 3\nname: Future\n" }, savedAt: 1 });
  await page.addInitScript((f) => {
    if (sessionStorage.getItem("s")) return;
    sessionStorage.setItem("s", "1");
    localStorage.setItem("cv-tools:workspace", f);
  }, future);
  await openApp(page);
  await expect(page.locator("#notice")).toContainText("saved by a newer version");
  await replaceLine(page, "name: John Doe", "name: Not Saved Yet");
  await expect(page.locator("#file-state")).toContainText("not saved");
  expect(await page.evaluate(() => localStorage.getItem("cv-tools:workspace"))).toBe(future);
  await page.locator("#notice").getByRole("button", { name: "Start fresh" }).click();
  await expect(page.locator("#notice")).toHaveText(/Started fresh\. The old data is kept aside in this browser\./);
  await expect.poll(() => savedYaml(page)).toContain("name: Not Saved Yet");
  const kept = await page.evaluate((f) => Object.entries(localStorage).some(([k, v]) => k.startsWith("cv-tools:quarantine:") && v === f), future);
  expect(kept).toBe(true);
});

test("Undo drops the file handle, so Ctrl+S does not write into the opened file", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __writes: string[][] }).__writes = [];
    (DataTransferItem.prototype as unknown as { getAsFileSystemHandle: unknown }).getAsFileSystemHandle = async function (this: DataTransferItem) {
      const f = this.getAsFile()!;
      return {
        kind: "file",
        name: f.name,
        getFile: async () => f,
        queryPermission: async () => "granted",
        createWritable: async () => ({ write: async (t: string) => (window as unknown as { __writes: string[][] }).__writes.push([f.name, t]), close: async () => {} }),
      } as unknown as FileSystemHandle;
    };
  });
  await seed(page, { "cv.yaml": CV1 });
  await openApp(page);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["version: 2\nname: File On Disk\nsections: []\n"], "thesis-cv.yaml", { type: "text/yaml" }));
    for (const type of ["dragenter", "dragover", "drop"]) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await replace(page);
  await expect(page.locator("#file-state")).toContainText("thesis-cv.yaml");
  await page.locator("#notice").getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => savedYaml(page)).toBe(CV1);
  const download = page.waitForEvent("download");
  await page.keyboard.press("ControlOrMeta+s");
  await download;
  expect(await page.evaluate(() => (window as unknown as { __writes: string[][] }).__writes)).toEqual([]);
});

test.describe("editing on the page", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { "cv.yaml": CV1 });
    await openApp(page);
    await needLive(page);
    await paper(page);
  });

  test("clicking a block scalar and leaving it does not rewrite the YAML", async ({ page }) => {
    await at(page, "sections.0.entries.0").click();
    await expect(page.locator("#live [data-editing]")).toHaveCount(1);
    await page.locator("#file-state").click();
    await expect(page.locator("#live [data-editing]")).toHaveCount(0);
    await page.waitForTimeout(800);
    expect(await savedYaml(page)).toBe(CV1);
  });

  test("a number edit keeps the typed text", async ({ page }) => {
    await at(page, "sections.1.entries.0.date").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText("2023.10");
    await page.keyboard.press("Enter");
    await expect.poll(() => savedYaml(page)).toContain("      - date: '2023.10'\n");
    await at(page, "sections.1.entries.1.date").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText("2020");
    await page.keyboard.press("Enter");
    await expect.poll(() => savedYaml(page)).toContain("      - date: 2020\n");
  });

  test("deleting the only item writes `entries: []` and keeps comments", async ({ page }) => {
    await at(page, "sections.3.entries.0").click();
    await page.locator("#live .cv-tools").getByRole("button", { name: "Delete" }).click();
    await expect.poll(() => savedYaml(page)).toContain("    layout: list\n    entries: []\n");
    expect(await savedYaml(page)).toContain("name: Jane Doe        # aligned comment\n");
  });

  test("clearing a link removes the item, and an invalid edit shows its error on the page", async ({ page }) => {
    // cv1 has no link item; add one in the YAML first.
    await page.getByRole("button", { name: "Split" }).click();
    await replaceLine(page, "- jane@x.org", "- - url: https://jane.example");
    await paper(page);
    await at(page, "contact.0.0.url").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await expect.poll(() => savedYaml(page)).toContain("contact:\n  - - Curriculum Vitae, {date}\n");
    // A character pdfLaTeX cannot print: the page keeps the last valid version and says why.
    await at(page, "sections.2.entries.0.title").click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" 😀");
    await page.keyboard.press("Enter");
    await expect(page.locator("#app")).toHaveAttribute("data-valid", "invalid");
    await expect(page.locator("#paper-status")).toBeVisible();
    await expect(page.locator("#paper-status")).toContainText(/Error: .*U\+1F600/);
    await page.locator("#paper-status").getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("#app")).toHaveAttribute("data-valid", "valid");
    await expect(page.locator("#paper-status")).toBeHidden();
    await expect.poll(() => savedYaml(page)).not.toContain("😀");
  });

  test("hiding the tab keeps and saves what is being typed on the page", async ({ page }) => {
    await at(page, "sections.2.entries.1.title").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText("Typed before hiding");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Saved at once, without the usual 0.4 s wait.
    await expect.poll(() => page.evaluate(() => localStorage.getItem("cv-tools:workspace") ?? ""), { timeout: 300, intervals: [20] }).toContain("title: Typed before hiding");
  });

  test("structural actions wait for the render of the previous one", async ({ page }) => {
    // Two deletes in a row: the second click lands on the stale page and must not delete another entry.
    const result = await page.evaluate(() => {
      const root = document.getElementById("live")!.shadowRoot!;
      const press = (path: string) => {
        const el = root.querySelector(`[data-path="${path}"]`)!;
        el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
      };
      press("sections.2.entries.0.title");
      root.querySelector<HTMLButtonElement>(".cv-tools .cv-delete")!.click();
      press("sections.2.entries.1.title");
      const del = root.querySelector<HTMLButtonElement>(".cv-tools .cv-delete")!;
      const disabled = del.getAttribute("aria-disabled");
      del.click();
      return { disabled };
    });
    expect(result.disabled).toBe("true");
    await page.waitForTimeout(1500);
    expect(skills(await savedYaml(page))).toBe("Tools,Other");

    // Two quick presses on Move down: the second lands on the stale page and does nothing; focus stays on the action.
    await at(page, "sections.2.entries.0.title").click();
    await page.locator("#live .cv-tools").getByRole("button", { name: "Move down" }).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect.poll(async () => skills(await savedYaml(page))).toBe("Other,Tools");
    const focus = () =>
      page.evaluate(() => {
        const a = document.getElementById("live")!.shadowRoot!.activeElement as HTMLElement | null;
        return `${a?.className} in ${a?.closest<HTMLElement>("[data-cv-entry]")?.dataset.cvEntry}`;
      });
    await expect.poll(focus).toBe("cv-down in sections.2.entries.1");
    await page.waitForTimeout(800);
    expect(skills(await savedYaml(page))).toBe("Other,Tools");
  });

});

test("resizing from a phone to a desktop keeps what is being typed on the page", async ({ page }) => {
  await seed(page, { "cv.yaml": CV1 });
  await page.setViewportSize({ width: 600, height: 900 });
  await openApp(page);
  await needLive(page);
  await expect(page.locator("#app")).toHaveAttribute("data-layout", "paper");
  await at(page, "sections.2.entries.0.title").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("Typed on phone");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator("#app")).toHaveAttribute("data-layout", "split");
  // Split edits on the page too: the edit goes on.
  await expect(at(page, "sections.2.entries.0.title")).toHaveAttribute("data-editing", "");
  await page.keyboard.press("Enter");
  await expect.poll(() => savedYaml(page)).toContain("title: Typed on phone");
});

test("multi-file drop opens every file, in either order", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP drag events");
  await seed(page, { "cv.yaml": CV1 });
  await openApp(page);
  const cdp = await page.context().newCDPSession(page);
  const dir = new URL("./data/", import.meta.url).pathname;
  for (const files of [[dir + "dropped.yaml", dir + "mine.bib"], [dir + "mine.bib", dir + "dropped.yaml"]]) {
    await page.evaluate(() => localStorage.removeItem("cv-tools:workspace"));
    for (const type of ["dragEnter", "dragOver", "drop"] as const) await cdp.send("Input.dispatchDragEvent", { type, x: 700, y: 400, data: { items: [], files, dragOperationsMask: 1 } });
    if (files[1].endsWith(".bib")) await replace(page);
    await expect.poll(async () => Object.keys(await savedFiles(page)).sort()).toEqual(["cv.yaml", "mine.bib"]);
    expect((await savedFiles(page))["cv.yaml"]).toContain("name: Dropped Person");
    await expect(page.locator("#app")).toHaveAttribute("data-valid", "valid");
  }
});

test("when nothing can be saved, the app says why, offers a download and guards closing", async ({ page }) => {
  await seed(page, { "cv.yaml": CV1 });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("cv-seeded")) return;
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k === "cv-tools:workspace" && v.length > 300) throw new DOMException("full", "QuotaExceededError");
      return set.call(this, k, v);
    };
    IDBObjectStore.prototype.put = function () {
      throw new DOMException("quota", "QuotaExceededError");
    };
  });
  await openApp(page);
  await replaceLine(page, "title: Lang", "- title: Unsaved work");
  await expect(page.locator("#notice")).toContainText("storage for the site is full");
  await expect(page.locator("#file-state")).toContainText("not saved: browser storage is full");
  const download = page.waitForEvent("download");
  await page.locator("#notice").getByRole("button", { name: /Download/ }).click();
  expect((await download).suggestedFilename()).toBe("cv.yaml");
  let asked = false;
  page.on("dialog", async (d) => {
    asked = d.type() === "beforeunload";
    await d.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toBe(true);
});

test("a share link pasted into an open tab asks first and keeps the old CV", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => ((window as unknown as { copied: string }).copied = t) } });
  });
  await seed(page, { "cv.yaml": CV1 });
  await openApp(page);
  await replaceLine(page, "name: Jane Doe", "name: Shared Name");
  await page.getByRole("button", { name: "Other downloads" }).click();
  await page.getByRole("menuitem", { name: /Copy share link/ }).click();
  await expect(page.locator("#notice")).toContainText("Share link copied");
  const link = await page.evaluate(() => (window as unknown as { copied: string }).copied);
  await replaceLine(page, "name: Shared Name", "name: My Later Work");
  await expect.poll(() => savedYaml(page)).toContain("My Later Work");
  await page.goto(link);
  await expect(page.getByRole("dialog")).toContainText("The shared CV replaces the CV you have open");
  expect(new URL(page.url()).hash).toBe("");
  expect(await savedYaml(page)).toContain("My Later Work");
  await replace(page);
  await expect(page.locator(".cm-content")).toContainText("name: Shared Name");
  await expect.poll(() => savedYaml(page)).toContain("Shared Name");
  expect((await undoFiles(page))["cv.yaml"]).toContain("My Later Work");
});

test("typing at a normal pace in a large CV never trips the Python watchdog", async ({ page }) => {
  test.setTimeout(150_000);
  const ex = readFileSync(new URL("../../../examples/cv.yaml", import.meta.url), "utf8");
  const at = ex.indexOf("sections:\n") + 10;
  const body = ex.slice(at).replace(/ {2}- title: Publications[\s\S]*$/, "");
  await seed(page, { "cv.yaml": ex.slice(0, at) + body.repeat(30) });
  await openApp(page);
  await expect(page.locator("#app")).toHaveAttribute("data-live", "ready", { timeout: 60_000 });
  await page.locator(".cm-line", { hasText: "name: John Doe" }).first().click();
  await page.keyboard.press("End");
  for (const ch of " typing a short sentence here") {
    await page.keyboard.insertText(ch);
    await page.waitForTimeout(260);
  }
  await expect(page.locator(".cm-content")).toContainText("John Doe typing a short sentence here");
  await expect(page.locator("#st-valid")).toHaveText(/^valid/, { timeout: 60_000 });
  expect(await page.locator("#app").getAttribute("data-py-restarts")).toBeNull();
  await expect(page.locator("#notice")).not.toContainText("was restarted");
});

