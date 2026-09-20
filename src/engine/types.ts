// Shared engine types + pure math. No DOM, no wasm — used by the UI preview and by the
// MagickWand fitter alike, so both sides agree on exactly the same placement.

/** RGBA8 pixels, straight (non-premultiplied) alpha, row-major, no padding. */
export interface Bitmap {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** Horizontal alignment. */
export type Align = 'left' | 'center' | 'right'

/** Vertical alignment (ARCHITECTURE.md §8). */
export type AlignY = 'top' | 'center' | 'bottom'

export type AspectPreset = '1:1' | '16:9' | '4:3' | '3:2' | 'custom'

export type Background =
  | { mode: 'color'; color: string } // '#rrggbb'
  | { mode: 'blur'; sigma: number } // 1..20, blurred copy of the source stretched to the target

export interface FitOptions {
  /** Target canvas size, integers >= 1. */
  width: number
  height: number
  align: Align
  /** Vertical alignment; default 'center' (ARCHITECTURE.md §8). */
  alignY: AlignY
  /** Pixel nudge applied after alignment. */
  offsetX: number
  offsetY: number
  background: Background
}

export interface Placement {
  x: number
  y: number
  width: number
  height: number
}

export const ASPECT_PRESETS: readonly AspectPreset[] = ['1:1', '16:9', '4:3', '3:2', 'custom']

export const ALIGNS: readonly Align[] = ['left', 'center', 'right']

export const ALIGNS_Y: readonly AlignY[] = ['top', 'center', 'bottom']

export const DEFAULT_OPTIONS: Omit<FitOptions, 'width' | 'height'> = {
  align: 'center',
  alignY: 'center',
  offsetX: 0,
  offsetY: 0,
  background: { mode: 'color', color: '#ffffff' },
}

export const BLUR_RANGE = { min: 1, max: 20, default: 10 }

/** Fallback target size used when the width/height inputs are emptied. */
export const FALLBACK_SIZE = { width: 800, height: 600 }

/**
 * scale = min(W/srcW, H/srcH); w = round(srcW*scale); h = round(srcH*scale);
 * x = offsetX + (left: 0 | center: round((W-w)/2) | right: W-w);
 * y = offsetY + (top: 0 | center: round((H-h)/2) | bottom: H-h)
 */
export function computePlacement(srcW: number, srcH: number, o: FitOptions): Placement {
  const W = Math.max(1, Math.round(o.width))
  const H = Math.max(1, Math.round(o.height))
  const sw = Math.max(1, srcW)
  const sh = Math.max(1, srcH)
  const scale = Math.min(W / sw, H / sh)
  // The contract formula is a plain round(); the max(1) only guards degenerate aspect
  // ratios (e.g. a 1x10000 target) from producing a zero-sized resize.
  const width = Math.max(1, Math.round(sw * scale))
  const height = Math.max(1, Math.round(sh * scale))
  let x = o.offsetX
  switch (o.align) {
    case 'left':
      break
    case 'right':
      x += W - width
      break
    case 'center':
    default:
      x += Math.round((W - width) / 2)
      break
  }
  let y = o.offsetY
  switch (o.alignY) {
    case 'top':
      break
    case 'bottom':
      y += H - height
      break
    case 'center':
    default:
      y += Math.round((H - height) / 2)
      break
  }
  return { x, y, width, height }
}

const PRESET_RATIOS: Record<Exclude<AspectPreset, '1:1' | 'custom'>, number> = {
  '16:9': 16 / 9,
  '4:3': 4 / 3,
  '3:2': 3 / 2,
}

/**
 * Same rules as the old app: '1:1' -> square of max(srcW, srcH); other presets -> the
 * larger-area of (srcH*r x srcH) and (srcW x srcW/r), rounded; 'custom' -> unchanged.
 */
export function presetDimensions(
  preset: AspectPreset,
  srcW: number,
  srcH: number,
): { width: number; height: number } {
  if (preset === 'custom') return { width: srcW, height: srcH }
  if (preset === '1:1') {
    const m = Math.max(srcW, srcH)
    return { width: m, height: m }
  }
  const r = PRESET_RATIOS[preset]
  const a = { width: srcH * r, height: srcH }
  const b = { width: srcW, height: srcW / r }
  const pick = a.width * a.height > b.width * b.height ? a : b
  return { width: Math.round(pick.width), height: Math.round(pick.height) }
}

/** Coerce a user-typed dimension: NaN / empty / < 1 -> fallback; otherwise a positive integer. */
export function coerceDimension(value: string | number, fallback: number): number {
  const n = typeof value === 'number' ? value : parseInt(value, 10)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.round(n)
}

/** Clamp a blur sigma into BLUR_RANGE (integers). */
export function clampSigma(value: number): number {
  if (!Number.isFinite(value)) return BLUR_RANGE.default
  return Math.min(BLUR_RANGE.max, Math.max(BLUR_RANGE.min, Math.round(value)))
}
