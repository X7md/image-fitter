// window.__imageFitter debug hook, installed by app.ts once the engine has booted. Tests
// drive the app through this object rather than simulating real file uploads.
import type { Bitmap } from '../engine/types'
import type { EngineClient } from '../engine/client'
import type { AppState } from './state'

export interface ImageFitterDebug {
  readonly state: AppState
  /** The engine worker handle (already booted). */
  readonly engine: EngineClient
  /** Engine version string reported by the worker on boot. */
  readonly engineVersion: string
  lastResult?: Bitmap
  /** Loads a raw RGBA bitmap as if a file had been opened through the file input. */
  loadBitmap(bitmap: Bitmap): void
  /** Starts a Stack session with these bitmaps, as if picked through the Stack card. */
  loadBitmaps(bitmaps: Bitmap[]): void
  /** Runs the full-resolution wasm render (stack + fit) with the current options and stores the result
   *  in `lastResult`. */
  render(): Promise<Bitmap>
  /** Resolves once no preview render is in flight or queued and the canvas shows the
   *  frame for the current options. */
  whenIdle(): Promise<void>
}

declare global {
  interface Window {
    __imageFitter?: ImageFitterDebug
  }
}

export function installDebugHook(hook: ImageFitterDebug): void {
  window.__imageFitter = hook
}
