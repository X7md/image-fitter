/**
 * (c) Colour background for every alignment plus offsets, and (d) blur background.
 *
 * The source is four solid quadrants, so Lanczos resampling leaves the interior of each
 * quadrant exactly the quadrant colour and the assertions below are about placement,
 * not about the resampler.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { computePlacement } from '../../src/engine/types'
import type { Align, AlignY, Bitmap, FitOptions } from '../../src/engine/types'
import {
  BLUE,
  GREEN,
  RED,
  YELLOW,
  describePixel,
  hexToRGBA,
  makeFitter,
  maxChannelDiff,
  pixelAt,
  quadrantBitmap,
  writeOut,
} from './helpers'
import type { RGBA } from './helpers'

const BG = '#204080'
const BG_RGBA = hexToRGBA(BG)

/** Quantisation slack: Q8 + Lanczos can land a solid region one level off. */
const TOL = 2

function colorOptions(width: number, height: number, over: Partial<FitOptions> = {}): FitOptions {
  return {
    width,
    height,
    align: 'center',
    alignY: 'center',
    offsetX: 0,
    offsetY: 0,
    background: { mode: 'color', color: BG },
    ...over,
  }
}

/** Assert the four quadrant colours appear at the right spots inside the placement rect. */
function assertQuadrants(out: Bitmap, rect: { x: number; y: number; width: number; height: number }) {
  const qw = rect.width / 2
  const qh = rect.height / 2
  const probes: Array<[string, number, number, RGBA]> = [
    ['top-left', rect.x + qw * 0.5, rect.y + qh * 0.5, RED],
    ['top-right', rect.x + qw * 1.5, rect.y + qh * 0.5, GREEN],
    ['bottom-left', rect.x + qw * 0.5, rect.y + qh * 1.5, BLUE],
    ['bottom-right', rect.x + qw * 1.5, rect.y + qh * 1.5, YELLOW],
  ]
  for (const [name, fx, fy, want] of probes) {
    const x = Math.round(fx)
    const y = Math.round(fy)
    const got = pixelAt(out, x, y)
    assert.ok(
      maxChannelDiff(got, want) <= TOL,
      `${name} quadrant at (${x},${y}): got ${describePixel(got)}, want ${describePixel(want)}`,
    )
  }
}

test('fit: colour background, all alignments, exact dims and background pixels', async (t) => {
  const { fitter, stderr } = await makeFitter()
  t.after(() => fitter.dispose())

  const src = quadrantBitmap(100, 100)

  for (const align of ['left', 'center', 'right'] as const) {
    const options = colorOptions(300, 100, { align })
    const rect = computePlacement(src.width, src.height, options)
    const out = fitter.fit(src, options)

    assert.equal(out.width, 300, 'output width')
    assert.equal(out.height, 100, 'output height')
    assert.equal(out.data.length, 300 * 100 * 4)

    // 100x100 into 300x100 -> scale 1, so the rect is the source size.
    assert.deepEqual(
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      { x: { left: 0, center: 100, right: 200 }[align as Align], y: 0, width: 100, height: 100 },
    )

    // Every column outside the rect is the background colour, on three scan lines.
    for (const y of [1, 50, 98]) {
      for (let x = 0; x < out.width; x++) {
        if (x >= rect.x && x < rect.x + rect.width) continue
        const got = pixelAt(out, x, y)
        assert.ok(
          maxChannelDiff(got, BG_RGBA) === 0,
          `background at (${x},${y}) for align=${align}: got ${describePixel(got)}`,
        )
      }
    }

    assertQuadrants(out, rect)
    writeOut(fitter, `fit-color-${align}.bmp`, out)
  }

  assert.deepEqual(stderr, [], 'no stderr noise')
})

test('fit: offsets shift the placement rect', async (t) => {
  const { fitter } = await makeFitter()
  t.after(() => fitter.dispose())

  // 200x100 into 200x300 -> scale 1, centred vertically at y = 100, then nudged.
  const src = quadrantBitmap(200, 100)
  const options = colorOptions(200, 300, { align: 'left', offsetX: 25, offsetY: -10 })
  const rect = computePlacement(src.width, src.height, options)
  assert.deepEqual(rect, { x: 25, y: 90, width: 200, height: 100 })

  const out = fitter.fit(src, options)
  assert.equal(out.width, 200)
  assert.equal(out.height, 300)

  // Just left of the rect is background; just inside its top-left corner is red.
  assert.equal(maxChannelDiff(pixelAt(out, rect.x - 1, rect.y + 5), BG_RGBA), 0)
  assert.equal(maxChannelDiff(pixelAt(out, rect.x + 5, rect.y - 1), BG_RGBA), 0)
  assert.ok(maxChannelDiff(pixelAt(out, rect.x + 5, rect.y + 5), RED) <= TOL)
  // And the far corners are background.
  assert.equal(maxChannelDiff(pixelAt(out, 0, 0), BG_RGBA), 0)
  assert.equal(maxChannelDiff(pixelAt(out, 199, 299), BG_RGBA), 0)

  assertQuadrants(out, rect)
  writeOut(fitter, 'fit-color-offset.bmp', out)
})

test('fit: vertical alignment puts the source against the right edge (§8)', async (t) => {
  const { fitter } = await makeFitter()
  t.after(() => fitter.dispose())

  // 200x100 into 200x400 -> scale 1, leaving a 300 px vertical slack to align in.
  const src = quadrantBitmap(200, 100)
  const expectedY: Record<AlignY, number> = { top: 0, center: 150, bottom: 300 }

  for (const alignY of ['top', 'center', 'bottom'] as const) {
    const options = colorOptions(200, 400, { alignY })
    const rect = computePlacement(src.width, src.height, options)
    assert.deepEqual(rect, { x: 0, y: expectedY[alignY], width: 200, height: 100 })

    const out = fitter.fit(src, options)
    assert.equal(out.width, 200)
    assert.equal(out.height, 400)

    // The source's own top row (red | green) sits exactly on rect.y ...
    assert.ok(
      maxChannelDiff(pixelAt(out, 50, rect.y + 2), RED) <= TOL,
      `alignY=${alignY}: red at the top of the rect, got ${describePixel(pixelAt(out, 50, rect.y + 2))}`,
    )
    assert.ok(
      maxChannelDiff(pixelAt(out, 150, rect.y + 2), GREEN) <= TOL,
      `alignY=${alignY}: green at the top of the rect`,
    )
    // ... and the bottom row (blue | yellow) on rect.y + height - 1.
    const lastY = rect.y + rect.height - 3
    assert.ok(maxChannelDiff(pixelAt(out, 50, lastY), BLUE) <= TOL, `alignY=${alignY}: blue at the bottom of the rect`)
    assert.ok(
      maxChannelDiff(pixelAt(out, 150, lastY), YELLOW) <= TOL,
      `alignY=${alignY}: yellow at the bottom of the rect`,
    )

    // Everything above and below the rect is background.
    for (let y = 0; y < out.height; y++) {
      if (y >= rect.y && y < rect.y + rect.height) continue
      assert.equal(
        maxChannelDiff(pixelAt(out, 100, y), BG_RGBA),
        0,
        `alignY=${alignY}: background expected at y=${y}`,
      )
    }

    // 'top' touches the very first row, 'bottom' the very last one.
    if (alignY === 'top') assert.ok(maxChannelDiff(pixelAt(out, 50, 0), RED) <= TOL, 'top touches row 0')
    if (alignY === 'bottom') {
      assert.ok(maxChannelDiff(pixelAt(out, 50, out.height - 1), BLUE) <= TOL, 'bottom touches the last row')
    }

    assertQuadrants(out, rect)
    writeOut(fitter, `fit-aligny-${alignY}.bmp`, out)
  }
})

test('fit: an upscaling fit keeps the quadrants solid', async (t) => {
  const { fitter } = await makeFitter()
  t.after(() => fitter.dispose())

  const src = quadrantBitmap(200, 200)
  const options = colorOptions(600, 400)
  const rect = computePlacement(src.width, src.height, options)
  // scale = min(3, 2) = 2 -> 400x400 centred horizontally.
  assert.deepEqual(rect, { x: 100, y: 0, width: 400, height: 400 })

  const out = fitter.fit(src, options)
  assert.equal(out.width, 600)
  assert.equal(out.height, 400)
  assertQuadrants(out, rect)
  assert.equal(maxChannelDiff(pixelAt(out, 10, 200), BG_RGBA), 0, 'left band is background')
  assert.equal(maxChannelDiff(pixelAt(out, 590, 200), BG_RGBA), 0, 'right band is background')
  writeOut(fitter, 'fit-color-upscale.bmp', out)
})

test('fit: an offset that pushes the image off-canvas is clipped, not an error', async (t) => {
  const { fitter } = await makeFitter()
  t.after(() => fitter.dispose())

  const src = quadrantBitmap(100, 100)
  const out = fitter.fit(src, colorOptions(300, 100, { align: 'left', offsetX: -400 }))
  assert.equal(out.width, 300)
  // Everything is off to the left, so the canvas is pure background.
  for (const [x, y] of [
    [0, 0],
    [150, 50],
    [299, 99],
  ] as const) {
    assert.equal(maxChannelDiff(pixelAt(out, x, y), BG_RGBA), 0, `(${x},${y}) is background`)
  }
})

test('fit: blur background is a smooth mix of the source, not a flat colour', async (t) => {
  const { fitter } = await makeFitter()
  t.after(() => fitter.dispose())

  const src = quadrantBitmap(200, 200)
  // Right-aligned so the whole left 400 px of the canvas shows the blurred background,
  // and that band crosses the source's vertical quadrant boundary (src x=100 -> 300).
  const options: FitOptions = {
    width: 600,
    height: 200,
    align: 'right',
    alignY: 'center',
    offsetX: 0,
    offsetY: 0,
    background: { mode: 'blur', sigma: 10 },
  }
  const rect = computePlacement(src.width, src.height, options)
  assert.deepEqual(rect, { x: 400, y: 0, width: 200, height: 200 })

  const out = fitter.fit(src, options)
  assert.equal(out.width, 600)
  assert.equal(out.height, 200)
  writeOut(fitter, 'fit-blur.bmp', out)

  const y = 50 // top half: red on the left of the boundary, green on the right
  const row: RGBA[] = []
  for (let x = 0; x < 400; x++) row.push(pixelAt(out, x, y))

  // Not a flat colour: red falls off and green rises across the band.
  const reds = row.map((p) => p[0])
  const greens = row.map((p) => p[1])
  assert.ok(
    Math.max(...reds) - Math.min(...reds) > 80,
    `red should vary across the background band, spread=${Math.max(...reds) - Math.min(...reds)}`,
  )
  assert.ok(
    Math.max(...greens) - Math.min(...greens) > 80,
    `green should vary across the background band, spread=${Math.max(...greens) - Math.min(...greens)}`,
  )
  assert.ok(reds[20]! > 200 && greens[20]! < 60, `left of the boundary is red-ish: ${describePixel(row[20]!)}`)
  assert.ok(greens[380]! > 200 && reds[380]! < 60, `right of the boundary is green-ish: ${describePixel(row[380]!)}`)

  // Smooth: no hard edge anywhere. Un-blurred, the boundary would jump 255 in one pixel.
  let worstStep = 0
  for (let x = 1; x < 400; x++) worstStep = Math.max(worstStep, maxChannelDiff(row[x]!, row[x - 1]!))
  assert.ok(worstStep < 40, `background should be smooth, worst single-pixel step = ${worstStep}`)
  // And there really is a gradient right at the stretched boundary.
  const mid = row[300]!
  assert.ok(mid[0]! > 20 && mid[0]! < 235, `the boundary pixel is a blend: ${describePixel(mid)}`)

  // The foreground is still crisp on top of it.
  assertQuadrants(out, rect)
})

test('fit: blurred background fills the canvas even with no visible band', async (t) => {
  const { fitter } = await makeFitter()
  t.after(() => fitter.dispose())

  const src = quadrantBitmap(64, 64)
  const out = fitter.fit(src, {
    width: 64,
    height: 64,
    align: 'center',
    alignY: 'center',
    offsetX: 0,
    offsetY: 0,
    background: { mode: 'blur', sigma: 5 },
  })
  assert.equal(out.width, 64)
  assert.equal(out.height, 64)
  // The source exactly covers the canvas, so the result is the (unblurred) source.
  assert.ok(maxChannelDiff(pixelAt(out, 10, 10), RED) <= TOL)
  assert.ok(maxChannelDiff(pixelAt(out, 53, 53), YELLOW) <= TOL)
})

test('fit: alpha stays opaque for opaque sources', async (t) => {
  const { fitter } = await makeFitter()
  t.after(() => fitter.dispose())

  const src = quadrantBitmap(40, 40)
  const out = fitter.fit(src, colorOptions(120, 40))
  for (let i = 3; i < out.data.length; i += 4) {
    if (out.data[i] !== 255) {
      assert.fail(`pixel ${(i - 3) / 4} is not opaque: alpha=${out.data[i]}`)
    }
  }
})
