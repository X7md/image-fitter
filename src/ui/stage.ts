// Stage helpers: decoding files into raw RGBA for the engine, and blitting the frames
// the engine renders onto the preview canvas. The canvas is only a display surface;
// no compositing or filtering happens here.
import type { Bitmap } from '../engine/types'

function makeWorkCanvas(width: number, height: number): CanvasRenderingContext2D {
  if (typeof OffscreenCanvas !== 'undefined') {
    const ctx = new OffscreenCanvas(width, height).getContext('2d') as CanvasRenderingContext2D | null
    if (ctx) return ctx
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')
  return ctx
}

/** Decode a File/Blob with the browser's codecs into a raw RGBA bitmap. */
export async function decodeImageFile(file: Blob): Promise<Bitmap> {
  const image = await createImageBitmap(file)
  try {
    const ctx = makeWorkCanvas(image.width, image.height)
    ctx.drawImage(image, 0, 0)
    const data = ctx.getImageData(0, 0, image.width, image.height).data
    return { width: image.width, height: image.height, data }
  } finally {
    image.close()
  }
}

/** ImageData insists on a plain ArrayBuffer-backed view; engine bitmaps always are. */
function toImageData(bitmap: Bitmap): ImageData {
  return new ImageData(bitmap.data as Uint8ClampedArray<ArrayBuffer>, bitmap.width, bitmap.height)
}

/** Put an engine-rendered frame on the canvas. The element is CSS-scaled to the stage. */
export function drawBitmap(canvas: HTMLCanvasElement, bitmap: Bitmap): void {
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width = bitmap.width
    canvas.height = bitmap.height
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.putImageData(toImageData(bitmap), 0, 0)
}

/** Encode a bitmap as PNG with the browser's encoder (for the download). */
export function bitmapToPngBlob(bitmap: Bitmap): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')
  ctx.putImageData(toImageData(bitmap), 0, 0)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('toBlob failed'))
    }, 'image/png')
  })
}
