/**
 * Typed MagickWand 7 bindings over the bare `wasm32-wasip1` build in `magick.wasm`.
 *
 * ABI notes (wasm32):
 *   - `size_t`, `ssize_t` and every pointer are i32 -> plain JS numbers.
 *   - `double` is f64 -> plain JS numbers.
 *   - `MagickSizeType` (used by the resource-limit calls) is u64 -> **BigInt**.
 *   - `MagickBooleanType` is i32: 0 = MagickFalse, 1 = MagickTrue.
 *
 * Every wrapper method checks the MagickBooleanType/pointer result and, on failure,
 * reads `MagickGetException`, releases the string with `MagickRelinquishMemory`, clears
 * the exception and throws a `MagickError`.
 *
 * Wasm memory grows, which detaches existing ArrayBuffer views. Nothing here caches a
 * typed-array view across a call that can allocate; `view()` / `bytes()` build fresh ones.
 */

import {
  AlphaChannelOption,
  CompositeOperator,
  ExceptionType,
  FilterType,
  GravityType,
  ResourceType,
  StorageType,
  exceptionSeverityName,
} from './enums'
import { Wasi } from './wasi'
import type { WasiOptions } from './wasi'

/* ------------------------------------------------------------------- errors -- */

/** An ImageMagick exception surfaced as a JS error. `severity` is an `ExceptionType`. */
export class MagickError extends Error {
  readonly severity: number
  constructor(message: string, severity: number) {
    super(message)
    this.name = 'MagickError'
    this.severity = severity
  }
}

/* ------------------------------------------------------------------ exports -- */

/**
 * The raw exported C functions, one entry per line of `src/wasm/exports.txt`.
 * Pointers/`size_t`/`ssize_t`/enums are `number`; `MagickSizeType` is `bigint`.
 */
export interface MagickExports {
  readonly memory: WebAssembly.Memory
  _initialize(): void

  malloc(size: number): number
  free(ptr: number): void

  /* lifecycle / errors */
  MagickWandGenesis(): void
  MagickWandTerminus(): void
  IsMagickWandInstantiated(): number
  NewMagickWand(): number
  DestroyMagickWand(wand: number): number
  CloneMagickWand(wand: number): number
  ClearMagickWand(wand: number): void
  IsMagickWand(wand: number): number
  MagickGetException(wand: number, severityPtr: number): number
  MagickGetExceptionType(wand: number): number
  MagickClearException(wand: number): number
  MagickRelinquishMemory(ptr: number): number
  MagickGetVersion(versionNumberPtr: number): number
  MagickQueryFormats(patternPtr: number, countPtr: number): number
  MagickSetResourceLimit(type: number, limit: bigint): number
  MagickGetResourceLimit(type: number): bigint

  /* pixel wand */
  NewPixelWand(): number
  DestroyPixelWand(wand: number): number
  PixelSetColor(wand: number, colorPtr: number): number
  PixelSetAlpha(wand: number, alpha: number): void
  PixelSetRed(wand: number, red: number): void
  PixelSetGreen(wand: number, green: number): void
  PixelSetBlue(wand: number, blue: number): void

  /* image creation / pixel I/O */
  MagickNewImage(wand: number, columns: number, rows: number, background: number): number
  MagickConstituteImage(
    wand: number,
    columns: number,
    rows: number,
    mapPtr: number,
    storage: number,
    pixelsPtr: number,
  ): number
  MagickImportImagePixels(
    wand: number,
    x: number,
    y: number,
    columns: number,
    rows: number,
    mapPtr: number,
    storage: number,
    pixelsPtr: number,
  ): number
  MagickExportImagePixels(
    wand: number,
    x: number,
    y: number,
    columns: number,
    rows: number,
    mapPtr: number,
    storage: number,
    pixelsPtr: number,
  ): number
  MagickReadImageBlob(wand: number, blobPtr: number, length: number): number
  MagickGetImageBlob(wand: number, lengthPtr: number): number
  MagickSetImageFormat(wand: number, formatPtr: number): number
  MagickGetImageFormat(wand: number): number
  MagickGetImageWidth(wand: number): number
  MagickGetImageHeight(wand: number): number
  MagickSetImageDepth(wand: number, depth: number): number
  MagickGetImageDepth(wand: number): number
  MagickSetImageAlphaChannel(wand: number, option: number): number
  MagickSetImageBackgroundColor(wand: number, pixel: number): number
  MagickGetNumberImages(wand: number): number
  MagickResetIterator(wand: number): void

  /* image lists */
  /** Clones every image of `add` into `wand`, after the current image. */
  MagickAddImage(wand: number, add: number): number
  /** Returns a NEW wand (or 0) holding the images from the current one onwards appended
   *  into one; `stack` 1 = top-to-bottom, 0 = left-to-right. */
  MagickAppendImages(wand: number, stack: number): number
  MagickSetLastIterator(wand: number): void

  /* operations */
  MagickResizeImage(wand: number, columns: number, rows: number, filter: number): number
  MagickScaleImage(wand: number, columns: number, rows: number): number
  MagickBlurImage(wand: number, radius: number, sigma: number): number
  MagickGaussianBlurImage(wand: number, radius: number, sigma: number): number
  /** NOTE the C order: (dst, src, compose, clip_to_self, x, y). */
  MagickCompositeImage(
    dst: number,
    src: number,
    compose: number,
    clipToSelf: number,
    x: number,
    y: number,
  ): number
  MagickExtentImage(wand: number, width: number, height: number, x: number, y: number): number
  MagickSetImageGravity(wand: number, gravity: number): number
  MagickCropImage(wand: number, width: number, height: number, x: number, y: number): number
}

/* ------------------------------------------------------------------ loading -- */

export interface LoadOptions {
  wasi?: WasiOptions
  /** Cap ImageMagick's in-memory pixel cache (`MemoryResource` / `AreaResource`). */
  memoryLimitBytes?: number
}

export type MagickSource =
  | BufferSource
  | WebAssembly.Module
  | Response
  | Promise<Response>
  | URL
  | string

async function compile(source: MagickSource): Promise<WebAssembly.Module> {
  if (source instanceof WebAssembly.Module) return source
  if (typeof source === 'string' || source instanceof URL) {
    return compile(fetch(String(source)))
  }
  if (source instanceof Response || (typeof Promise !== 'undefined' && isPromise(source))) {
    const response = await (source as Promise<Response>)
    if (!response.ok) {
      throw new Error(`loadMagick: fetching the wasm failed with HTTP ${response.status}`)
    }
    if (typeof WebAssembly.compileStreaming === 'function') {
      try {
        return await WebAssembly.compileStreaming(Promise.resolve(response.clone()))
      } catch {
        // Wrong Content-Type (common with static servers): fall back to a buffer compile.
      }
    }
    return WebAssembly.compile(await response.arrayBuffer())
  }
  return WebAssembly.compile(source as BufferSource)
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}

/** Compile + instantiate the module through our WASI shim and bring MagickWand up. */
export async function loadMagick(source: MagickSource, opts: LoadOptions = {}): Promise<Magick> {
  const module = await compile(source)
  const wasi = new Wasi(opts.wasi)
  const instance = await WebAssembly.instantiate(module, wasi.imports(module))
  wasi.initialize(instance)
  return new Magick(instance, wasi, opts)
}

/* ------------------------------------------------------------------- Magick -- */

const utf8Encoder = /* @__PURE__ */ new TextEncoder()
const utf8Decoder = /* @__PURE__ */ new TextDecoder()

export class Magick {
  readonly memory: WebAssembly.Memory
  readonly exports: MagickExports
  readonly version: string

  private readonly wasi: Wasi
  private terminated = false

  constructor(instance: WebAssembly.Instance, wasi: Wasi, opts: LoadOptions = {}) {
    this.exports = instance.exports as unknown as MagickExports
    this.memory = this.exports.memory
    this.wasi = wasi

    this.exports.MagickWandGenesis()

    // Keep every pixel cache in linear memory: `DiskResource` defaults to unlimited in
    // this build, and spilling would write the cache into the shim's MemFS.
    this.exports.MagickSetResourceLimit(ResourceType.Disk, 0n)
    this.exports.MagickSetResourceLimit(ResourceType.Map, 0n)
    if (opts.memoryLimitBytes !== undefined) {
      const limit = BigInt(Math.max(0, Math.floor(opts.memoryLimitBytes)))
      this.exports.MagickSetResourceLimit(ResourceType.Memory, limit)
      this.exports.MagickSetResourceLimit(ResourceType.Area, limit)
    }

    const numberPtr = this.alloc(4)
    try {
      // MagickGetVersion returns a static string: do NOT relinquish it.
      this.version = this.readCString(this.exports.MagickGetVersion(numberPtr))
    } finally {
      this.free(numberPtr)
    }
  }

  /* --------------------------------------------------------- memory helpers -- */

  /** Fresh `DataView` over wasm memory (which may have grown since the last call). */
  view(): DataView {
    return new DataView(this.memory.buffer)
  }

  /** Fresh `Uint8Array` over wasm memory. Never hold on to the result. */
  bytes(): Uint8Array {
    return new Uint8Array(this.memory.buffer)
  }

  alloc(size: number): number {
    const ptr = this.exports.malloc(size)
    if (ptr === 0 && size > 0) throw new MagickError(`malloc(${size}) failed`, ExceptionType.ResourceLimitError)
    return ptr
  }

  free(ptr: number): void {
    if (ptr !== 0) this.exports.free(ptr)
  }

  /** `malloc` + UTF-8 encode + NUL terminate. The caller frees. */
  cstring(s: string): number {
    const encoded = utf8Encoder.encode(s)
    const ptr = this.alloc(encoded.length + 1)
    const mem = this.bytes()
    mem.set(encoded, ptr)
    mem[ptr + encoded.length] = 0
    return ptr
  }

  readCString(ptr: number): string {
    if (ptr === 0) return ''
    const mem = this.bytes()
    let end = ptr
    // Bound the scan: past the end of memory `mem[end]` is `undefined`, which is
    // `!== 0` and would otherwise loop forever on a bad pointer.
    while (end < mem.length && mem[end] !== 0) end++
    return utf8Decoder.decode(mem.subarray(ptr, end))
  }

  /** `malloc` + copy `data` into wasm memory. The caller frees. */
  writeBytes(data: Uint8Array | Uint8ClampedArray): number {
    const ptr = this.alloc(data.length)
    this.bytes().set(data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.length), ptr)
    return ptr
  }

  /** Copy `len` bytes out of wasm memory into a fresh JS buffer. */
  readBytes(ptr: number, len: number): Uint8Array {
    return this.bytes().slice(ptr, ptr + len)
  }

  /* ------------------------------------------------------------------ wands -- */

  newWand(): MagickWand {
    const ptr = this.exports.NewMagickWand()
    if (ptr === 0) throw new MagickError('NewMagickWand() returned NULL', ExceptionType.ResourceLimitError)
    return new MagickWand(this, ptr)
  }

  newPixel(color?: string): PixelWand {
    const ptr = this.exports.NewPixelWand()
    if (ptr === 0) throw new MagickError('NewPixelWand() returned NULL', ExceptionType.ResourceLimitError)
    const wand = new PixelWand(this, ptr)
    if (color !== undefined) {
      try {
        wand.setColor(color)
      } catch (err) {
        // Do not leak the C wand when the colour string is rejected.
        wand.dispose()
        throw err
      }
    }
    return wand
  }

  /** `MagickQueryFormats('*')`. Every returned string and the array itself are relinquished. */
  formats(pattern = '*'): string[] {
    const patternPtr = this.cstring(pattern)
    const countPtr = this.alloc(4)
    try {
      const arrayPtr = this.exports.MagickQueryFormats(patternPtr, countPtr)
      if (arrayPtr === 0) return []
      const count = this.view().getUint32(countPtr, true)
      const names: string[] = []
      for (let i = 0; i < count; i++) {
        const strPtr = this.view().getUint32(arrayPtr + i * 4, true)
        names.push(this.readCString(strPtr))
        this.exports.MagickRelinquishMemory(strPtr)
      }
      this.exports.MagickRelinquishMemory(arrayPtr)
      return names
    } finally {
      this.free(countPtr)
      this.free(patternPtr)
    }
  }

  setResourceLimit(type: number, limit: bigint): void {
    this.exports.MagickSetResourceLimit(type, limit)
  }

  getResourceLimit(type: number): bigint {
    return this.exports.MagickGetResourceLimit(type)
  }

  /** Flush any buffered WASI stdout/stderr and shut MagickWand down. Idempotent. */
  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    this.exports.MagickWandTerminus()
    this.wasi.flush()
  }

  /* -------------------------------------------------------------- exceptions -- */

  /**
   * Read, release and clear the exception on `wandPtr`. Always throws.
   * @internal
   */
  throwException(wandPtr: number, operation: string): never {
    const severityPtr = this.alloc(4)
    let message = ''
    let severity = ExceptionType.Undefined as number
    try {
      const msgPtr = this.exports.MagickGetException(wandPtr, severityPtr)
      message = this.readCString(msgPtr)
      severity = this.view().getInt32(severityPtr, true)
      if (msgPtr !== 0) this.exports.MagickRelinquishMemory(msgPtr)
    } finally {
      this.free(severityPtr)
      this.exports.MagickClearException(wandPtr)
    }
    const detail = message || 'no exception text'
    throw new MagickError(`${operation}: ${detail} [${exceptionSeverityName(severity)}]`, severity)
  }
}

/* ---------------------------------------------------------------- PixelWand -- */

export class PixelWand {
  ptr: number
  private readonly magick: Magick

  constructor(magick: Magick, ptr: number) {
    this.magick = magick
    this.ptr = ptr
  }

  /** Any ImageMagick colour string: `#rrggbb`, `rgba(...)`, `white`, ... */
  setColor(color: string): void {
    const ptr = this.magick.cstring(color)
    try {
      if (this.magick.exports.PixelSetColor(this.ptr, ptr) === 0) {
        throw new MagickError(`PixelSetColor(${color}): unrecognised color`, ExceptionType.OptionError)
      }
    } finally {
      this.magick.free(ptr)
    }
  }

  /** Normalised 0..1, not 0..255. */
  setAlpha(a: number): void {
    this.magick.exports.PixelSetAlpha(this.ptr, a)
  }

  /** Normalised 0..1 channel values. */
  setRGB(r: number, g: number, b: number): void {
    this.magick.exports.PixelSetRed(this.ptr, r)
    this.magick.exports.PixelSetGreen(this.ptr, g)
    this.magick.exports.PixelSetBlue(this.ptr, b)
  }

  dispose(): void {
    if (this.ptr !== 0) {
      this.magick.exports.DestroyPixelWand(this.ptr)
      this.ptr = 0
    }
  }
}

/* --------------------------------------------------------------- MagickWand -- */

export class MagickWand {
  ptr: number
  private readonly magick: Magick

  constructor(magick: Magick, ptr: number) {
    this.magick = magick
    this.ptr = ptr
  }

  private check(ok: number, operation: string): void {
    if (ok === 0) this.magick.throwException(this.ptr, operation)
  }

  private alive(): number {
    if (this.ptr === 0) throw new MagickError('MagickWand: use after dispose()', ExceptionType.WandError)
    return this.ptr
  }

  get width(): number {
    return this.magick.exports.MagickGetImageWidth(this.alive())
  }

  get height(): number {
    return this.magick.exports.MagickGetImageHeight(this.alive())
  }

  get depth(): number {
    return this.magick.exports.MagickGetImageDepth(this.alive())
  }

  get numberImages(): number {
    return this.magick.exports.MagickGetNumberImages(this.alive())
  }

  newImage(width: number, height: number, background: PixelWand | string): void {
    const owned = typeof background === 'string' ? this.magick.newPixel(background) : undefined
    const pixel = owned ?? (background as PixelWand)
    try {
      this.check(
        this.magick.exports.MagickNewImage(this.alive(), width, height, pixel.ptr),
        `MagickNewImage(${width}, ${height})`,
      )
    } finally {
      owned?.dispose()
    }
  }

  /** Build an image straight from an RGBA8 buffer (`'RGBA'` map, `CharPixel` storage). */
  constitute(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): void {
    const expected = width * height * 4
    if (rgba.length < expected) {
      throw new MagickError(
        `constitute(${width}, ${height}): need ${expected} bytes, got ${rgba.length}`,
        ExceptionType.OptionError,
      )
    }
    const mapPtr = this.magick.cstring('RGBA')
    const pixelsPtr = this.magick.writeBytes(rgba)
    try {
      this.check(
        this.magick.exports.MagickConstituteImage(
          this.alive(),
          width,
          height,
          mapPtr,
          StorageType.Char,
          pixelsPtr,
        ),
        `MagickConstituteImage(${width}, ${height})`,
      )
    } finally {
      this.magick.free(pixelsPtr)
      this.magick.free(mapPtr)
    }
  }

  /** Overwrite a rectangle of the current image from an RGBA8 buffer. */
  importRGBA(
    x: number,
    y: number,
    width: number,
    height: number,
    rgba: Uint8Array | Uint8ClampedArray,
  ): void {
    const mapPtr = this.magick.cstring('RGBA')
    const pixelsPtr = this.magick.writeBytes(rgba)
    try {
      this.check(
        this.magick.exports.MagickImportImagePixels(
          this.alive(),
          x,
          y,
          width,
          height,
          mapPtr,
          StorageType.Char,
          pixelsPtr,
        ),
        `MagickImportImagePixels(${x}, ${y}, ${width}, ${height})`,
      )
    } finally {
      this.magick.free(pixelsPtr)
      this.magick.free(mapPtr)
    }
  }

  /** Copy a rectangle out as straight-alpha RGBA8. Defaults to the whole image. */
  exportRGBA(x = 0, y = 0, w = this.width, h = this.height): Uint8ClampedArray {
    const mapPtr = this.magick.cstring('RGBA')
    const pixelsPtr = this.magick.alloc(Math.max(1, w * h * 4))
    try {
      this.check(
        this.magick.exports.MagickExportImagePixels(
          this.alive(),
          x,
          y,
          w,
          h,
          mapPtr,
          StorageType.Char,
          pixelsPtr,
        ),
        `MagickExportImagePixels(${x}, ${y}, ${w}, ${h})`,
      )
      // readBytes already copied out of wasm memory; re-view that copy as clamped
      // instead of copying an 11 MB frame a second time.
      const copy = this.magick.readBytes(pixelsPtr, w * h * 4)
      return new Uint8ClampedArray(copy.buffer, copy.byteOffset, copy.length)
    } finally {
      this.magick.free(pixelsPtr)
      this.magick.free(mapPtr)
    }
  }

  readBlob(data: Uint8Array): void {
    const ptr = this.magick.writeBytes(data)
    try {
      this.check(
        this.magick.exports.MagickReadImageBlob(this.alive(), ptr, data.length),
        'MagickReadImageBlob',
      )
    } finally {
      this.magick.free(ptr)
    }
  }

  /** `MagickSetImageFormat` + `MagickGetImageBlob`, copied out and relinquished. */
  writeBlob(format: string): Uint8Array {
    this.setFormat(format)
    const lengthPtr = this.magick.alloc(4)
    let blobPtr = 0
    try {
      blobPtr = this.magick.exports.MagickGetImageBlob(this.alive(), lengthPtr)
      if (blobPtr === 0) this.magick.throwException(this.ptr, `MagickGetImageBlob(${format})`)
      const length = this.magick.view().getUint32(lengthPtr, true)
      return this.magick.readBytes(blobPtr, length)
    } finally {
      if (blobPtr !== 0) this.magick.exports.MagickRelinquishMemory(blobPtr)
      this.magick.free(lengthPtr)
    }
  }

  setFormat(format: string): void {
    const ptr = this.magick.cstring(format)
    try {
      this.check(
        this.magick.exports.MagickSetImageFormat(this.alive(), ptr),
        `MagickSetImageFormat(${format})`,
      )
    } finally {
      this.magick.free(ptr)
    }
  }

  /** The current image's format name, e.g. `'BMP'`. */
  getFormat(): string {
    const ptr = this.magick.exports.MagickGetImageFormat(this.alive())
    if (ptr === 0) return ''
    const s = this.magick.readCString(ptr)
    this.magick.exports.MagickRelinquishMemory(ptr)
    return s
  }

  resize(w: number, h: number, filter: number = FilterType.Lanczos): void {
    this.check(
      this.magick.exports.MagickResizeImage(this.alive(), w, h, filter),
      `MagickResizeImage(${w}, ${h}, filter=${filter})`,
    )
  }

  scale(w: number, h: number): void {
    this.check(this.magick.exports.MagickScaleImage(this.alive(), w, h), `MagickScaleImage(${w}, ${h})`)
  }

  blur(radius: number, sigma: number): void {
    this.check(
      this.magick.exports.MagickBlurImage(this.alive(), radius, sigma),
      `MagickBlurImage(${radius}, ${sigma})`,
    )
  }

  gaussianBlur(radius: number, sigma: number): void {
    this.check(
      this.magick.exports.MagickGaussianBlurImage(this.alive(), radius, sigma),
      `MagickGaussianBlurImage(${radius}, ${sigma})`,
    )
  }

  /**
   * Composite `src` onto this wand at `x,y`.
   *
   * The TS argument order follows ARCHITECTURE.md; the C function is
   * `MagickCompositeImage(dst, src, compose, clip_to_self, x, y)`, so the arguments are
   * reordered here.
   */
  composite(
    src: MagickWand,
    op: number = CompositeOperator.Over,
    x = 0,
    y = 0,
    clipToSelf = true,
  ): void {
    this.check(
      this.magick.exports.MagickCompositeImage(this.alive(), src.alive(), op, clipToSelf ? 1 : 0, x, y),
      `MagickCompositeImage(op=${op}, ${x}, ${y})`,
    )
  }

  extent(w: number, h: number, x: number, y: number): void {
    this.check(
      this.magick.exports.MagickExtentImage(this.alive(), w, h, x, y),
      `MagickExtentImage(${w}, ${h}, ${x}, ${y})`,
    )
  }

  crop(w: number, h: number, x: number, y: number): void {
    this.check(
      this.magick.exports.MagickCropImage(this.alive(), w, h, x, y),
      `MagickCropImage(${w}, ${h}, ${x}, ${y})`,
    )
  }

  setBackground(color: string): void {
    const pixel = this.magick.newPixel(color)
    try {
      this.check(
        this.magick.exports.MagickSetImageBackgroundColor(this.alive(), pixel.ptr),
        `MagickSetImageBackgroundColor(${color})`,
      )
    } finally {
      pixel.dispose()
    }
  }

  setAlphaChannel(op: number = AlphaChannelOption.Activate): void {
    this.check(
      this.magick.exports.MagickSetImageAlphaChannel(this.alive(), op),
      `MagickSetImageAlphaChannel(${op})`,
    )
  }

  setDepth(d: number): void {
    this.check(this.magick.exports.MagickSetImageDepth(this.alive(), d), `MagickSetImageDepth(${d})`)
  }

  setGravity(gravity: number = GravityType.NorthWest): void {
    this.check(
      this.magick.exports.MagickSetImageGravity(this.alive(), gravity),
      `MagickSetImageGravity(${gravity})`,
    )
  }

  resetIterator(): void {
    this.magick.exports.MagickResetIterator(this.alive())
  }

  /** Append clones of `other`'s images to the END of this wand's list. */
  addImages(other: MagickWand): void {
    this.magick.exports.MagickSetLastIterator(this.alive())
    this.check(this.magick.exports.MagickAddImage(this.ptr, other.alive()), 'MagickAddImage')
  }

  /**
   * Append the whole image list into one image, left-to-right or top-to-bottom
   * (`vertical`). Each image is placed on the cross axis by its own gravity; gaps take the
   * first image's background colour. Returns a new wand; this one is left unchanged.
   */
  append(vertical: boolean): MagickWand {
    this.magick.exports.MagickResetIterator(this.alive())
    const ptr = this.magick.exports.MagickAppendImages(this.ptr, vertical ? 1 : 0)
    if (ptr === 0) this.magick.throwException(this.ptr, `MagickAppendImages(vertical=${vertical})`)
    return new MagickWand(this.magick, ptr)
  }

  clone(): MagickWand {
    const ptr = this.magick.exports.CloneMagickWand(this.alive())
    if (ptr === 0) this.magick.throwException(this.ptr, 'CloneMagickWand')
    return new MagickWand(this.magick, ptr)
  }

  /** Drop the images but keep the wand usable. */
  clear(): void {
    this.magick.exports.ClearMagickWand(this.alive())
  }

  dispose(): void {
    if (this.ptr !== 0) {
      this.magick.exports.DestroyMagickWand(this.ptr)
      this.ptr = 0
    }
  }
}

export { AlphaChannelOption, CompositeOperator, ExceptionType, FilterType, GravityType, ResourceType, StorageType }
