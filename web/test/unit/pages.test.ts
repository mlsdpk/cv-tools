// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { norm, paginateByPdf, type PageBreak } from "../../src/pages";

const REPEATED = "Repeated bullet text that appears many times in the same list";

/** One page box: a title and twenty identical bullets, which the PDF puts on four pages of five. */
function cv(): HTMLElement {
  const doc = document.createElement("div");
  doc.className = "cv-document";
  doc.innerHTML = `<div class="cv-page"><section class="cv-section"><h2 class="cv-section-title">Experience</h2><ul class="cv-bullets">${`<li class="cv-bullet">${REPEATED}</li>`.repeat(20)}</ul></section></div>`;
  document.body.replaceChildren(doc);
  return doc;
}

/** The PDF's breaks: its pages hold the title and bullets 1-5, 6-10, 11-15 and 16-20. */
function breaks(withOffsets: boolean): PageBreak[] {
  const b = norm(REPEATED);
  const texts = [norm("Experience") + b.repeat(5), b.repeat(5), b.repeat(5), b.repeat(5)];
  const total = texts.join("").length;
  let at = 0;
  return texts.slice(1).map((t, i) => {
    at += texts[i].length;
    return { before: texts[i].slice(-24), start: t.slice(0, 24), ...(withOffsets ? { at, total } : {}) };
  });
}

const perPage = (doc: HTMLElement) => [...doc.querySelectorAll(":scope > .cv-page")].map((p) => p.querySelectorAll("li.cv-bullet").length);

describe("paginateByPdf", () => {
  it("splits repeated lines on four pages at the occurrence nearest where the PDF breaks", () => {
    const doc = cv();
    expect(paginateByPdf(doc, breaks(true))).toBe(3);
    expect(perPage(doc)).toEqual([5, 5, 5, 5]);
  });
  it("without offsets, takes the first match after the previous break", () => {
    const doc = cv();
    expect(paginateByPdf(doc, breaks(false))).toBe(3);
    expect(perPage(doc)).toEqual([1, 1, 1, 17]);
  });
});
