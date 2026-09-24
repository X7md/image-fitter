# Image Fitter

A small web app with two modes, picked from two cards on the start screen:

* **Fit** places one image on a target canvas: pick an aspect ratio or an exact
  resolution, align the image horizontally (Left / Center / Right) **and vertically
  (Top / Middle / Bottom)**, nudge it pixel by pixel, put a solid colour or a blurred copy
  of the image behind it, and download the result as a PNG.
* **Stack** joins two or more images in a **row, column or grid**. You can add a gap
  and choose its colour, optionally scale the images to a matching height (for rows and
  grids) or width (for columns), using the smallest, largest or first image as the
  reference, and align them to the start, center or end. You can also reorder, add and
  remove images. The stacked result then goes through the same Fit tools, so a stack
  can be framed at 1:1, 16:9 and so on. Until you type a size yourself, the target
  size follows the stack as it changes.

The UI is framework-free TypeScript with a dark, mobile-first "photo editor" layout: a
top action bar, a large image stage, a contextual option panel and a bottom tool strip
(Ratio / Size / Position / Background, plus Images / Layout / Sizing in Stack mode). It
works down to 360 px wide with no horizontal page scroll.

The rendering engine is **ImageMagick 7 (MagickCore + MagickWand) compiled to bare
`wasm32-wasip1`** — no Emscripten, no delegate libraries. The JavaScript side ships its
own minimal WASI preview1 shim plus an in-memory filesystem, and a typed MagickWand
binding layer. The browser decodes the input file and encodes the final PNG; everything
in between (Lanczos resize, append, blur, Over composite) happens inside the wasm module.

The engine runs in a Web Worker and is loaded **before** the editor appears (a boot
screen covers the wait). The live preview is not a Canvas 2D approximation: every
option change asks the worker for a reduced-size MagickWand render of the exact same
pipeline, and Save renders it at full resolution. The preview canvas only displays
frames, which is also why the blur works on iOS Safari (it ignores `ctx.filter`).

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
npm test              # Node bitmap tests: tsx + node:test, 52 tests
npm run test:browser  # headless-Chrome end-to-end test, 308 checks
```

* **Node tests** (`tests/node/`) load the committed `src/wasm/magick.wasm` through *our*
  WASI shim, build synthetic RGBA bitmaps (four solid quadrants, gradients), run
  `Fitter.fit` for every alignment and background mode, and assert actual pixel values —
  quadrant colours inside the placement rectangle, background colour outside it.
  `stack.test.ts` runs `Fitter.stack` for every layout × alignment × match combination
  and checks that each image lands exactly on the cell `planStack` predicts. They
  also exercise the raw syscall surface of the shim, the bindings' error paths, memory
  stability over repeated fits, and BMP/PNM/PAM round trips. Outputs land in
  `tests/out/*.bmp` for eyeballing.
* **Browser test** (`tests/browser/run.ts`) serves `dist/` over HTTP, opens it in the
  *system* Chrome via `puppeteer-core` (override the binary with `CHROME_PATH`), and
  drives the real UI with real clicks and keystrokes: every ratio chip, the size inputs
  and swap, all six alignment chips, D-pad nudges including hold-to-repeat, keyboard
  nudges, colour and blur backgrounds, a real BMP uploaded through the file input,
  Save, and a Stack session (layouts, columns, gap, match, align, reorder, remove,
  a 1:1 fit of the stack, and Back to the intro). After each interaction it runs the wasm fit and asserts the output dimensions
  and pixels, compares the full-resolution wasm result against the engine's preview
  frame on a sampling grid, checks that the preview canvas really shows the blur,
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
only from `wasi_snapshot_preview1` and exports the 50 MagickWand symbols the bindings
need plus `malloc`, `free`, `memory` and `_initialize` (54 in total). See `wasm/README.md` for the
flags, the patches and why each one exists.

## Layout

```
index.html           app shell
src/main.ts          boots the UI
src/ui/              boot screen, store, stage (frame blitting), option panels, app wiring, debug hook
src/engine/worker.ts the engine worker (owns the wasm instance and the source pixels)
src/engine/client.ts main-thread handle on the worker (addImage / render preview|full)
src/engine/types.ts  Bitmap/FitOptions/StackOptions + the pure math (computePlacement, planStack)
src/engine/fitter.ts the fit and stack pipelines on MagickWand
src/wasm/            WASI shim, MagickWand bindings, enums, and the committed magick.wasm
wasm/                the native build (build.sh, config headers, patches)
tests/node/          Node bitmap tests
tests/browser/       headless-Chrome end-to-end test
```

`ARCHITECTURE.md` is the full contract the implementation follows.
