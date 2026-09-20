/**
 * (e) BMP encode -> decode round trip and (f) the error path for a garbage blob.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { MagickError } from '../../src/wasm/magick'
import { ExceptionType } from '../../src/wasm/enums'
import { gradientBitmap, makeFitter, quadrantBitmap, writeOut } from './helpers'

test('encode/decode: BMP round trip is lossless', async (t) => {
  const { fitter } = await makeFitter()
  t.after(() => fitter.dispose())

  const src = quadrantBitmap(64, 48)
  const blob = fitter.encode(src, 'BMP')
  assert.ok(blob.length > 0)
  assert.equal(blob[0], 0x42, 'BMP magic "B"')
  assert.equal(blob[1], 0x4d, 'BMP magic "M"')

  const back = fitter.decode(blob)
  assert.equal(back.width, src.width)
  assert.equal(back.height, src.height)
  assert.equal(back.data.length, src.data.length)
  assert.deepEqual([...back.data], [...src.data], 'every RGBA byte survives the round trip')
})

test('encode/decode: BMP round trip of a gradient', async (t) => {
  const { fitter } = await makeFitter()
  t.after(() => fitter.dispose())

  const src = gradientBitmap(97, 61) // odd dims exercise BMP row padding
  const back = fitter.decode(fitter.encode(src, 'BMP'))
  assert.equal(back.width, 97)
  assert.equal(back.height, 61)
  assert.deepEqual([...back.data], [...src.data])
  writeOut(fitter, 'codec-gradient.bmp', src)
})

test('encode/decode: PNM and PAM also round trip', async (t) => {
  // ReadPNMImage needs more than wasi-sdk's default 64 KiB shadow stack; the artifact
  // is linked with -Wl,-z,stack-size=1048576 (wasm/build.sh), and this test is the
  // regression check for that: with the small stack it traps "memory access out of
  // bounds" instead of decoding.
  const { fitter } = await makeFitter()
  t.after(() => fitter.dispose())

  const src = quadrantBitmap(32, 32)
  for (const format of ['PNM', 'PAM'] as const) {
    const back = fitter.decode(fitter.encode(src, format))
    assert.equal(back.width, 32, `${format} width`)
    assert.equal(back.height, 32, `${format} height`)
    // PNM has no alpha channel, so only compare RGB there.
    const stride = format === 'PNM' ? 3 : 4
    for (let p = 0; p < 32 * 32; p++) {
      for (let c = 0; c < stride; c++) {
        assert.equal(back.data[p * 4 + c], src.data[p * 4 + c], `${format} pixel ${p} channel ${c}`)
      }
    }
  }
})

test('decode: a garbage blob throws MagickError with a message and a severity', async (t) => {
  const { fitter, stderr } = await makeFitter()
  t.after(() => fitter.dispose())

  const garbage = new Uint8Array(512).fill(0x7f)
  assert.throws(
    () => fitter.decode(garbage),
    (err: unknown) => {
      // Explicit narrowing: `assert.ok` is only an assertion signature with @types/node.
      if (!(err instanceof MagickError)) throw new Error(`expected MagickError, got ${String(err)}`)
      assert.ok(err.message.length > 0, 'the error carries text')
      assert.match(err.message, /MagickReadImageBlob/)
      assert.ok(err.severity >= ExceptionType.Error, `severity ${err.severity} should be an error`)
      return true
    },
  )

  // The wand pool is still healthy afterwards: the exception was cleared.
  const ok = fitter.decode(fitter.encode(quadrantBitmap(8, 8), 'BMP'))
  assert.equal(ok.width, 8)
  assert.deepEqual(stderr, [], 'errors are thrown, not printed')
})

test('decode: an empty blob throws rather than returning an empty bitmap', async (t) => {
  const { fitter } = await makeFitter()
  t.after(() => fitter.dispose())
  assert.throws(() => fitter.decode(new Uint8Array(0)), MagickError)
})

test('encode: an unknown format throws MagickError', async (t) => {
  const { fitter } = await makeFitter()
  t.after(() => fitter.dispose())
  assert.throws(
    () => fitter.encode(quadrantBitmap(8, 8), 'NOSUCHFORMAT' as 'BMP'),
    MagickError,
  )
})
