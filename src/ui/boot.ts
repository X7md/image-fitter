// Boot sequence: start the engine worker, wait for the wasm module to be instantiated,
// then reveal the UI. Nothing of the editor is shown (or wired) before the engine is
// ready, so every preview and save goes through MagickWand.
import { EngineClient } from '../engine/client'
import { startApp } from './app'

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} not found`)
  return el as T
}

export async function boot(): Promise<void> {
  const bootEl = byId('boot')
  const status = byId('bootStatus')
  const retry = byId<HTMLButtonElement>('bootRetry')
  const shell = byId('appShell')

  retry.addEventListener('click', () => window.location.reload())

  const engine = new EngineClient()
  try {
    status.textContent = 'Loading image engine…'
    const { version } = await engine.ready
    shell.hidden = false
    bootEl.hidden = true
    startApp(engine, version)
  } catch (err) {
    console.error('Failed to load the image engine', err)
    bootEl.classList.add('is-error')
    status.textContent = 'Could not load the image engine.'
    retry.hidden = false
  }
}
