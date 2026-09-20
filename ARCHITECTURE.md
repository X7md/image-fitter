# Image Fitter — architecture contract

Ground-up rewrite of the "Image Fitter" web app. Same user-facing functionality as
before (fit an image into a target canvas: aspect-ratio presets, custom resolution,
alignment + pixel nudging, solid-color or blurred background, download as PNG, reset),
but with a new engine and UI:

* **Engine**: ImageMagick 7 (MagickCore + MagickWand C API) compiled to **bare
  wasm32-wasip1** with wasi-sdk 33 (`C:\wasi-sdk-33.0-x86_64-windows`). **No
  Emscripten.** The JS side provides its own minimal WASI shim + in-memory FS and a
  typed MagickWand binding layer.
* **UI**: layout modelled after the Android "Photo Editor" app (dev.macgyver / iudesk):
  dark editor chrome, top action bar, large centered image stage, a bottom *tool strip*
  of icon+label tabs, and a contextual *option panel* that slides up above the strip for
  the selected tool. Only the *fit* tools exist. Nothing else.

Everything below is a contract. Agents working in parallel must implement exactly these
names/paths/semantics so the parts fit together without negotiation.

## Repository layout (target)

```
ARCHITECTURE.md              this file
README.md                    what it is, how to run / build / test
index.html                   app shell (UI)
package.json                 vite + typescript (+ dev deps: tsx, puppeteer-core, @types/node)
vite.config.ts
tsconfig.json                app sources
tsconfig.test.json           app + tests, with the node typings (npm run typecheck)
public/                      static assets (empty: the favicon is an inline data: URI)
src/
  main.ts                    boots the UI
  style.css                  UI styles (dark editor theme)
  ui/                        UI modules (UI agent owns; free to structure)
  engine/
    types.ts                 shared types (Bitmap, FitOptions, ...) + pure math
    fitter.ts                Fitter class: runs the fit on MagickWand
  wasm/
    wasi.ts                  minimal WASI preview1 shim + MemFS  (bindings agent)
    magick.ts                typed MagickWand bindings           (bindings agent)
    enums.ts                 numeric enums copied from IM headers (bindings agent)
    magick.wasm              built artifact (COMMITTED to git)   (build agent)
    exports.txt              list of exported symbols            (build agent)
wasm/                        native build (build agent owns)
  build.sh                   one-shot build script (Git Bash / Linux)
  README.md                  how the build works, flags, what was patched and why
  config/                    hand-authored / configure-generated headers
  patches/                   minimal source patches (if any)
  ImageMagick/               downloaded source tree (gitignored)
  out/                       object files (gitignored)
tests/
  node/                      Node-based bitmap tests (tsx + node:test)
  browser/run.ts             headless-Chrome end-to-end test (puppeteer-core, system Chrome)
  out/                       generated BMPs, screenshots, downloads (gitignored)
```

Remove from the old project: `src/counter.ts`, `src/typescript.svg`, the
`@imagemagick/magick-wasm` dependency, the `optimizeDeps.exclude` for it.

## 1. WASM module contract (`src/wasm/magick.wasm`)

* Target `wasm32-wasip1`, **reactor** model (`-mexec-model=reactor`), so the module
  exports `_initialize` (must be called once after instantiation) and `memory`.
* Imports only from `wasi_snapshot_preview1`. No other import namespaces.
* Build: ImageMagick 7.1.2 (latest tag), **Q8, no HDRI** (`MAGICKCORE_QUANTUM_DEPTH=8`,
  `MAGICKCORE_HDRI_ENABLE=0`), static coders (`MAGICKCORE_BUILD_MODULES` off),
  zero-configuration (`MAGICKCORE_ZERO_CONFIGURATION_SUPPORT`), **no threads / no
  OpenMP**, **no delegate libraries at all** (no zlib/png/jpeg/webp/tiff/xml/freetype/...).
  Pixel I/O happens through raw RGBA buffers; the browser decodes/encodes PNG/JPEG/etc.
  The only encoded formats we rely on inside wasm are the built-in delegate-free coders
  **BMP** (and PNM/PAM/RGBA raw) which are used by the Node tests.
* No setjmp/longjmp, no exceptions, no `system()`/`popen`/`fork`, no sockets, no mmap.
* Link flags: `-Wl,--export=<sym>` for every symbol below, `-Wl,--export=malloc
  -Wl,--export=free`, `-Wl,--initial-memory=` modest (e.g. 64 MiB),
  `-Wl,--max-memory=2147483648`, growable memory, `-O2` (or `-O3`), `-flto` optional.
  Strip debug info in the committed artifact.
* Write the final export list (one symbol per line) to `src/wasm/exports.txt`.

### Required exports (C names, exact MagickWand 7 signatures)

Lifecycle / errors
```
MagickWandGenesis  MagickWandTerminus  IsMagickWandInstantiated
NewMagickWand  DestroyMagickWand  CloneMagickWand  ClearMagickWand  IsMagickWand
MagickGetException  MagickGetExceptionType  MagickClearException  MagickRelinquishMemory
MagickGetVersion  MagickQueryFormats  MagickSetResourceLimit  MagickGetResourceLimit
```
Pixel wand
```
NewPixelWand  DestroyPixelWand  PixelSetColor  PixelSetAlpha  PixelSetRed  PixelSetGreen  PixelSetBlue
```
Image creation / pixel I/O
```
MagickNewImage  MagickConstituteImage  MagickImportImagePixels  MagickExportImagePixels
MagickReadImageBlob  MagickGetImageBlob  MagickSetImageFormat  MagickGetImageFormat
MagickGetImageWidth  MagickGetImageHeight  MagickSetImageDepth  MagickGetImageDepth
MagickSetImageAlphaChannel  MagickSetImageBackgroundColor  MagickGetNumberImages  MagickResetIterator
```
Operations
```
MagickResizeImage  MagickScaleImage  MagickBlurImage  MagickGaussianBlurImage
MagickCompositeImage  MagickExtentImage  MagickSetImageGravity  MagickCropImage
```
Memory
```
malloc  free  memory  _initialize
```
If a listed symbol doesn't exist in IM 7.1.2 exactly as named, export the closest 7.x
equivalent and document it in `wasm/README.md` and `src/wasm/exports.txt`.

**As built**: every symbol above exists verbatim in 7.1.2 — no substitutions. The
artifact is 2 508 648 bytes with 51 exports (the 49 above plus `memory` and
`_initialize`). Two link flags beyond the list are load-bearing: `-Wl,--stack-first`
(so a shadow-stack overflow traps instead of corrupting data) and
`-Wl,-z,stack-size=1048576` — the default 64 KiB shadow stack is **not** enough:
`ReadPNMImage` overflows it and traps. A wasm trap does not restore `__stack_pointer`,
so a trapped instance is unrecoverable and must be discarded, never retried.

## 2. WASI shim contract (`src/wasm/wasi.ts`)

```ts
export class MemFS { /* in-memory file system: Map<string, Uint8Array>, dirs */
  writeFile(path: string, data: Uint8Array): void
  readFile(path: string): Uint8Array | undefined
  exists(path: string): boolean
  remove(path: string): void
  list(dir: string): string[]
}
export interface WasiOptions {
  fs?: MemFS
  args?: string[]
  env?: Record<string, string>
  stdout?: (text: string) => void   // default: console.log
  stderr?: (text: string) => void   // default: console.error
  preopens?: Record<string, string> // guest path -> MemFS dir, default { '/': '/' }
  debug?: boolean                   // warn once per ENOSYS-stubbed syscall (as built)
}
export class Wasi {
  constructor(opts?: WasiOptions)
  readonly fs: MemFS
  /** Import object. Includes every wasi_snapshot_preview1 function the module asks
   *  for: real implementations for the ones we need, and an auto-generated ENOSYS
   *  stub for anything else (built from WebAssembly.Module.imports(module)). */
  imports(module: WebAssembly.Module): WebAssembly.Imports
  /** Bind memory + call `_initialize` (reactor) if present. */
  initialize(instance: WebAssembly.Instance): void
}
```
Implemented calls (real): `args_get, args_sizes_get, environ_get, environ_sizes_get,
clock_res_get, clock_time_get, fd_close, fd_fdstat_get, fd_fdstat_set_flags,
fd_filestat_get, fd_prestat_get, fd_prestat_dir_name, fd_read, fd_pread, fd_write,
fd_pwrite, fd_seek, fd_tell, fd_sync, fd_readdir, path_open, path_filestat_get,
path_unlink_file, path_create_directory, path_remove_directory, path_rename,
poll_oneoff (sleep only), proc_exit (throws WasiExit), random_get, sched_yield`.
Everything else: stub returning ERRNO_NOSYS (52). fd 0/1/2 are stdin(empty)/stdout/stderr;
fd 3 is the preopened root dir. Text written to stdout/stderr is line-buffered and
forwarded to the callbacks. Works in both Node 22 and browsers (no Node imports).

## 3. MagickWand bindings contract (`src/wasm/magick.ts`)

```ts
export class MagickError extends Error { severity: number }
export interface LoadOptions { wasi?: WasiOptions; memoryLimitBytes?: number }
export async function loadMagick(source: BufferSource | WebAssembly.Module | Response | Promise<Response> | URL | string, opts?: LoadOptions): Promise<Magick>

export class Magick {
  readonly memory: WebAssembly.Memory
  readonly exports: MagickExports         // raw typed exports
  readonly version: string                // from MagickGetVersion
  // memory helpers
  alloc(bytes: number): number
  free(ptr: number): void
  cstring(s: string): number              // malloc + utf8 encode + NUL; caller frees
  readCString(ptr: number): string
  writeBytes(data: Uint8Array): number    // malloc + copy; caller frees
  readBytes(ptr: number, len: number): Uint8Array  // COPY out of wasm memory
  view(): DataView                        // fresh view (memory may grow)
  // wands
  newWand(): MagickWand
  newPixel(color?: string): PixelWand
  formats(): string[]                     // MagickQueryFormats('*')
  terminate(): void
}
export class PixelWand { ptr: number; setColor(color: string): void; setAlpha(a: number): void; dispose(): void }
export class MagickWand {
  ptr: number
  readonly width: number; readonly height: number
  newImage(width: number, height: number, background: PixelWand | string): void
  constitute(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): void   // 'RGBA' CharPixel
  exportRGBA(x?: number, y?: number, w?: number, h?: number): Uint8ClampedArray             // copy
  readBlob(data: Uint8Array): void
  writeBlob(format: string): Uint8Array   // setFormat + getImageBlob + relinquish; copy
  resize(w: number, h: number, filter?: FilterType): void
  scale(w: number, h: number): void
  blur(radius: number, sigma: number): void
  gaussianBlur(radius: number, sigma: number): void
  composite(src: MagickWand, op: CompositeOperator, x: number, y: number, clipToSelf?: boolean): void
  extent(w: number, h: number, x: number, y: number): void
  setBackground(color: string): void
  setAlphaChannel(op: AlphaChannelOption): void
  setDepth(d: number): void
  clone(): MagickWand
  dispose(): void
  /** Every call above checks the MagickBooleanType result and throws MagickError with
   *  MagickGetException text + severity (and clears the exception). */
}
```
`src/wasm/enums.ts` holds `FilterType`, `CompositeOperator`, `StorageType`,
`AlphaChannelOption`, `ResourceType`, `GravityType`, `ExceptionType` as `const` objects
whose numeric values are copied from the IM 7.1.2 headers in
`wasm/ImageMagick/MagickCore/*.h` (`resample.h`, `composite.h`, `pixel.h`, `channel.h`,
`resource_.h`, `geometry.h`, `exception.h`). Verify each value against the header — do
not guess.

**As built**, two things differ from the sketch above and are correct as implemented:
`AlphaChannelOption` lives in `channel.h`, not `image.h`; and `ExceptionType` is *not*
contiguous (Warning 300, Error 400, MissingDelegateError 420, …), so its literals are
copied rather than counted. The C signature of `MagickCompositeImage` is
`(dst, src, compose, clip_to_self, x, y)` — the TS surface keeps the
`composite(src, op, x, y, clipToSelf?)` order above and reorders internally. Strings from
`MagickGetException` / `MagickGetImageBlob` / `MagickGetImageFormat` / `MagickQueryFormats`
must be released with `MagickRelinquishMemory`, never `free`. `loadMagick` sets the Disk
and Map resource limits to 0 right after genesis so the pixel cache can never spill into
the MemFS.

## 4. Engine contract (`src/engine/types.ts`, `src/engine/fitter.ts`)

```ts
// types.ts — pure, no DOM, no wasm; used by UI preview and by the wasm fitter
export interface Bitmap { width: number; height: number; data: Uint8ClampedArray } // RGBA8, straight alpha
export type Align = 'left' | 'center' | 'right'     // horizontal
export type AlignY = 'top' | 'center' | 'bottom'    // vertical (section 8, implemented)
export type AspectPreset = '1:1' | '16:9' | '4:3' | '3:2' | 'custom'
export type Background =
  | { mode: 'color'; color: string }   // '#rrggbb'
  | { mode: 'blur'; sigma: number }    // 1..20, blurred copy of the source stretched to the target
export interface FitOptions {
  width: number; height: number        // target canvas, integers >= 1
  align: Align
  alignY: AlignY                       // section 8; default 'center'
  offsetX: number; offsetY: number     // pixel nudge applied after alignment
  background: Background
}
export interface Placement { x: number; y: number; width: number; height: number }
/** scale = min(W/srcW, H/srcH); w = round(srcW*scale); h = round(srcH*scale);
 *  x = offsetX + (left: 0 | center: round((W-w)/2) | right: W-w);
 *  y = offsetY + (top: 0 | center: round((H-h)/2) | bottom: H-h)   // alignY, section 8 */
export function computePlacement(srcW: number, srcH: number, o: FitOptions): Placement
/** Same rules as the old app: '1:1' -> square of max(srcW,srcH); other presets -> the
 *  larger-area of (srcH*r x srcH) and (srcW x srcW/r), rounded; 'custom' -> unchanged. */
export function presetDimensions(preset: AspectPreset, srcW: number, srcH: number): { width: number; height: number }
export const DEFAULT_OPTIONS: Omit<FitOptions, 'width' | 'height'>  // center, 0/0, color '#ffffff'
export const BLUR_RANGE = { min: 1, max: 20, default: 10 }
// plus, as built, the small helpers the UI and tests share:
export const ASPECT_PRESETS: readonly AspectPreset[]
export const ALIGNS: readonly Align[]
export const ALIGNS_Y: readonly AlignY[]
export const FALLBACK_SIZE = { width: 800, height: 600 }
export function coerceDimension(value: string | number, fallback: number): number
export function clampSigma(value: number): number

// fitter.ts
export class Fitter {
  constructor(magick: Magick)
  /** Renders `src` into a width x height RGBA bitmap per FitOptions using MagickWand:
   *  1) new image WxH filled with background color (or: clone src, resize to WxH, blur(0, sigma));
   *  2) resize src to placement w x h (Lanczos); 3) composite Over at placement x,y;
   *  4) export RGBA. All wands disposed even on error. */
  fit(src: Bitmap, options: FitOptions): Bitmap
  /** Encode a bitmap with a built-in IM coder, e.g. 'BMP' (used by tests) */
  encode(bitmap: Bitmap, format: 'BMP' | 'PNM' | 'PAM'): Uint8Array
  decode(data: Uint8Array): Bitmap   // via MagickReadImageBlob (BMP etc.)
}
export async function createFitter(source: Parameters<typeof loadMagick>[0], opts?: LoadOptions): Promise<Fitter>
```

## 5. UI contract

* **Wasm first.** `src/main.ts` imports `./style.css` and calls `boot()`
  (`src/ui/boot.ts`): it starts the engine worker (`src/engine/worker.ts`, which owns
  `import wasmUrl from '../wasm/magick.wasm?url'` + `createFitter(wasmUrl)`), shows a
  boot screen (`#boot`) until the worker reports `ready`, then reveals `#appShell` and
  calls `startApp(engine, version)`. If the engine fails to load the boot screen shows
  the error and a Retry button; the editor is never shown without an engine.
* **Engine in a worker.** `src/engine/client.ts` (`EngineClient`) talks to the worker
  over the protocol in `src/engine/protocol.ts`: `setSource(bitmap)` transfers the
  decoded RGBA pixels once (the worker also keeps a Lanczos-downscaled copy capped at
  `PREVIEW_LONG_SIDE` = 1280 px); `fit(options, 'preview' | 'full')` renders. Requests
  are processed in order; a wasm trap reloads the module inside the worker and retries once.
* **Live preview is rendered by MagickWand**, not by Canvas 2D: every change to the
  options schedules a `'preview'` fit (latest-wins: one in flight, the newest options
  render next). The worker scales target size, offsets and blur sigma by
  `previewScale(W, H)` and fits the downscaled source, so the frame is the real pipeline
  at reduced size. The result is blitted onto `#previewCanvas` with `putImageData`; the
  canvas is a display surface only (no `ctx.filter`, which iOS Safari ignores). While a
  render is pending the stage gets `is-rendering` and the size badge shows a pulsing dot.
* **Save/Download** runs the same fit at `'full'` quality in the worker, encodes PNG
  with a canvas (`toBlob('image/png')`), and downloads `fitted-image-<W>x<H>.png`.
  Busy state on the Save button while rendering; no preview-canvas fallback (a failed
  engine shows a toast and `state.engine = 'failed'`).
* Debug hook for tests: `window.__imageFitter = { state, engine: EngineClient,
  engineVersion, lastResult?: Bitmap, loadBitmap(b: Bitmap): void,
  render(): Promise<Bitmap>, whenIdle(): Promise<void> }` (typed in `src/ui/debug.ts`);
  it is installed once the engine is ready, so `state.engine` starts as `'ready'`.
  `whenIdle()` resolves once the preview frame for the current options is on the canvas.
  `state` is the live store object; besides the fields above it carries `toast`
  (`{ text, kind: 'error' | 'info' } | null`), `dragging`, `color` and `sigma` (the last
  colour / sigma, so switching Color <-> Blur is lossless).
* Layout (Photo Editor-like, dark):
  - **Top bar**: app name at left; right side icon buttons: *Open* (file picker),
    *Reset*, *Save*.
  - **Stage**: fills the remaining space, neutral dark background, the preview canvas
    letterboxed and centered, showing the target canvas at fit-to-screen scale, with a
    small "W × H" badge.
  - Empty state (no image): big drop zone in the stage: "Drop an image here or tap to open".
  - **Option panel** (above tool strip; content depends on active tool):
    * *Ratio*: chips 1:1, 16:9, 4:3, 3:2, Custom.
    * *Size*: width and height number inputs (+ a "swap" button).
    * *Position*: chips Left / Center / Right; D-pad arrows (hold to repeat: 500 ms
      delay then every 50 ms) with mouse + touch; nudge readout "dx, dy".
    * *Background*: chips Color / Blur; color input; blur intensity range 1..20 with
      value readout (only for Blur).
  - **Tool strip** (bottom, horizontally scrollable on narrow screens): Ratio, Size,
    Position, Background — icon above label, active one highlighted (accent color).
  - Keyboard: arrows nudge when Position tool active; drag & drop anywhere on stage.
  - Mobile-first, works down to 360 px wide; no horizontal page scroll.
* Behaviour parity with the old app: on load, target size = source size and preset =
  Custom; changing alignment resets offsetX; Reset restores center/0,0/source size/
  white color background/Custom; width/height inputs fall back to 800/600 when empty.

## 6. Tests

* `tests/node/*.test.ts` run with `npx tsx --test "tests/node/*.test.ts"` (node:test +
  node:assert). The bare directory form the contract first spelled
  (`tsx --test tests/node/`) fails on Node 22 with `ERR_UNSUPPORTED_DIR_IMPORT`, hence
  the glob; same files, same runner.
  They load `src/wasm/magick.wasm` through **our** `Wasi` shim (not `node:wasi`),
  generate synthetic RGBA bitmaps (gradient + solid rectangle), run `Fitter.fit` with
  each alignment / background mode, and assert pixels (background color where expected,
  source colors inside the placement rect, output dims). They also round-trip BMP via
  `encode`/`decode` and write a few `.bmp` files to `tests/out/` for eyeballing.
* `tests/browser/run.ts` (a single runner with its own check counter, not `node:test`,
  because everything shares one browser session) uses `puppeteer-core` with the system
  Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`, override via
  `CHROME_PATH`), serves `dist/` (after `vite build`) with a tiny static server that
  sends `application/wasm` for the module, opens the app, loads a synthetic bitmap
  through the debug hook *and* uploads a wasm-encoded BMP through the file input, drives
  the UI with real clicks/keystrokes (every ratio chip, size inputs + swap, all six
  alignment chips, D-pad including hold-to-repeat, arrow keys, colour and blur), asserts
  the pixels of each `window.__imageFitter.render()` result, cross-checks the wasm output
  against the Canvas-2D preview on a sampling grid, verifies the Saved PNG (signature +
  IHDR dimensions, downloaded via `Browser.setDownloadBehavior`), checks the 390 px
  mobile layout, and fails on any console error or page exception. Screenshots go to
  `tests/out/browser-*.png`.
* `npm test` runs the Node tests; `npm run test:browser` the Chrome test;
  `npm run typecheck` type-checks both the app and the tests.

## 7. Conventions

* TypeScript strict, `verbatimModuleSyntax`, no `any` leaking from bindings.
* No new runtime dependencies. Dev deps allowed: `tsx`, `puppeteer-core`.
* Windows dev box: run scripts from Git Bash; `make` is NOT available; use bash +
  `xargs -P`. Node 22, npm 10.
* Do not commit. The orchestrator reviews and commits.

## 8. CHANGE REQUEST — vertical alignment (Top / Bottom) — IMPLEMENTED

Added by the user while the rewrite was in progress. The build, UI and bindings agents
worked against the horizontal-only contract above; the final verify agent implemented
this change everywhere (types, fitter, UI, tests). It is done — the points below now
describe the shipped behaviour, not a request.

* `FitOptions` gains `alignY: 'top' | 'center' | 'bottom'` (default `'center'`), next
  to the existing horizontal `align`. `DEFAULT_OPTIONS` includes `alignY: 'center'`.
* `computePlacement`: `y = offsetY + (top: 0 | center: round((H-h)/2) | bottom: H-h)`.
* Behaviour parity: changing `alignY` resets `offsetY` to 0 (mirrors `align` resetting
  `offsetX`); Reset restores `alignY: 'center'`.
* UI, *Position* panel: a second chip row under the horizontal one:
  **Top / Middle / Bottom** (`data-align-y="top|center|bottom"`, `aria-pressed`), same
  chip style as Left / Center / Right. Live preview and wasm render both honour it.
* Tests: Node tests cover top/bottom placement pixels (source pixels touch the top
  edge for `top`, the bottom edge for `bottom`, background elsewhere); the browser test
  clicks the Top and Bottom chips and checks `render()` output.
* `README.md` mentions vertical alignment.

Note for anyone extending the tests: contain-fit gives slack on **one axis only**. With
a 4:3 source, a target wider than 4:3 leaves horizontal bands (so Left/Center/Right is
observable and Top/Middle/Bottom is a no-op) and a taller target does the reverse. The
browser test therefore switches the target size between the horizontal and the vertical
alignment steps.
