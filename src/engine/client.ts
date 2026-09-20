// Main-thread handle on the engine worker. Boots the wasm engine off the main thread
// and exposes promise-based setSource / fit calls.
import type { Bitmap, FitOptions } from './types'
import type { EngineRequest, EngineResponse, Quality } from './protocol'

export type { Quality }

interface Pending {
  resolve(bitmap: Bitmap | undefined): void
  reject(err: Error): void
}

export class EngineClient {
  /** Resolves once the wasm module is instantiated inside the worker. */
  readonly ready: Promise<{ version: string }>
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private failure: Error | null = null

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'image-engine' })
    this.ready = new Promise((resolve, reject) => {
      const onBoot = (e: MessageEvent<EngineResponse>) => {
        const msg = e.data
        if (msg.type === 'ready') {
          this.worker.removeEventListener('message', onBoot)
          resolve({ version: msg.version })
        } else if (msg.type === 'boot-error') {
          this.worker.removeEventListener('message', onBoot)
          reject(new Error(msg.message))
        }
      }
      this.worker.addEventListener('message', onBoot)
      this.worker.addEventListener('error', (e) => {
        const err = new Error(e.message || 'Engine worker crashed')
        this.fail(err)
        reject(err)
      })
    })
    this.worker.addEventListener('message', (e: MessageEvent<EngineResponse>) => this.onMessage(e.data))
  }

  /** Hand the source image to the engine. The pixel buffer is transferred, so the
   *  caller must not use `bitmap.data` afterwards. */
  setSource(bitmap: Bitmap): Promise<void> {
    const buffer = bitmap.data.buffer
    return this.request({ type: 'setSource', id: 0, bitmap }, buffer instanceof ArrayBuffer ? [buffer] : []).then(() => undefined)
  }

  clearSource(): Promise<void> {
    return this.request({ type: 'clearSource', id: 0 }).then(() => undefined)
  }

  /** Render the current source with `options`. 'preview' renders at a capped size. */
  async fit(options: FitOptions, quality: Quality = 'full'): Promise<Bitmap> {
    const bitmap = await this.request({ type: 'fit', id: 0, options, quality })
    if (!bitmap) throw new Error('Engine returned no bitmap')
    return bitmap
  }

  dispose(): void {
    this.fail(new Error('Engine disposed'))
    this.worker.terminate()
  }

  private request(req: EngineRequest, transfer: Transferable[] = []): Promise<Bitmap | undefined> {
    if (this.failure) return Promise.reject(this.failure)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ ...req, id }, transfer)
    })
  }

  private onMessage(msg: EngineResponse): void {
    if (msg.type !== 'ok' && msg.type !== 'error') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.type === 'ok') p.resolve(msg.bitmap)
    else p.reject(new Error(msg.message))
  }

  private fail(err: Error): void {
    this.failure = err
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }
}
