# Web engine

Fetches the pinned pdfTeX WebAssembly engine, builds the TeX bundle in `web/public/engine/` and tests it against the CLI. The runtime lives in `web/src/tex/`.

## Build and test

Needs Node 22.18+, a TeX Live from TUG's `install-tl` (Debian's `texlive-*` packages lack `tlpkg/texlive.tlpdb`), a Python with cv_tools (the repo's `.venv`, or set `PYTHON`), Poppler's `pdftoppm` and `pypdf`.

```sh
npm --prefix web/engine ci
npx --prefix web/engine playwright install chromium webkit
npm --prefix web/engine run fetch    # download and verify the release into .cache/
npm --prefix web/engine run build    # write web/public/engine/ (add -- --wasm-gz if the host does not compress)
npm --prefix web/engine test         # typecheck, then the Node and browser suites
```

`npm --prefix web/engine run mirror-sources -- <dir>` downloads the engine's source archives into `<dir>`. The `engine-sources.yml` workflow runs it and publishes them as a GitHub Release. Run it by hand before a release that changes `engine.lock.json`.

## Updating the engine

1. Pick a [SiglumProject/busytex](https://github.com/SiglumProject/busytex/releases) release.
2. In `engine.lock.json`, set `tag`, `sourceCommit`, `pdftex`, `texliveYear` and the archive name, URLs and SHA256.
3. Update the SHA256 of each file in `files`. `npm run fetch -- --force` names any file whose hash differs.
4. Update `sources` to match `sourceCommit` and the release's `versions.txt`, with each archive's size and SHA256. The build checks both commits.
5. Add a `components.json` entry for any new library (find a marker with `strings busytex.wasm`) and a `fonts` entry for any new font package.
6. Recopy any changed licence into `licenses/` and update its SHA256 in `licenses/index.json`.
7. Run fetch, build and test.

Upstream busytex/busytex releases ship an older pdfTeX and fail the parity tests.
