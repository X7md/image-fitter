/**
 * The fit engine: renders a source bitmap into a target canvas with MagickWand.
 *
 * Pipeline (ARCHITECTURE.md §4):
 *   1. background — either a solid `MagickNewImage(W, H, color)` or the source resized
 *      to W×H with Lanczos and then blurred with `blur(0, sigma)`;
 *   2. foreground — the source resized to the placement rectangle with Lanczos;
 *   3. `composite(Over)` at the placement's x,y, clipped to the canvas;
 *   4. export the canvas as RGBA8.
 *
 * Stacking (`stack`) joins several sources with `MagickAppendImages` following a
 * `StackPlan`: each image is resized to its planned size and given a gravity for its
 * cross-axis alignment, gaps are spacer images in the background colour, every line is
 * appended along its main axis and the lines are appended along the other one.
 *
 * Every wand is released in a `finally`, including on the error path.
 */

import { loadMagick } from '../wasm/magick'
import type { LoadOptions, Magick, MagickSource, MagickWand } from '../wasm/magick'
import { CompositeOperator, FilterType, GravityType } from '../wasm/enums'
import { BLUR_RANGE, computePlacement } from './types'
import type { Bitmap, FitOptions, StackAlign, StackPlan } from './types'

/** Gravity that aligns an image across a line: rows align vertically, columns horizontally. */
function crossGravity(align: StackAlign, alongVerticalAxis: boolean): number {
  if (align === 'center') return GravityType.Center
  if (alongVerticalAxis) return align === 'start' ? GravityType.North : GravityType.South
  return align === 'start' ? GravityType.West : GravityType.East
}

/** Blur sigma as the engine applies it: finite and non-negative. Fractional values are
 *  allowed (preview renders scale the sigma down with the canvas). */
function engineSigma(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : BLUR_RANGE.default
}

export class Fitter {
  readonly magick: Magick

  constructor(magick: Magick) {
    this.magick = magick
  }

  /** Render `src` into a `width × height` RGBA bitmap according to `options`. */
  fit(src: Bitmap, options: FitOptions): Bitmap {
    const wand = this.fromBitmap(src)
    try {
      return this.fitWand(wand, options)
    } finally {
      wand.dispose()
    }
  }

  /** Stack `images` per `plan` (see `planStack`) into one RGBA bitmap. Image `i` is
   *  resized to `plan.items[i]` whatever its own size, so a plan computed from the
   *  full-size dimensions can be applied to downscaled copies. */
  stack(images: readonly Bitmap[], plan: StackPlan, background: string): Bitmap {
    const wand = this.stackWand(images, plan, background)
    try {
      return { width: wand.width, height: wand.height, data: wand.exportRGBA() }
    } finally {
      wand.dispose()
    }
  }

  /** `stack` then `fit`, without exporting the intermediate composite. */
  stackAndFit(images: readonly Bitmap[], plan: StackPlan, background: string, options: FitOptions): Bitmap {
    const wand = this.stackWand(images, plan, background)
    try {
      return this.fitWand(wand, options)
    } finally {
      wand.dispose()
    }
  }

  private fromBitmap(src: Bitmap): MagickWand {
    const wand = this.magick.newWand()
    try {
      wand.constitute(src.width, src.height, src.data)
      return wand
    } catch (err) {
      wand.dispose()
      throw err
    }
  }

  /** Fit the image in `src` (resized in place: the caller disposes it). */
  private fitWand(src: MagickWand, options: FitOptions): Bitmap {
    const width = Math.max(1, Math.round(options.width))
    const height = Math.max(1, Math.round(options.height))
    const srcW = src.width
    const srcH = src.height
    const placement = computePlacement(srcW, srcH, options)

    let canvas: MagickWand | undefined
    try {
      if (options.background.mode === 'blur') {
        // A blurred, stretched copy of the source fills the whole canvas.
        canvas = src.clone()
        canvas.resize(width, height, FilterType.Lanczos)
        canvas.blur(0, engineSigma(options.background.sigma))
      } else {
        canvas = this.magick.newWand()
        canvas.newImage(width, height, options.background.color)
      }

      if (placement.width !== srcW || placement.height !== srcH) {
        src.resize(placement.width, placement.height, FilterType.Lanczos)
      }

      canvas.composite(src, CompositeOperator.Over, placement.x, placement.y, true)

      return { width, height, data: canvas.exportRGBA(0, 0, width, height) }
    } finally {
      canvas?.dispose()
    }
  }

  private stackWand(images: readonly Bitmap[], plan: StackPlan, background: string): MagickWand {
    if (images.length === 0 || images.length !== plan.items.length) {
      throw new Error(`stack: ${images.length} images for a plan of ${plan.items.length}`)
    }
    const lineWands: MagickWand[] = []
    try {
      for (const line of plan.lines) {
        const itemWands: MagickWand[] = []
        try {
          for (const i of line) {
            const item = this.fromBitmap(images[i]!)
            itemWands.push(item)
            const size = plan.items[i]!
            if (item.width !== size.width || item.height !== size.height) {
              item.resize(size.width, size.height, FilterType.Lanczos)
            }
            item.setGravity(crossGravity(plan.align, !plan.vertical))
          }
          lineWands.push(this.appendWands(itemWands, plan.vertical, plan.gap, background))
        } finally {
          for (const w of itemWands) w.dispose()
        }
      }
      if (lineWands.length === 1) return lineWands.pop()!
      for (const w of lineWands) w.setGravity(crossGravity(plan.align, plan.vertical))
      return this.appendWands(lineWands, !plan.vertical, plan.gap, background)
    } finally {
      for (const w of lineWands) w.dispose()
    }
  }

  /** Join single-image wands (gravity already set) along one axis, with `gap`-pixel
   *  spacers between them. AppendImages fills the slack with the first image's background. */
  private appendWands(parts: readonly MagickWand[], vertical: boolean, gap: number, background: string): MagickWand {
    const list = this.magick.newWand()
    let spacer: MagickWand | undefined
    try {
      parts[0]!.setBackground(background)
      if (gap > 0 && parts.length > 1) {
        spacer = this.magick.newWand()
        spacer.newImage(vertical ? 1 : gap, vertical ? gap : 1, background)
      }
      parts.forEach((part, i) => {
        if (i > 0 && spacer) list.addImages(spacer)
        list.addImages(part)
      })
      return list.append(vertical)
    } finally {
      spacer?.dispose()
      list.dispose()
    }
  }

  /** Resample a bitmap to `width x height` with Lanczos (used for preview sources). */
  scale(src: Bitmap, width: number, height: number): Bitmap {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    let wand: MagickWand | undefined
    try {
      wand = this.magick.newWand()
      wand.constitute(src.width, src.height, src.data)
      wand.resize(w, h, FilterType.Lanczos)
      return { width: w, height: h, data: wand.exportRGBA(0, 0, w, h) }
    } finally {
      wand?.dispose()
    }
  }

  /** Encode a bitmap with one of the delegate-free built-in coders. */
  encode(bitmap: Bitmap, format: 'BMP' | 'PNM' | 'PAM'): Uint8Array {
    let wand: MagickWand | undefined
    try {
      wand = this.magick.newWand()
      wand.constitute(bitmap.width, bitmap.height, bitmap.data)
      wand.setDepth(8)
      return wand.writeBlob(format)
    } finally {
      wand?.dispose()
    }
  }

  /** Decode an encoded blob (BMP, PNM, PAM, ...) back into an RGBA bitmap. */
  decode(data: Uint8Array): Bitmap {
    let wand: MagickWand | undefined
    try {
      wand = this.magick.newWand()
      wand.readBlob(data)
      const width = wand.width
      const height = wand.height
      return { width, height, data: wand.exportRGBA(0, 0, width, height) }
    } finally {
      wand?.dispose()
    }
  }

  /** Shut MagickWand down. The Fitter is unusable afterwards. */
  dispose(): void {
    this.magick.terminate()
  }
}

/** Load `magick.wasm` through our WASI shim and wrap it in a `Fitter`. */
export async function createFitter(source: MagickSource, opts?: LoadOptions): Promise<Fitter> {
  return new Fitter(await loadMagick(source, opts))
}

export type { LoadOptions, Magick, MagickSource }
