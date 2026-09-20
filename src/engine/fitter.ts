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
 * Every wand is released in a `finally`, including on the error path.
 */

import { loadMagick } from '../wasm/magick'
import type { LoadOptions, Magick, MagickSource, MagickWand } from '../wasm/magick'
import { CompositeOperator, FilterType } from '../wasm/enums'
import { clampSigma, computePlacement } from './types'
import type { Bitmap, FitOptions } from './types'

export class Fitter {
  readonly magick: Magick

  constructor(magick: Magick) {
    this.magick = magick
  }

  /** Render `src` into a `width × height` RGBA bitmap according to `options`. */
  fit(src: Bitmap, options: FitOptions): Bitmap {
    const width = Math.max(1, Math.round(options.width))
    const height = Math.max(1, Math.round(options.height))
    const placement = computePlacement(src.width, src.height, options)

    let canvas: MagickWand | undefined
    let foreground: MagickWand | undefined
    try {
      canvas = this.magick.newWand()
      if (options.background.mode === 'blur') {
        // A blurred, stretched copy of the source fills the whole canvas.
        canvas.constitute(src.width, src.height, src.data)
        canvas.resize(width, height, FilterType.Lanczos)
        canvas.blur(0, clampSigma(options.background.sigma))
      } else {
        canvas.newImage(width, height, options.background.color)
      }

      foreground = this.magick.newWand()
      foreground.constitute(src.width, src.height, src.data)
      if (placement.width !== src.width || placement.height !== src.height) {
        foreground.resize(placement.width, placement.height, FilterType.Lanczos)
      }

      canvas.composite(foreground, CompositeOperator.Over, placement.x, placement.y, true)

      return { width, height, data: canvas.exportRGBA(0, 0, width, height) }
    } finally {
      foreground?.dispose()
      canvas?.dispose()
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
