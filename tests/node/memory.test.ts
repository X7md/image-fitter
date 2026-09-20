/**
 * (g) Repeated fits must not grow wasm linear memory without bound: every wand, every
 * malloc'd staging buffer and every relinquishable string has to be released.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import type { FitOptions } from '../../src/engine/types'
import { gradientBitmap, makeFitter, writeOut } from './helpers'

const OPTIONS: FitOptions = {
  width: 1280,
  height: 720,
  align: 'center',
  alignY: 'center',
  offsetX: 0,
  offsetY: 0,
  background: { mode: 'color', color: '#101418' },
}

test('30 consecutive fits do not grow wasm memory after warm-up', async (t) => {
  const { fitter } = await makeFitter()
  t.after(() => fitter.dispose())

  const src = gradientBitmap(1024, 768)
  const memory = fitter.magick.memory

  // Warm-up: the first fits legitimately grow memory to the pipeline's high-water mark.
  for (let i = 0; i < 3; i++) fitter.fit(src, OPTIONS)
  const baseline = memory.buffer.byteLength

  let last: ReturnType<typeof fitter.fit> | undefined
  for (let i = 0; i < 30; i++) {
    last = fitter.fit(src, OPTIONS)
    assert.equal(last.width, OPTIONS.width)
    assert.equal(last.height, OPTIONS.height)
  }

  assert.equal(
    memory.buffer.byteLength,
    baseline,
    `memory grew from ${baseline} to ${memory.buffer.byteLength} bytes over 30 fits`,
  )
  writeOut(fitter, 'memory-last.bmp', last!)
})

test('alternating blur fits and encodes are also steady', async (t) => {
  const { fitter } = await makeFitter()
  t.after(() => fitter.dispose())

  const src = gradientBitmap(512, 384)
  const options: FitOptions = { ...OPTIONS, width: 900, height: 600, background: { mode: 'blur', sigma: 8 } }
  const memory = fitter.magick.memory

  for (let i = 0; i < 3; i++) fitter.decode(fitter.encode(fitter.fit(src, options), 'BMP'))
  const baseline = memory.buffer.byteLength

  for (let i = 0; i < 12; i++) {
    const out = fitter.fit(src, options)
    const back = fitter.decode(fitter.encode(out, 'BMP'))
    assert.equal(back.width, 900)
  }

  assert.equal(memory.buffer.byteLength, baseline, 'memory is steady across blur + codec cycles')
})

test('timing: a 2000x1500 source fit to 2000x1500', { timeout: 120_000 }, async (t) => {
  const { fitter } = await makeFitter()
  t.after(() => fitter.dispose())

  const src = gradientBitmap(2000, 1500)
  const options: FitOptions = { ...OPTIONS, width: 2000, height: 1500 }

  const started = performance.now()
  const out = fitter.fit(src, options)
  const elapsed = performance.now() - started

  assert.equal(out.width, 2000)
  assert.equal(out.height, 1500)
  t.diagnostic(`2000x1500 colour fit: ${elapsed.toFixed(0)} ms`)

  const blurStarted = performance.now()
  fitter.fit(src, { ...options, background: { mode: 'blur', sigma: 10 } })
  t.diagnostic(`2000x1500 blur fit: ${(performance.now() - blurStarted).toFixed(0)} ms`)
})
