// Message protocol between the main thread (EngineClient) and the engine worker.
import type { Bitmap, FitOptions, StackOptions } from './types'

/** Preview renders are capped to this many pixels on the long side of the target. */
export const PREVIEW_LONG_SIDE = 1280

export type Quality = 'preview' | 'full'

/** What to render: `images` (keys handed over with `addImage`), stacked with `stack`
 *  when set (otherwise `images[0]` alone), then fitted with `fit`. */
export interface RenderJob {
  images: number[]
  stack: StackOptions | null
  fit: FitOptions
}

export type EngineRequest =
  | { type: 'addImage'; id: number; key: number; bitmap: Bitmap }
  | { type: 'removeImage'; id: number; key: number }
  | { type: 'clearImages'; id: number }
  | { type: 'render'; id: number; job: RenderJob; quality: Quality }

export type EngineResponse =
  | { type: 'ready'; version: string }
  | { type: 'boot-error'; message: string }
  | { type: 'ok'; id: number; bitmap?: Bitmap; ms: number }
  | { type: 'error'; id: number; message: string }

/** Scale factor that brings a `width x height` target under the preview cap. */
export function previewScale(width: number, height: number): number {
  return Math.min(1, PREVIEW_LONG_SIDE / Math.max(1, width, height))
}

/** The same fit, expressed in preview pixels. Placement math only depends on the
 *  source aspect ratio, so a downscaled source with scaled target/offsets/sigma gives
 *  the full-size result shrunk by `scale` (up to rounding). */
export function scaleOptions(options: FitOptions, scale: number): FitOptions {
  if (scale === 1) return options
  return {
    ...options,
    width: Math.max(1, Math.round(options.width * scale)),
    height: Math.max(1, Math.round(options.height * scale)),
    offsetX: Math.round(options.offsetX * scale),
    offsetY: Math.round(options.offsetY * scale),
    background:
      options.background.mode === 'blur'
        ? { mode: 'blur', sigma: Math.max(0.5, options.background.sigma * scale) }
        : options.background,
  }
}
