import { describe, expect, it } from "vitest";
import { rawOffset } from "../../src/caret";

/** The source offset for a click before `shown[at]`, shown as the source with a caret. */
const at = (raw: string, shown: string, i: number, date?: string) => {
  const o = rawOffset(raw, shown, i, date);
  return raw.slice(0, o) + "|" + raw.slice(o);
};

describe("rawOffset", () => {
  it("is the same offset in plain text", () => {
    expect(at("Plain text", "Plain text", 6)).toBe("Plain |text");
  });
  it("skips bold and italic markers", () => {
    expect(at("a **bold** b", "a bold b", 4)).toBe("a **bo|ld** b");
    expect(at("a *it* b", "a it b", 5)).toBe("a *it* |b");
    expect(at("***x***y", "xy", 1)).toBe("***x***|y");
  });
  it("keeps a click in a link's text out of its URL", () => {
    const raw = "*An Exploration of ['Quantum Computing'](https://en.wikipedia.org/wiki/Quantum_computing) in Virtual Environments*";
    const shown = "An Exploration of “Quantum Computing” in Virtual Environments";
    expect(at(raw, shown, shown.indexOf("Computing"))).toBe(raw.replace("Computing'", "|Computing'"));
    // The end of the link's text is inside the brackets.
    expect(at(raw, shown, shown.indexOf(" in Virtual"))).toBe(raw.replace("'](", "'|]("));
    expect(at(raw, shown, shown.indexOf("in Virtual"))).toBe(raw.replace("in Virtual", "|in Virtual"));
  });
  it("counts an escape as one character", () => {
    expect(at("5 \\* 3 = 15", "5 * 3 = 15", 3)).toBe("5 \\*| 3 = 15");
    expect(at("\\[not a link\\](x)", "[not a link](x)", 1)).toBe("\\[|not a link\\](x)");
  });
  it("maps {date} to the date it shows", () => {
    expect(at("Curriculum Vitae, {date} ok", "Curriculum Vitae, 13th November 2026 ok", 37, "13th November 2026")).toBe("Curriculum Vitae, {date} |ok");
  });
  it("maps TeX ligatures and runs of spaces", () => {
    expect(at("2020 -- 2024", "2020 – 2024", 7)).toBe("2020 -- |2024");
    expect(at("a  b", "a b", 2)).toBe("a  |b");
    expect(at("a    b", "ab", 1)).toBe("a|    b");
  });
  it("keeps the plain offset for text the markup does not explain", () => {
    expect(rawOffset("abc", "xyz", 2)).toBe(2);
  });
});
