// Canvas 2D preview + bitmap <-> ImageBitmap conversions for the stage.
import type { Bitmap } from '../engine/types'
import { computePlacement } from '../engine/types'
import type { AppState } from './state'

/** Preview backing canvas is capped to this many px on its long side. */
const PREVIEW_CAP = 4096

function makeWorkCanvas(width: number, height: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null
    if (ctx) return { canvas, ctx }
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')
  return { canvas, ctx }
}

/** Decode a File/Blob into an ImageBitmap (kept for fast preview redraws). */
export async function decodeImageFile(file: Blob): Promise<ImageBitmap> {
  return createImageBitmap(file)
}

/** Convert a raw RGBA Bitmap into an ImageBitmap for drawing on the stage. */
export async function bitmapToImageBitmap(bitmap: Bitmap): Promise<ImageBitmap> {
  const data = new ImageData(new Uint8ClampedArray(bitmap.data), bitmap.width, bitmap.height)
  return createImageBitmap(data)
}

/** Convert a decoded ImageBitmap into a raw RGBA Bitmap (for the wasm fitter). */
export function imageBitmapToBitmap(image: ImageBitmap): Bitmap {
  const { ctx } = makeWorkCanvas(image.width, image.height)
  ctx.drawImage(image, 0, 0)
  const imageData = ctx.getImageData(0, 0, image.width, image.height)
  return { width: image.width, height: image.height, data: imageData.data }
}

/** Long-side-capped backing resolution for a given target size. */
export function cappedSize(width: number, height: number): { width: number; height: number; scale: number } {
  const long = Math.max(width, height)
  if (long <= PREVIEW_CAP) return { width, height, scale: 1 }
  const scale = PREVIEW_CAP / long
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale }
}

/**
 * Redraw the preview canvas at (capped) target resolution: background, then the source
 * image placed per `computePlacement`. CSS sizes the element to fit the stage; the
 * backing pixel size is only capped so huge target dims stay fast to paint.
 */
export function drawPreview(canvas: HTMLCanvasElement, state: AppState): void {
  const source = state.source
  if (!source || !source.preview) return
  const { options } = state
  const targetW = Math.max(1, Math.round(options.width))
  const targetH = Math.max(1, Math.round(options.height))
  const capped = cappedSize(targetW, targetH)

  if (canvas.width !== capped.width || canvas.height !== capped.height) {
    canvas.width = capped.width
    canvas.height = capped.height
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, capped.width, capped.height)

  if (options.background.mode === 'color') {
    ctx.fillStyle = options.background.color
    ctx.fillRect(0, 0, capped.width, capped.height)
  } else {
    const sigma = options.background.sigma * capped.scale
    ctx.save()
    ctx.filter = `blur(${Math.max(0, sigma)}px)`
    ctx.drawImage(source.preview, 0, 0, capped.width, capped.height)
    ctx.restore()
  }

  const placement = computePlacement(source.width, source.height, options)
  const x = placement.x * capped.scale
  const y = placement.y * capped.scale
  const w = placement.width * capped.scale
  const h = placement.height * capped.scale
  ctx.drawImage(source.preview, x, y, w, h)
}
