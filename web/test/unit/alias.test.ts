// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { aliasCopies } from "../../src/preview";
import { reusedAnchor } from "../../src/yamlDoc";

describe("reusedAnchor", () => {
  const text = `sections:
  - title: S
    entries:
      - &base
        title: Base
        bullets: &bl [a, b]
      - <<: *base
        date: 2025
      - *base
      - title: Own
        bullets: *bl
      - title: Alone
        text: &lonely x
`;
  it("names an anchor inside the entry that an alias outside it uses", () => {
    expect(reusedAnchor(text, ["sections", 0, "entries", 0])).toBe("base");
    expect(reusedAnchor(text, ["sections", 0, "entries", 1])).toBeNull();
    expect(reusedAnchor(text, ["sections", 0, "entries", 2])).toBeNull();
    expect(reusedAnchor(text, ["sections", 0, "entries", 4])).toBeNull();
  });
});

describe("aliasCopies", () => {
  const page = (html: string) => {
    const d = document.createElement("div");
    d.innerHTML = html;
    return d;
  };
  const entry = (attrs: string, title: string, date: string) => `<div data-entry ${attrs}><p><span ${title}>T</span><span ${date}>D</span></p></div>`;

  it("counts only the copies of the edited value, not every value of the anchor", () => {
    const root = page(
      entry('data-anchor="base"', 'data-path="e.0.title" data-anchor="base"', 'data-path="e.0.date" data-anchor="base"') +
        entry("", 'data-via-alias="base"', 'data-path="e.1.date"') +
        entry('data-via-alias="base"', 'data-via-alias="base"', 'data-via-alias="base"'),
    );
    const title = root.querySelector<HTMLElement>('[data-path="e.0.title"]')!;
    const date = root.querySelector<HTMLElement>('[data-path="e.0.date"]')!;
    expect(aliasCopies(title, "base", root)).toHaveLength(2);
    // The merge overrides the date, so only the alias item copies it.
    expect(aliasCopies(date, "base", root)).toHaveLength(1);
  });

  it("counts every alias of an anchored scalar", () => {
    const root = page('<span data-path="a" data-anchor="t">x</span><p><span data-via-alias="t">x</span></p><span data-via-alias="t">x</span>');
    expect(aliasCopies(root.querySelector<HTMLElement>('[data-anchor="t"]')!, "t", root)).toHaveLength(2);
  });
});
