/**
 * Stacking: `planStack` math, and the MagickAppendImages-based `Fitter.stack` landing
 * every image exactly on the cell the plan predicts (solid images, so every interior
 * pixel is exact whatever the resampler does).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_STACK, planStack } from '../../src/engine/types'
import type { Bitmap, Placement, StackOptions } from '../../src/engine/types'
import { BLUE, GREEN, RED, describePixel, hexToRGBA, makeFitter, maxChannelDiff, pixelAt, writeOut } from './helpers'
import type { RGBA } from './helpers'

const BG = '#204080'
const BG_RGBA = hexToRGBA(BG)
const TOL = 2

function solid(width: number, height: number, c: RGBA): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set(c, i)
  return { width, height, data }
}

function opts(over: Partial<StackOptions>): StackOptions {
  return { ...DEFAULT_STACK, background: BG, ...over }
}

function assertPixel(out: Bitmap, x: number, y: number, want: RGBA, what: string): void {
  const got = pixelAt(out, x, y)
  assert.ok(maxChannelDiff(got, want) <= TOL, `${what} at (${x},${y}): got ${describePixel(got)}, want ${describePixel(want)}`)
}

/** Centre of each cell has the image colour; the pixel just outside a cell edge that
 *  borders slack/gap has the background. */
function assertCells(out: Bitmap, cells: Placement[], colors: RGBA[], label: string): void {
  cells.forEach((c, i) => {
    assertPixel(out, c.x + (c.width >> 1), c.y + (c.height >> 1), colors[i]!, `${label}: cell ${i} centre`)
    assertPixel(out, c.x + 1, c.y + 1, colors[i]!, `${label}: cell ${i} top-left`)
    assertPixel(out, c.x + c.width - 2, c.y + c.height - 2, colors[i]!, `${label}: cell ${i} bottom-right`)
  })
}

test('planStack: row, match heights, gap, alignment', () => {
  const sizes = [
    { width: 200, height: 100 },
    { width: 50, height: 50 },
  ]
  const none = planStack(sizes, opts({ match: 'none', gap: 10, align: 'end' }))
  assert.equal(none.width, 260)
  assert.equal(none.height, 100)
  assert.deepEqual(none.cells[1], { x: 210, y: 50, width: 50, height: 50 })

  const small = planStack(sizes, opts({ match: 'smallest', gap: 0 }))
  assert.deepEqual(small.items, [
    { width: 100, height: 50 },
    { width: 50, height: 50 },
  ])
  assert.equal(small.width, 150)
  assert.equal(small.height, 50)

  const large = planStack(sizes, opts({ match: 'largest', layout: 'vertical' }))
  assert.deepEqual(large.items, [
    { width: 200, height: 100 },
    { width: 200, height: 200 },
  ])
  assert.equal(large.height, 300)

  const centred = planStack([{ width: 10, height: 45 }, { width: 10, height: 100 }], opts({ match: 'none', align: 'center' }))
  assert.equal(centred.cells[0]!.y, 27, 'centre offset floors like AppendImages')

  const grid = planStack(
    [
      { width: 40, height: 40 },
      { width: 40, height: 40 },
      { width: 40, height: 40 },
    ],
    opts({ layout: 'grid', columns: 2, gap: 4, match: 'none', align: 'start' }),
  )
  assert.deepEqual(grid.lines, [[0, 1], [2]])
  assert.equal(grid.width, 84)
  assert.equal(grid.height, 84)
  assert.deepEqual(grid.cells[2], { x: 0, y: 44, width: 40, height: 40 })

  const half = planStack(sizes, opts({ match: 'none', gap: 10 }), 0.5)
  assert.equal(half.width, 130)
  assert.equal(half.gap, 5)
})

test('stack: wasm output matches the plan for every layout and alignment', async (t) => {
  const { fitter, stderr } = await makeFitter()
  t.after(() => fitter.dispose())

  const images = [solid(120, 60, RED), solid(40, 80, GREEN), solid(60, 30, BLUE)]
  const colors = [RED, GREEN, BLUE]
  const sizes = images.map((b) => ({ width: b.width, height: b.height }))

  for (const layout of ['horizontal', 'vertical', 'grid'] as const) {
    for (const align of ['start', 'center', 'end'] as const) {
      for (const match of ['none', 'smallest', 'largest', 'first'] as const) {
        const o = opts({ layout, align, match, gap: 6, columns: 2 })
        const plan = planStack(sizes, o)
        const out = fitter.stack(images, plan, BG)
        const label = `${layout}/${align}/${match}`
        assert.equal(out.width, plan.width, `${label}: width`)
        assert.equal(out.height, plan.height, `${label}: height`)
        assertCells(out, plan.cells, colors, label)
        if (match === 'none') writeOut(fitter, `stack-${layout}-${align}.bmp`, out)
      }
    }
  }

  // Gap and slack pixels are background.
  const row = planStack(sizes, opts({ match: 'none', gap: 6, align: 'start' }))
  const out = fitter.stack(images, row, BG)
  assertPixel(out, 122, 5, BG_RGBA, 'gap column')
  assertPixel(out, 5, 70, BG_RGBA, 'slack under the short first image')

  assert.deepEqual(stderr, [], 'the module wrote nothing to stderr')
})

test('stackAndFit: fits the stacked composite into the target canvas', async (t) => {
  const { fitter } = await makeFitter()
  t.after(() => fitter.dispose())

  const images = [solid(100, 100, RED), solid(100, 100, GREEN)]
  const plan = planStack(images, opts({ match: 'none' }))
  assert.equal(plan.width, 200)
  const out = fitter.stackAndFit(images, plan, BG, {
    width: 200,
    height: 200,
    align: 'center',
    alignY: 'top',
    offsetX: 0,
    offsetY: 0,
    background: { mode: 'color', color: '#ffffff' },
  })
  assert.equal(out.width, 200)
  assert.equal(out.height, 200)
  assertPixel(out, 50, 50, RED, 'left half')
  assertPixel(out, 150, 50, GREEN, 'right half')
  assertPixel(out, 100, 150, [255, 255, 255, 255], 'fit background below')
})
