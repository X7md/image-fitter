// window.__imageFitter debug hook, always installed by app.ts on boot. Tests drive the
// app through this object rather than simulating real file uploads / wasm loads.
import type { Bitmap } from '../engine/types'
import type { Fitter } from '../engine/fitter'
import type { AppState } from './state'

export interface ImageFitterDebug {
  readonly state: AppState
  readonly fitter: Promise<Fitter> | undefined
  lastResult?: Bitmap
  /** Loads a raw RGBA bitmap as if a file had been opened through the file input. */
  loadBitmap(bitmap: Bitmap): void
  /** Runs the wasm fit with the current options and stores the result in `lastResult`. */
  render(): Promise<Bitmap>
}

declare global {
  interface Window {
    __imageFitter?: ImageFitterDebug
  }
}

export function installDebugHook(hook: ImageFitterDebug): void {
  window.__imageFitter = hook
}
