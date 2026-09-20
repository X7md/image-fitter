/**
 * Shared fixtures for the Node tests.
 *
 * Not named `*.test.ts` on purpose so the test runner does not try to execute it.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Fitter, createFitter } from '../../src/engine/fitter'
import type { Bitmap } from '../../src/engine/types'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(HERE, '..', '..')
export const WASM_PATH = join(REPO_ROOT, 'src', 'wasm', 'magick.wasm')
export const OUT_DIR = join(REPO_ROOT, 'tests', 'out')

/**
 * The module bytes. Passed to `loadMagick` as a `BufferSource`, so no host fetch is used.
 *
 * The explicit `Uint8Array<ArrayBuffer>` matters: `readFileSync` hands back a `Buffer`,
 * whose `ArrayBufferLike` buffer is not assignable to the DOM `BufferSource` type.
 */
export function wasmBytes(): Uint8Array<ArrayBuffer> {
  const buf = readFileSync(WASM_PATH)
  const copy = new Uint8Array(new ArrayBuffer(buf.byteLength))
  copy.set(buf)
  return copy
}

/**
 * A `Fitter` backed by our own WASI shim. stdout/stderr are captured rather than
 * printed, so a test can assert the module stays silent.
 */
export async function makeFitter(): Promise<{ fitter: Fitter; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const fitter = await createFitter(wasmBytes(), {
    wasi: {
      args: ['magick'],
      env: {},
      stdout: (t) => stdout.push(t),
      stderr: (t) => stderr.push(t),
      debug: true,
    },
  })
  return { fitter, stdout, stderr }
}

export type RGBA = readonly [number, number, number, number]

export const RED: RGBA = [255, 0, 0, 255]
export const GREEN: RGBA = [0, 255, 0, 255]
export const BLUE: RGBA = [0, 0, 255, 255]
export const YELLOW: RGBA = [255, 255, 0, 255]

/**
 * A bitmap made of four solid quadrants (TL red, TR green, BL blue, BR yellow).
 *
 * Solid regions are what makes pixel assertions meaningful: Lanczos resampling of a
 * constant area is that same constant, so any sample taken a few pixels away from a
 * quadrant boundary is exact rather than a resampled blend.
 */
export function quadrantBitmap(width: number, height: number): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4)
  const halfW = width / 2
  const halfH = height / 2
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const top = y < halfH
      const left = x < halfW
      const c = top ? (left ? RED : GREEN) : left ? BLUE : YELLOW
      const i = (y * width + x) * 4
      data[i] = c[0]
      data[i + 1] = c[1]
      data[i + 2] = c[2]
      data[i + 3] = c[3]
    }
  }
  return { width, height, data }
}

/** A horizontal+vertical gradient, for tests that want continuous tone. */
export function gradientBitmap(width: number, height: number): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = Math.round((x / Math.max(1, width - 1)) * 255)
      data[i + 1] = Math.round((y / Math.max(1, height - 1)) * 255)
      data[i + 2] = 96
      data[i + 3] = 255
    }
  }
  return { width, height, data }
}

export function pixelAt(bitmap: Bitmap, x: number, y: number): RGBA {
  const i = (y * bitmap.width + x) * 4
  return [bitmap.data[i]!, bitmap.data[i + 1]!, bitmap.data[i + 2]!, bitmap.data[i + 3]!]
}

/** `#rrggbb` -> RGBA with alpha 255. */
export function hexToRGBA(hex: string): RGBA {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255]
}

/** Max per-channel difference between two pixels. */
export function maxChannelDiff(a: RGBA, b: RGBA): number {
  let worst = 0
  for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!))
  return worst
}

export function describePixel(p: RGBA): string {
  return `rgba(${p.join(',')})`
}

/** Write a `.bmp` next to the other test outputs, for eyeballing. `tests/out/` is gitignored. */
export function writeOut(fitter: Fitter, name: string, bitmap: Bitmap): string {
  mkdirSync(OUT_DIR, { recursive: true })
  const path = join(OUT_DIR, name)
  writeFileSync(path, fitter.encode(bitmap, 'BMP'))
  return path
}
