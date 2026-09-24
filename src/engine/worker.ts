// Engine worker: owns the wasm MagickWand instance and the loaded source images, so the
// main thread never blocks on a render. Boots the wasm first and reports 'ready';
// the UI is not shown until that message arrives.
import { createFitter } from './fitter'
import type { Fitter } from './fitter'
import { planStack } from './types'
import type { Bitmap } from './types'
import { previewScale, scaleOptions, PREVIEW_LONG_SIDE } from './protocol'
import type { EngineRequest, EngineResponse, Quality, RenderJob } from './protocol'
// eslint-disable-next-line import/no-unresolved -- built by wasm/build.sh
import wasmUrl from '../wasm/magick.wasm?url'

const scope = self as unknown as {
  postMessage(msg: EngineResponse, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<EngineRequest>) => void) | null
}

/** The (re)loading engine. Replaced after a trap, see withEngine(). */
let fitterPromise: Promise<Fitter> = loadFitter()

interface Source {
  full: Bitmap
  /** Downscaled to the preview cap (or `full` itself when it is small). */
  preview: Bitmap
}
const sources = new Map<number, Source>()

/** The preview-size stacked composite for the last stack job; fit-only edits reuse it. */
let previewStack: { key: string; bitmap: Bitmap } | null = null

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

function render(engine: Fitter, job: RenderJob, quality: Quality): Bitmap {
  const picked = job.images.map((key) => {
    const src = sources.get(key)
    if (!src) throw new Error(`Image ${key} is not loaded`)
    return src
  })
  if (picked.length === 0) throw new Error('No image loaded')
  const fitScale = previewScale(job.fit.width, job.fit.height)

  if (!job.stack) {
    const src = picked[0]!
    if (quality === 'full') return engine.fit(src.full, job.fit)
    return engine.fit(src.preview, scaleOptions(job.fit, fitScale))
  }

  const sizes = picked.map((s) => ({ width: s.full.width, height: s.full.height }))
  const plan = planStack(sizes, job.stack)
  if (quality === 'full') {
    return engine.stackAndFit(
      picked.map((s) => s.full),
      plan,
      job.stack.background,
      job.fit,
    )
  }
  const key = JSON.stringify([job.images, job.stack])
  if (previewStack?.key !== key) {
    const small = planStack(sizes, job.stack, previewScale(plan.width, plan.height))
    const bitmap = engine.stack(
      picked.map((s) => s.preview),
      small,
      job.stack.background,
    )
    previewStack = { key, bitmap }
  }
  return engine.fit(previewStack.bitmap, scaleOptions(job.fit, fitScale))
}

async function handle(req: EngineRequest): Promise<void> {
  const t0 = performance.now()
  try {
    switch (req.type) {
      case 'addImage': {
        const preview = await withEngine((engine) => makePreviewSource(engine, req.bitmap))
        sources.set(req.key, { full: req.bitmap, preview })
        send({ type: 'ok', id: req.id, ms: performance.now() - t0 })
        return
      }
      case 'removeImage': {
        sources.delete(req.key)
        send({ type: 'ok', id: req.id, ms: performance.now() - t0 })
        return
      }
      case 'clearImages': {
        sources.clear()
        previewStack = null
        send({ type: 'ok', id: req.id, ms: performance.now() - t0 })
        return
      }
      case 'render': {
        const bitmap = await withEngine((engine) => render(engine, req.job, req.quality))
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
