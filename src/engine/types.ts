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

/* ------------------------------------------------------------------ stacking -- */

export interface Size {
  width: number
  height: number
}

/** horizontal: one row; vertical: one column; grid: rows of `columns` images. */
export type StackLayout = 'horizontal' | 'vertical' | 'grid'

/** Cross-axis size normalisation: rows (and grid rows) match heights, columns match widths. */
export type StackMatch = 'none' | 'smallest' | 'largest' | 'first'

/** Cross-axis alignment of images smaller than their row/column (and of short grid rows). */
export type StackAlign = 'start' | 'center' | 'end'

export interface StackOptions {
  layout: StackLayout
  /** Grid only; clamped to 1..number of images. */
  columns: number
  /** Pixels between neighbouring images (and between grid rows). */
  gap: number
  match: StackMatch
  align: StackAlign
  /** '#rrggbb' fill for gaps and alignment slack. */
  background: string
}

export const STACK_LAYOUTS: readonly StackLayout[] = ['horizontal', 'vertical', 'grid']
export const STACK_MATCHES: readonly StackMatch[] = ['none', 'smallest', 'largest', 'first']
export const STACK_ALIGNS: readonly StackAlign[] = ['start', 'center', 'end']
export const STACK_GAP_RANGE = { min: 0, max: 200 }

export const DEFAULT_STACK: StackOptions = {
  layout: 'horizontal',
  columns: 2,
  gap: 0,
  match: 'smallest',
  align: 'center',
  background: '#ffffff',
}

export interface StackPlan {
  width: number
  height: number
  /** Main axis of every line: false = images left-to-right, true = top-to-bottom. Lines
   *  are then joined along the other axis. */
  vertical: boolean
  /** Image indices per line. */
  lines: number[][]
  gap: number
  align: StackAlign
  /** The size each image is resized to. */
  items: Size[]
  /** Where each image lands in the result. */
  cells: Placement[]
}

/** Offset of a `size` box inside `total` for an alignment. Floors the centre exactly like
 *  MagickCore's AppendImages (GravityAdjustGeometry truncates toward zero). */
function alignOffset(align: StackAlign, slack: number): number {
  if (align === 'start') return 0
  if (align === 'end') return slack
  return Math.floor(slack / 2)
}

/**
 * Lay out images for stacking. `scale` shrinks the whole plan (preview renders): item
 * sizes and the gap are scaled and rounded, and the totals follow from those.
 */
export function planStack(sizes: readonly Size[], o: StackOptions, scale = 1): StackPlan {
  const n = sizes.length
  const vertical = o.layout === 'vertical'
  const matchWidth = vertical

  let target = 0
  if (n > 0 && o.match !== 'none') {
    const cross = sizes.map((s) => Math.max(1, matchWidth ? s.width : s.height))
    target = o.match === 'smallest' ? Math.min(...cross) : o.match === 'largest' ? Math.max(...cross) : cross[0]!
  }

  const items = sizes.map((s): Size => {
    const w = Math.max(1, s.width)
    const h = Math.max(1, s.height)
    let iw = w
    let ih = h
    if (target > 0) {
      if (matchWidth) {
        iw = target
        ih = (h * target) / w
      } else {
        ih = target
        iw = (w * target) / h
      }
    }
    return { width: Math.max(1, Math.round(iw * scale)), height: Math.max(1, Math.round(ih * scale)) }
  })
  const gap = Math.max(0, Math.round(Math.max(0, o.gap) * scale))

  const perLine = o.layout === 'grid' ? Math.min(Math.max(1, Math.round(o.columns) || 1), Math.max(1, n)) : Math.max(1, n)
  const lines: number[][] = []
  for (let i = 0; i < n; i += perLine) lines.push(Array.from({ length: Math.min(perLine, n - i) }, (_, k) => i + k))

  // Line extents: `main` along the line, `cross` across it.
  const extents = lines.map((line) => {
    let main = gap * (line.length - 1)
    let cross = 0
    for (const i of line) {
      const it = items[i]!
      main += vertical ? it.height : it.width
      cross = Math.max(cross, vertical ? it.width : it.height)
    }
    return { main, cross }
  })
  const totalMain = Math.max(0, ...extents.map((e) => e.main))
  const totalCross = extents.reduce((sum, e) => sum + e.cross, 0) + gap * Math.max(0, lines.length - 1)

  const cells: Placement[] = new Array(n)
  let crossPos = 0
  lines.forEach((line, li) => {
    const ext = extents[li]!
    let mainPos = alignOffset(o.align, totalMain - ext.main)
    for (const i of line) {
      const it = items[i]!
      const itMain = vertical ? it.height : it.width
      const itCross = vertical ? it.width : it.height
      const c = crossPos + alignOffset(o.align, ext.cross - itCross)
      cells[i] = vertical
        ? { x: c, y: mainPos, width: it.width, height: it.height }
        : { x: mainPos, y: c, width: it.width, height: it.height }
      mainPos += itMain + gap
    }
    crossPos += ext.cross + gap
  })

  return {
    width: Math.max(1, vertical ? totalCross : totalMain),
    height: Math.max(1, vertical ? totalMain : totalCross),
    vertical,
    lines,
    gap,
    align: o.align,
    items,
    cells,
  }
}
