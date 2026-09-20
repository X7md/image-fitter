// Engine worker: owns the wasm MagickWand instance and the loaded source image, so the
// main thread never blocks on a render. Boots the wasm first and reports 'ready';
// the UI is not shown until that message arrives.
import { createFitter } from './fitter'
import type { Fitter } from './fitter'
import type { Bitmap } from './types'
import { previewScale, scaleOptions, PREVIEW_LONG_SIDE } from './protocol'
import type { EngineRequest, EngineResponse } from './protocol'
// eslint-disable-next-line import/no-unresolved -- built by wasm/build.sh
import wasmUrl from '../wasm/magick.wasm?url'

const scope = self as unknown as {
  postMessage(msg: EngineResponse, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<EngineRequest>) => void) | null
}

/** The (re)loading engine. Replaced after a trap, see withEngine(). */
let fitterPromise: Promise<Fitter> = loadFitter()
let source: Bitmap | null = null
/** The source downscaled to the preview cap (or the source itself when it is small). */
let previewSource: Bitmap | null = null

function loadFitter(): Promise<Fitter> {
  return createFitter(wasmUrl)
}

function send(msg: EngineResponse, transfer?: Transferable[]): void {
  scope.postMessage(msg, transfer)
}

function bitmapTransfer(bitmap: Bitmap): Transferable[] {
  const buffer = bitmap.data.buffer
  return buffer instanceof ArrayBuffer ? [buffer] : []
}

function makePreviewSource(engine: Fitter, src: Bitmap): Bitmap {
  const scale = previewScale(src.width, src.height)
  if (scale === 1) return src
  return engine.scale(src, src.width * scale, src.height * scale)
}

/**
 * Run `work` against the current fitter. A wasm trap leaves the module's shadow stack
 * pointer where it was, so the instance is unrecoverable: reload it and retry once.
 */
async function withEngine<T>(work: (engine: Fitter) => T): Promise<T> {
  const engine = await fitterPromise
  try {
    return work(engine)
  } catch (err) {
    if (!(err instanceof WebAssembly.RuntimeError)) throw err
    console.warn('The image engine trapped; reloading it and retrying once.', err)
    fitterPromise = loadFitter()
    return work(await fitterPromise)
  }
}

async function handle(req: EngineRequest): Promise<void> {
  const t0 = performance.now()
  try {
    switch (req.type) {
      case 'setSource': {
        source = req.bitmap
        previewSource = await withEngine((engine) => makePreviewSource(engine, req.bitmap))
        send({ type: 'ok', id: req.id, ms: performance.now() - t0 })
        return
      }
      case 'clearSource': {
        source = null
        previewSource = null
        send({ type: 'ok', id: req.id, ms: performance.now() - t0 })
        return
      }
      case 'fit': {
        if (!source || !previewSource) throw new Error('No image loaded')
        const src = source
        const preview = previewSource
        const bitmap = await withEngine((engine) => {
          if (req.quality === 'full') return engine.fit(src, req.options)
          const scale = previewScale(req.options.width, req.options.height)
          return engine.fit(preview, scaleOptions(req.options, scale))
        })
        send({ type: 'ok', id: req.id, bitmap, ms: performance.now() - t0 }, bitmapTransfer(bitmap))
        return
      }
    }
  } catch (err) {
    send({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) })
  }
}

// Requests are handled strictly in order: a fit never sees a half-installed source.
let queue: Promise<void> = Promise.resolve()
scope.onmessage = (e) => {
  const req = e.data
  queue = queue.then(() => handle(req))
}

fitterPromise
  .then((engine) => {
    send({ type: 'ready', version: `${engine.magick.version} (preview cap ${PREVIEW_LONG_SIDE}px)` })
  })
  .catch((err: unknown) => {
    send({ type: 'boot-error', message: err instanceof Error ? err.message : String(err) })
  })
