// @vitest-environment jsdom
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { safeHref, sanitize, sanitizeCss } from "../../src/sanitize";

const html = (h: string) => {
  const d = document.createElement("div");
  d.append(sanitize(h));
  return d.innerHTML;
};

describe("sanitize", () => {
  it("drops elements, attributes and links outside the allowlist", () => {
    const payloads = [
      '<img src="https://evil.example/beacon.png">',
      '<style>.cv-name{background:url(https://evil.example/css.png)}</style><h1 class=cv-name>x</h1>',
      '<a href="java&#9;script:alert(1)">tab</a>',
      '<svg><a><animate attributeName="href" values="javascript:alert(2)"/><text y=20>svg</text></a></svg>',
      '<svg><image href="https://evil.example/svg.png"/></svg>',
      '<video poster="https://evil.example/poster.png"></video>',
    ];
    const out = payloads.map(html);
    expect(out[0]).toBe("");
    expect(out[1]).toBe('<h1 class="cv-name">x</h1>');
    expect(out[2]).toBe("<a>tab</a>");
    expect(out[3]).toBe('<svg></svg>');
    expect(out[4]).toBe("<svg></svg>");
    expect(out[5]).toBe("");
    expect(out.join("")).not.toMatch(/evil|javascript|animate|image|style|video/);
  });

  it("keeps only allowed attributes, cv- classes and http, https and mailto links", () => {
    const out = html(
      '<div class="cv-entry evil" data-entry="sections.0.entries.0" style="color:red" onclick="x()" id="i">' +
        '<a class="cv-link" href="https://example.org/a" target="_blank" aria-label="site">ok</a>' +
        '<a href="mailto:a@b.c">m</a><a href="  JaVa\tScRiPt:alert(6)">j</a><a href="/relative">r</a><a href="data:text/html,x">d</a>' +
        '<span data-path="name" data-raw="&lt;b&gt;" data-via-alias="t" data-anchor="t" title="x">n</span>' +
        '<form><input></form><iframe srcdoc="x"></iframe><!-- c --></div>',
    );
    expect(out).toBe(
      '<div class="cv-entry" data-entry="sections.0.entries.0">' +
        '<a class="cv-link" href="https://example.org/a" aria-label="site">ok</a>' +
        '<a href="mailto:a@b.c">m</a><a>j</a><a>r</a><a>d</a>' +
        '<span data-path="name" data-raw="&lt;b&gt;" data-via-alias="t" data-anchor="t">n</span></div>',
    );
    expect(safeHref("https://x.org")).toBe(true);
    expect(safeHref("javascript:alert(1)")).toBe(false);
    expect(safeHref("java\nscript:alert(1)")).toBe(false);
  });

  it("keeps the contact icons", () => {
    const svg = '<svg class="cv-icon-svg" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="M0 0h10" fill="#a6ce39" transform="scale(1)"></path></svg>';
    expect(html(svg)).toBe(svg);
  });

  it("removes imports and remote URLs from the stylesheet", () => {
    expect(sanitizeCss("@import 'https://e/x.css'; .a{background:url(https://e/p.png)} .b{background:url(//e/p.png)} .c{color:red}")).toBe(
      " .a{background:none} .b{background:none} .c{color:red}",
    );
  });

  it("drops remote url() from SVG attributes and from escaped or tab-split CSS", () => {
    expect(html('<svg><path d="M0 0h10v10z" fill="url(https://e/m7.svg#p)"/><g fill="url(//e/m8.svg#p)"></g><path fill="url(#local)"/></svg>')).toBe(
      '<svg><path d="M0 0h10v10z"></path><g></g><path fill="url(#local)"></path></svg>',
    );
    const css = [
      ".a{background:url(htt\\70s://e/c1.png)}",
      ".b{background:url(\\2f\\2f e/c2.png)}",
      "@im\\70ort url(https://e/c3.css);",
      '.c{background:image-set("https://e/c4.png" 1x)}',
      "@font-face{font-family:Q;src:url( https://e/c5.woff)}",
      ".e{background:url('https:\\2f\\2f e/c6.png')}",
      '.f{background:url("ht\ttps://e/c7.png")}',
      ".g{background:url(/\\/e/c8.png)}",
    ].map(sanitizeCss);
    for (const c of css) expect(c).not.toMatch(/\be\/c\d/);
    expect(sanitizeCss('.ok{content:"\\201C";background:url(img/x.png)}')).toBe('.ok{content:"\\201C";background:url(img/x.png)}');
  });

  const REPO = resolve(process.cwd(), "..");
  const python = process.env.CV_TOOLS_PYTHON ?? resolve(REPO, ".venv/bin/python");
  const hasPython = existsSync(python) || !!process.env.CV_TOOLS_PYTHON;
  it.skipIf(!hasPython).each(["examples/cv.yaml", "tests/fixtures/aliases/cv.yaml", "tests/fixtures/v2/long-lines.yaml"])("leaves the renderer's output of %s unchanged", (file) => {
    const r = spawnSync(python, ["-c", "import sys; from cv_tools import api; sys.stdout.write(api.render_html(api.load(sys.argv[1])).html)", resolve(REPO, file)], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    const t = document.createElement("template");
    t.innerHTML = r.stdout;
    const d = document.createElement("div");
    d.append(t.content.cloneNode(true));
    expect(html(r.stdout)).toBe(d.innerHTML);
    expect(html(r.stdout)).toContain("data-path=");
    const css = spawnSync(python, ["-c", "import sys; from cv_tools import api; sys.stdout.write(api.render_html(api.load(sys.argv[1])).css or '')", resolve(REPO, file)], { encoding: "utf8" });
    expect(sanitizeCss(css.stdout)).toBe(css.stdout);
  });
});
