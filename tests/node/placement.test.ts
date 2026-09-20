/**
 * (b) The pure placement / preset math in `src/engine/types.ts`. No wasm involved.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BLUR_RANGE,
  DEFAULT_OPTIONS,
  clampSigma,
  coerceDimension,
  computePlacement,
  presetDimensions,
} from '../../src/engine/types'
import type { Align, AlignY, FitOptions } from '../../src/engine/types'

function options(width: number, height: number, over: Partial<FitOptions> = {}): FitOptions {
  return { ...DEFAULT_OPTIONS, width, height, ...over }
}

test('computePlacement: contain-fit scale, wider target', () => {
  // 100x100 into 300x100 -> scale = min(3, 1) = 1
  const p = computePlacement(100, 100, options(300, 100))
  assert.deepEqual(p, { x: 100, y: 0, width: 100, height: 100 })
})

test('computePlacement: contain-fit scale, taller target', () => {
  // 200x100 into 200x400 -> scale = min(1, 4) = 1
  const p = computePlacement(200, 100, options(200, 400))
  assert.deepEqual(p, { x: 0, y: 150, width: 200, height: 100 })
})

test('computePlacement: upscales when the target is larger in both axes', () => {
  // 200x100 into 800x800 -> scale = min(4, 8) = 4
  const p = computePlacement(200, 100, options(800, 800))
  assert.deepEqual(p, { x: 0, y: 200, width: 800, height: 400 })
})

test('computePlacement: alignment', () => {
  const expected: Record<Align, number> = { left: 0, center: 100, right: 200 }
  for (const align of ['left', 'center', 'right'] as const) {
    const p = computePlacement(100, 100, options(300, 100, { align }))
    assert.equal(p.x, expected[align], `align=${align}`)
    assert.equal(p.y, 0)
  }
})

test('computePlacement: vertical alignment (§8)', () => {
  // 200x100 into 200x400 -> scale = min(1, 4) = 1, so a 200x100 rect in a 400-tall canvas.
  const expected: Record<AlignY, number> = { top: 0, center: 150, bottom: 300 }
  for (const alignY of ['top', 'center', 'bottom'] as const) {
    const p = computePlacement(200, 100, options(200, 400, { alignY }))
    assert.equal(p.y, expected[alignY], `alignY=${alignY}`)
    assert.equal(p.x, 0)
    assert.equal(p.height, 100)
  }
})

test('computePlacement: horizontal and vertical alignment combine independently', () => {
  // 100x100 into 300x500 -> scale = min(3, 5) = 3 -> 300x300. No horizontal slack left.
  const p = computePlacement(100, 100, options(300, 500, { align: 'right', alignY: 'bottom' }))
  assert.deepEqual(p, { x: 0, y: 200, width: 300, height: 300 })

  const q = computePlacement(100, 100, options(600, 500, { align: 'right', alignY: 'top' }))
  assert.deepEqual(q, { x: 100, y: 0, width: 500, height: 500 })
})

test('computePlacement: offsetY is added after vertical alignment', () => {
  const p = computePlacement(200, 100, options(200, 400, { alignY: 'bottom', offsetY: -30 }))
  assert.equal(p.y, 270)
  const q = computePlacement(200, 100, options(200, 400, { alignY: 'top', offsetY: 12 }))
  assert.equal(q.y, 12)
})

test('computePlacement: offsets are added after alignment', () => {
  // 100x100 into 300x100 -> scale 1, so the rect stays 100x100.
  // right -> x = 300-100 = 200, then -12; y = round((100-100)/2) = 0, then +7
  const p = computePlacement(100, 100, options(300, 100, { align: 'right', offsetX: -12, offsetY: 7 }))
  assert.deepEqual(p, { x: 188, y: 7, width: 100, height: 100 })

  // 200x100 into 200x300 -> scale = min(1, 3) = 1, centred vertically at y = 100.
  const q = computePlacement(200, 100, options(200, 300, { align: 'left', offsetX: 25, offsetY: -10 }))
  assert.deepEqual(q, { x: 25, y: 90, width: 200, height: 100 })
})

test('computePlacement: rounds the scaled size', () => {
  // 3x7 into 10x10 -> scale = min(10/3, 10/7) = 1.4285…
  const p = computePlacement(3, 7, options(10, 10))
  assert.deepEqual(p, { x: 3, y: 0, width: 4, height: 10 })
})

test('computePlacement: never produces a zero-sized rectangle', () => {
  const p = computePlacement(1000, 10, options(1, 10000))
  assert.ok(p.width >= 1 && p.height >= 1, `got ${p.width}x${p.height}`)
})

test('presetDimensions: 1:1 is a square of the longer side', () => {
  assert.deepEqual(presetDimensions('1:1', 800, 600), { width: 800, height: 800 })
  assert.deepEqual(presetDimensions('1:1', 600, 900), { width: 900, height: 900 })
})

test('presetDimensions: custom leaves the size unchanged', () => {
  assert.deepEqual(presetDimensions('custom', 123, 456), { width: 123, height: 456 })
})

test('presetDimensions: picks the larger-area candidate', () => {
  // 800x600, 16:9 -> (600*16/9 = 1066.67 x 600) = 640000 vs (800 x 450) = 360000
  assert.deepEqual(presetDimensions('16:9', 800, 600), { width: 1067, height: 600 })
  // 600x800, 4:3 -> (800*4/3 = 1066.67 x 800) = 853333 vs (600 x 450) = 270000
  assert.deepEqual(presetDimensions('4:3', 600, 800), { width: 1067, height: 800 })
  // 1200x400, 3:2 -> (600 x 400) = 240000 vs (1200 x 800) = 960000
  assert.deepEqual(presetDimensions('3:2', 1200, 400), { width: 1200, height: 800 })
})

test('presetDimensions: a source already at the ratio is (near) unchanged', () => {
  assert.deepEqual(presetDimensions('16:9', 1920, 1080), { width: 1920, height: 1080 })
})

test('DEFAULT_OPTIONS and BLUR_RANGE match the contract', () => {
  assert.equal(DEFAULT_OPTIONS.align, 'center')
  assert.equal(DEFAULT_OPTIONS.alignY, 'center')
  assert.equal(DEFAULT_OPTIONS.offsetX, 0)
  assert.equal(DEFAULT_OPTIONS.offsetY, 0)
  assert.deepEqual(DEFAULT_OPTIONS.background, { mode: 'color', color: '#ffffff' })
  assert.deepEqual(BLUR_RANGE, { min: 1, max: 20, default: 10 })
})

test('coerceDimension and clampSigma', () => {
  assert.equal(coerceDimension('', 800), 800)
  assert.equal(coerceDimension('0', 800), 800)
  assert.equal(coerceDimension('1024', 800), 1024)
  assert.equal(coerceDimension(640.4, 800), 640)
  assert.equal(clampSigma(0), BLUR_RANGE.min)
  assert.equal(clampSigma(999), BLUR_RANGE.max)
  assert.equal(clampSigma(Number.NaN), BLUR_RANGE.default)
  assert.equal(clampSigma(7.6), 8)
})
