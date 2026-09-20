/**
 * Binding-layer regression tests for `src/wasm/magick.ts`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { MagickError, loadMagick } from '../../src/wasm/magick'
import { wasmBytes } from './helpers'

test('newPixel(badColour) throws MagickError and does not leak the C PixelWand', async () => {
  const magick = await loadMagick(wasmBytes())
  try {
    // dlmalloc hands out the same address for the same size when nothing between the
    // two probes stayed allocated; a leaked PixelWand per iteration moves the heap top.
    const probe = magick.alloc(64)
    magick.free(probe)

    for (let i = 0; i < 500; i++) {
      assert.throws(() => magick.newPixel('definitely-not-a-colour'), MagickError)
    }

    const again = magick.alloc(64)
    magick.free(again)
    assert.equal(again, probe, `heap top moved from ${probe} to ${again}: PixelWands leaked`)
    assert.equal(magick.memory.buffer.byteLength, 67108864, 'memory did not grow')
  } finally {
    magick.terminate()
  }
})

test('readCString stops at the end of memory instead of scanning forever', async () => {
  const magick = await loadMagick(wasmBytes())
  try {
    const end = magick.memory.buffer.byteLength
    // Four non-NUL bytes right at the top of linear memory, with nothing after them.
    magick.bytes().set([0x61, 0x62, 0x63, 0x64], end - 4)
    assert.equal(magick.readCString(end - 4), 'abcd')
    magick.bytes().fill(0, end - 4)
    assert.equal(magick.readCString(0), '', 'NULL reads as empty')
  } finally {
    magick.terminate()
  }
})

test('exportRGBA returns a copy that is independent of wasm memory', async () => {
  const magick = await loadMagick(wasmBytes())
  try {
    const w = magick.newWand()
    w.newImage(4, 4, '#ff8000')
    const a = w.exportRGBA()
    assert.ok(a instanceof Uint8ClampedArray)
    assert.notEqual(a.buffer, magick.memory.buffer, 'not a view over linear memory')
    assert.deepEqual([...a.subarray(0, 4)], [255, 128, 0, 255])
    w.dispose()
    // Still readable after the wand (and its pixel cache) are gone.
    assert.deepEqual([...a.subarray(60, 64)], [255, 128, 0, 255])
  } finally {
    magick.terminate()
  }
})
