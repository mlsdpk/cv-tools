import "./fonts.css";
import "./styles.css";
import "./about.css";
import { BASE_URL, ENGINE_DIR, PYODIDE_DIR, sayHello, SITE } from "./site";

interface Notice {
  component: string;
  license: string;
  file: string;
  group: string;
}

interface Assets {
  pyodide: string;
  python: string;
  cvTools: { version: string };
  python_packages: { name: string; version: string; license: string; source: string }[];
  npm_packages: { name: string; version: string; license: string; file: string | null }[];
  notices?: Notice[];
}

interface EngineManifest {
  engine: { repo: string; tag: string; sourceCommit: string; pdftex: string; texliveYear: number };
  tree?: { texliveYear: number; files: number };
}

interface Sources {
  tag: string;
  archives: { name: string; what: string; license: string; file: string; bytes: number; sha256: string; url: string }[];
}

const ENGINE_TEXTS = ["GPL-2.0", "GPL-3.0", "LGPL-2.1", "LGPL-3.0", "LPPL-1.3c", "OFL-1.1"];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

const site = (path: string) => new URL(path, BASE_URL).href;

function link(href: string, text: string) {
  return el("a", { href }, text);
}

function table(head: string[], rows: (Node | string)[][]) {
  return el(
    "table",
    {},
    el("thead", {}, el("tr", {}, ...head.map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c) => el("td", {}, c))))),
  );
}

async function json<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** The GitHub Release that holds the engine's corresponding source (.github/workflows/engine-sources.yml). */
export function sourcesRelease(tag: string) {
  const name = SITE.engineSourcesTagPrefix + tag;
  const base = `https://github.com/${SITE.repository}/releases`;
  return { tag: name, page: `${base}/tag/${name}`, asset: (file: string) => `${base}/download/${name}/${encodeURIComponent(file)}` };
}

const mib = (n: number) => `${(n / 2 ** 20).toFixed(n < 2 ** 20 ? 2 : 1)} MiB`;
const code = (t: string) => el("code", {}, t);

async function main() {
  const [assets, engine, sources] = await Promise.all([
    json<Assets>(site("assets.json")),
    json<EngineManifest>(site(ENGINE_DIR + "manifest.json")),
    json<Sources>(site(ENGINE_DIR + "sources.json")),
  ]);
  const notices = assets?.notices ?? [];
  const noticeRows = (group: string) => notices.filter((n) => n.group === group).map((n) => [n.component, n.license, link(site(n.file), "licence text")]);

  const own = document.getElementById("cv-tools")!;
  const mine = notices.find((n) => n.group === "cv-tools");
  own.replaceChildren(
    el("p", {}, "cv-tools is free software under the ", mine ? link(site(mine.file), "MIT licence") : "MIT licence", `. Version ${assets?.cvTools.version ?? "unknown"} runs on this page.`),
  );

  const engineBox = document.getElementById("engine")!;
  if (engine) {
    const repo = `https://github.com/${engine.engine.repo}`;
    const lic = (f: string) => site(`${ENGINE_DIR}licenses/${f}`);
    const release = sources ? sourcesRelease(sources.tag) : null;
    engineBox.replaceChildren(
      el(
        "p",
        {},
        `${engine.engine.pdftex}, compiled to WebAssembly by `,
        link(repo, engine.engine.repo),
        ` (release `,
        link(`${repo}/releases/tag/${engine.engine.tag}`, engine.engine.tag),
        `). pdfTeX, kpathsea and the TeX Live programs are free software under the GNU GPL and other licences; `,
        link(lic("THIRD_PARTY.md"), "THIRD_PARTY.md"),
        ` lists every component with its licence. The TeX files (LaTeX, the fonts and packages the CV uses${engine.tree ? `, ${engine.tree.files} files from TeX Live ${engine.tree.texliveYear}` : ""}) carry their own licences, mostly the LPPL and the OFL.`,
      ),
      el("p", {}, "Licence texts: ", ...ENGINE_TEXTS.flatMap((t, i) => [i ? ", " : "", link(lic(`texts/${t}.txt`), t)]), ". Release files: ", link(lic("LICENSE.TL"), "LICENSE.TL"), ", ", link(lic("LICENSE.CTAN"), "LICENSE.CTAN"), ", ", link(lic("versions.txt"), "versions.txt"), ", ", link(lic("source-commit.txt"), "source-commit.txt"), "."),
      ...(sources && release
        ? [
            el("h3", {}, "Source code of the engine"),
            el(
              "p",
              {},
              "The exact source of the engine this site runs is published as the assets of the GitHub Release ",
              link(release.page, release.tag),
              " (with ",
              link(release.asset("SHA256SUMS"), "SHA256SUMS"),
              "):",
            ),
            table(
              ["Archive", "Contents", "Size", "SHA256"],
              sources.archives.map((a) => [link(release.asset(a.file), a.file), a.what, mib(a.bytes), code(a.sha256)]),
            ),
          ]
        : [el("p", {}, "sources.json is missing from this build.")]),
    );
  } else {
    engineBox.replaceChildren(el("p", {}, "This build has no TeX engine."));
  }

  const pyBox = document.getElementById("python")!;
  if (assets) {
    pyBox.replaceChildren(
      el(
        "p",
        {},
        link("https://pyodide.org", "Pyodide"),
        ` ${assets.pyodide} (Python ${assets.python} for WebAssembly, `,
        link(site("licenses/pyodide.txt"), "Mozilla Public License 2.0"),
        `) runs cv-tools ${assets.cvTools.version}. Its core (${PYODIDE_DIR}pyodide.asm.wasm) contains CPython and these libraries:`,
      ),
      table(["Component", "Licence", "Text"], noticeRows("python")),
      el("p", {}, "The Python packages:"),
      table(
        ["Package", "Version", "Licence", "Source"],
        assets.python_packages.map((p) => [link(site(`licenses/python/${p.name}.txt`), p.name), p.version, p.license || "see licence file", p.source]),
      ),
    );
    const npmBox = document.getElementById("npm")!;
    npmBox.replaceChildren(
      el(
        "p",
        {},
        "The live preview sets the CV in Computer Modern Unicode (",
        link("https://cm-unicode.sourceforge.io/", "cm-unicode"),
        " by Andrey V. Panov, after Donald Knuth's Computer Modern: CMU Serif and CMU Typewriter Text, as WOFF2 from the computer-modern package). " +
          "The math symbols that CMU lacks (≤ ≥ ∼ and a few others) come from Latin Modern Math by the GUST e-foundry, which the browser downloads only for a CV that uses one. " +
          "The LinkedIn, GitHub and Twitter icons are FontAwesome 4 glyphs (FontAwesome.otf of the fontawesome LaTeX package, by Dave Gandy), as resume.cls prints them. CMU and FontAwesome are under the SIL Open Font License 1.1, Latin Modern Math under the GUST Font License:",
      ),
      table(["Font", "Licence", "Text"], noticeRows("fonts")),
      el("p", {}, "The editor, the PDF viewer and the interface fonts (Inter and IBM Plex Mono, SIL Open Font License 1.1):"),
      table(
        ["Package", "Version", "Licence"],
        assets.npm_packages
          .filter((p) => p.name !== "pyodide")
          .map((p) => [p.file ? link(site(`licenses/npm/${p.file}`), p.name) : p.name, p.version, p.name === "computer-modern" ? "OFL-1.1 (fonts), MIT (package)" : p.license]),
      ),
    );
  } else {
    pyBox.replaceChildren(el("p", {}, "assets.json is missing from this build."));
  }
}

main();

sayHello();
