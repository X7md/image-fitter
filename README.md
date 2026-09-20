# Image Fitter

A small web app that fits an image into a target canvas: pick an aspect ratio or an exact
resolution, align the image horizontally (Left / Center / Right) **and vertically
(Top / Middle / Bottom)**, nudge it pixel by pixel, put a solid colour or a blurred copy
of the image behind it, and download the result as a PNG.

The UI is framework-free TypeScript with a dark, mobile-first "photo editor" layout: a
top action bar, a large image stage, a contextual option panel and a bottom tool strip
(Ratio / Size / Position / Background). It works down to 360 px wide with no horizontal
page scroll.

The rendering engine is **ImageMagick 7 (MagickCore + MagickWand) compiled to bare
`wasm32-wasip1`** — no Emscripten, no delegate libraries. The JavaScript side ships its
own minimal WASI preview1 shim plus an in-memory filesystem, and a typed MagickWand
binding layer. The browser decodes the input file and encodes the final PNG; everything
in between (Lanczos resize, blur, Over composite) happens inside the wasm module.

## Running it

```bash
npm install
npm run dev        # vite dev server
npm run build      # tsc + vite build  ->  dist/
npm run preview    # serve the production build
```

`dist/` is fully static: the app is `index.html` + one JS bundle + one CSS file + the
2.5 MB `magick.wasm` asset.

## Tests

```bash
npm run typecheck     # app (tsconfig.json) and tests (tsconfig.test.json)
npm test              # Node bitmap tests: tsx + node:test, 49 tests
npm run test:browser  # headless-Chrome end-to-end test, 250 checks
```

* **Node tests** (`tests/node/`) load the committed `src/wasm/magick.wasm` through *our*
  WASI shim, build synthetic RGBA bitmaps (four solid quadrants, gradients), run
  `Fitter.fit` for every alignment and background mode, and assert actual pixel values —
  quadrant colours inside the placement rectangle, background colour outside it. They
  also exercise the raw syscall surface of the shim, the bindings' error paths, memory
  stability over repeated fits, and BMP/PNM/PAM round trips. Outputs land in
  `tests/out/*.bmp` for eyeballing.
* **Browser test** (`tests/browser/run.ts`) serves `dist/` over HTTP, opens it in the
  *system* Chrome via `puppeteer-core` (override the binary with `CHROME_PATH`), and
  drives the real UI with real clicks and keystrokes: every ratio chip, the size inputs
  and swap, all six alignment chips, D-pad nudges including hold-to-repeat, keyboard
  nudges, colour and blur backgrounds, a real BMP uploaded through the file input, and
  Save. After each interaction it runs the wasm fit and asserts the output dimensions
  and pixels, compares the wasm result against the Canvas-2D preview on a sampling grid,
  verifies the downloaded PNG's signature and IHDR size, and fails on any console error.
  Screenshots are written to `tests/out/browser-*.png`.

## The wasm build

`src/wasm/magick.wasm` is **committed**, so nothing above needs a native toolchain. To
rebuild it, run `bash wasm/build.sh` (Git Bash on Windows) with
[wasi-sdk](https://github.com/WebAssembly/wasi-sdk) 33 installed: the script downloads
ImageMagick 7.1.2-31, applies six minimal `__wasi__`-guarded patches, copies the
hand-authored config headers from `wasm/config/`, compiles all 264 translation units in
parallel with `clang --target=wasm32-wasip1 -O2 -mexec-model=reactor` (Q8, no HDRI, no
threads, no OpenMP, static coders, zero-configuration, no delegates), links with an
explicit export list and a 1 MiB shadow stack, and strips debug info. The result imports
only from `wasi_snapshot_preview1` and exports the 49 MagickWand symbols the bindings
need plus `malloc`, `free`, `memory` and `_initialize`. See `wasm/README.md` for the
flags, the patches and why each one exists.

## Layout

```
index.html           app shell
src/main.ts          boots the UI
src/ui/              store, stage/canvas preview, option panels, app wiring, debug hook
src/engine/types.ts  Bitmap/FitOptions types + the pure placement math (computePlacement)
src/engine/fitter.ts the fit pipeline on MagickWand
src/wasm/            WASI shim, MagickWand bindings, enums, and the committed magick.wasm
wasm/                the native build (build.sh, config headers, patches)
tests/node/          Node bitmap tests
tests/browser/       headless-Chrome end-to-end test
```

`ARCHITECTURE.md` is the full contract the implementation follows.
