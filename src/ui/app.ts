// Wires the whole UI together: DOM refs, event handling, and the single render()
// function that keeps the DOM in sync with the store. No framework.
import {
  DEFAULT_OPTIONS,
  BLUR_RANGE,
  FALLBACK_SIZE,
  coerceDimension,
  clampSigma,
  presetDimensions,
} from '../engine/types'
import type { Align, AlignY, AspectPreset, Bitmap, FitOptions } from '../engine/types'
import { createFitter } from '../engine/fitter'
import type { Fitter } from '../engine/fitter'
// eslint-disable-next-line import/no-unresolved -- built by the build agent
import wasmUrl from '../wasm/magick.wasm?url'
import { createInitialState, createStore, TOOLS } from './state'
import type { AppState, Tool } from './state'
import { icons } from './icons'
import { installDebugHook } from './debug'
import type { ImageFitterDebug } from './debug'
import { bitmapToImageBitmap, decodeImageFile, drawPreview, imageBitmapToBitmap } from './stage'
import { renderPanel } from './panels'

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} not found`)
  return el as T
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function freshOptions(width: number, height: number): FitOptions {
  return {
    width,
    height,
    align: DEFAULT_OPTIONS.align,
    alignY: DEFAULT_OPTIONS.alignY,
    offsetX: 0,
    offsetY: 0,
    background: { ...DEFAULT_OPTIONS.background },
  }
}

const DEFAULT_COLOR = DEFAULT_OPTIONS.background.mode === 'color' ? DEFAULT_OPTIONS.background.color : '#ffffff'

export function startApp(): void {
  const store = createStore(createInitialState())

  const els = {
    openBtn: byId<HTMLButtonElement>('openBtn'),
    resetBtn: byId<HTMLButtonElement>('resetBtn'),
    saveBtn: byId<HTMLButtonElement>('saveBtn'),
    fileInput: byId<HTMLInputElement>('fileInput'),
    stage: byId('stage'),
    canvas: byId<HTMLCanvasElement>('previewCanvas'),
    dropzone: byId('dropzone'),
    dragOverlay: byId('dragOverlay'),
    sizeBadge: byId('sizeBadge'),
    optionPanel: byId('optionPanel'),
    toolStrip: byId('toolStrip'),
    toast: byId('toast'),
  }

  // Static icons, injected once.
  byId('brandMark').innerHTML = icons.logo
  byId('openIcon').innerHTML = icons.open
  byId('resetIcon').innerHTML = icons.reset
  byId('saveIcon').innerHTML = icons.save
  byId('dropzoneIcon').innerHTML = icons.image
  byId('dragOverlayIcon').innerHTML = icons.open
  for (const tool of TOOLS) byId(`toolIcon-${tool}`).innerHTML = icons[tool]

  // ---- mutations -----------------------------------------------------------

  function showToast(text: string, kind: 'error' | 'info' = 'error'): void {
    store.update((s) => {
      s.toast = { text, kind }
    })
    window.setTimeout(() => {
      store.update((s) => {
        if (s.toast?.text === text) s.toast = null
      })
    }, 3200)
  }

  function setTool(tool: Tool): void {
    store.update((s) => {
      s.tool = tool
    })
  }

  function applyPreset(preset: AspectPreset): void {
    store.update((s) => {
      s.preset = preset
      if (preset !== 'custom' && s.source) {
        const dims = presetDimensions(preset, s.source.width, s.source.height)
        s.options.width = dims.width
        s.options.height = dims.height
      }
    })
  }

  function setDimension(key: 'width' | 'height', raw: string): void {
    store.update((s) => {
      const fallback = key === 'width' ? FALLBACK_SIZE.width : FALLBACK_SIZE.height
      s.options[key] = coerceDimension(raw, fallback)
      s.preset = 'custom'
    })
  }

  function swapDimensions(): void {
    store.update((s) => {
      const { width, height } = s.options
      s.options.width = height
      s.options.height = width
      s.preset = 'custom'
    })
  }

  function setAlign(align: Align): void {
    store.update((s) => {
      s.options.align = align
      s.options.offsetX = 0
    })
  }

  /** Mirrors setAlign: choosing a vertical alignment resets the vertical nudge. */
  function setAlignY(alignY: AlignY): void {
    store.update((s) => {
      s.options.alignY = alignY
      s.options.offsetY = 0
    })
  }

  function nudge(dx: number, dy: number): void {
    store.update((s) => {
      s.options.offsetX += dx
      s.options.offsetY += dy
    })
  }

  function setBackgroundMode(mode: 'color' | 'blur'): void {
    store.update((s) => {
      s.options.background = mode === 'color' ? { mode: 'color', color: s.color } : { mode: 'blur', sigma: s.sigma }
    })
  }

  function setColor(color: string): void {
    store.update((s) => {
      s.color = color
      if (s.options.background.mode === 'color') s.options.background = { mode: 'color', color }
    })
  }

  function setSigma(raw: number): void {
    store.update((s) => {
      const sigma = clampSigma(raw)
      s.sigma = sigma
      if (s.options.background.mode === 'blur') s.options.background = { mode: 'blur', sigma }
    })
  }

  function resetAll(): void {
    store.update((s) => {
      const width = s.source ? s.source.width : FALLBACK_SIZE.width
      const height = s.source ? s.source.height : FALLBACK_SIZE.height
      s.options = freshOptions(width, height)
      s.preset = 'custom'
      s.color = DEFAULT_COLOR
      s.sigma = BLUR_RANGE.default
    })
  }

  /** Release the decoded bitmap of the image being replaced (ImageBitmaps are not GC'd
   *  promptly and can hold GPU memory). */
  function closePreview(state: AppState): void {
    state.source?.preview?.close()
  }

  function loadFromPreview(preview: ImageBitmap, name: string, raw: Bitmap | null): void {
    store.update((s) => {
      closePreview(s)
      s.source = { width: preview.width, height: preview.height, name, preview, raw }
      s.preset = 'custom'
      s.options = freshOptions(preview.width, preview.height)
      s.color = DEFAULT_COLOR
      s.sigma = BLUR_RANGE.default
    })
  }

  async function loadFile(file: File): Promise<void> {
    if (!file.type.startsWith('image/')) {
      showToast('Please choose an image file')
      return
    }
    try {
      const preview = await decodeImageFile(file)
      loadFromPreview(preview, file.name, null)
    } catch (err) {
      console.error('Failed to decode image', err)
      showToast('Could not read that image')
    }
  }

  function loadSourceFromBitmap(bitmap: Bitmap): void {
    store.update((s) => {
      closePreview(s)
      s.source = { width: bitmap.width, height: bitmap.height, name: 'debug-bitmap', preview: null, raw: bitmap }
      s.preset = 'custom'
      s.options = freshOptions(bitmap.width, bitmap.height)
      s.color = DEFAULT_COLOR
      s.sigma = BLUR_RANGE.default
    })
    bitmapToImageBitmap(bitmap)
      .then((preview) => {
        store.update((s) => {
          if (s.source && s.source.raw === bitmap) s.source.preview = preview
        })
      })
      .catch(() => {
        /* preview is best-effort; raw pixels are already usable for fit()/render() */
      })
  }

  async function ensureRawBitmap(): Promise<Bitmap> {
    const s = store.state
    if (!s.source) throw new Error('No image loaded')
    if (s.source.raw) return s.source.raw
    if (!s.source.preview) throw new Error('Image is not decoded yet')
    const raw = imageBitmapToBitmap(s.source.preview)
    store.update((st) => {
      if (st.source) st.source.raw = raw
    })
    return raw
  }

  // ---- wasm engine + debug hook ---------------------------------------------

  function loadEngine(): Promise<Fitter> {
    return createFitter(wasmUrl)
      .then((fitter) => {
        store.update((s) => {
          s.engine = 'ready'
        })
        return fitter
      })
      .catch((err: unknown) => {
        console.error('Failed to load the image engine', err)
        store.update((s) => {
          s.engine = 'failed'
        })
        throw err instanceof Error ? err : new Error(String(err))
      })
  }

  let fitterPromise: Promise<Fitter> = loadEngine()

  async function renderFit(): Promise<Bitmap> {
    const raw = await ensureRawBitmap()
    try {
      const fitter = await fitterPromise
      return record(fitter.fit(raw, store.state.options))
    } catch (err) {
      if (!(err instanceof WebAssembly.RuntimeError)) throw err
      // A wasm trap does not restore the module's shadow-stack pointer, so every later
      // call into that instance would trap too. The instance is unrecoverable: drop it,
      // load a fresh one and retry the fit exactly once.
      console.warn('The image engine trapped; reloading it and retrying once.', err)
      fitterPromise = loadEngine()
      const fresh = await fitterPromise
      return record(fresh.fit(raw, store.state.options))
    }
  }

  function record(result: Bitmap): Bitmap {
    debugHook.lastResult = result
    return result
  }

  const debugHook: ImageFitterDebug = {
    state: store.state,
    // A getter, because a trap can replace the promise with a freshly loaded engine.
    get fitter() {
      return fitterPromise
    },
    lastResult: undefined,
    loadBitmap: loadSourceFromBitmap,
    render: renderFit,
  }
  installDebugHook(debugHook)

  // ---- save / download -------------------------------------------------------

  function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('toBlob failed'))
      }, 'image/png')
    })
  }

  async function downloadBlob(blob: Blob, filename: string): Promise<void> {
    const url = URL.createObjectURL(blob)
    try {
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 2000)
    }
  }

  async function downloadBitmap(bitmap: Bitmap, targetW: number, targetH: number): Promise<void> {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context unavailable')
    ctx.putImageData(new ImageData(new Uint8ClampedArray(bitmap.data), bitmap.width, bitmap.height), 0, 0)
    await downloadBlob(await canvasToBlob(canvas), `fitted-image-${targetW}x${targetH}.png`)
  }

  async function downloadPreviewCanvas(targetW: number, targetH: number): Promise<void> {
    await downloadBlob(await canvasToBlob(els.canvas), `fitted-image-${targetW}x${targetH}.png`)
  }

  async function handleSave(): Promise<void> {
    if (!store.state.source || store.state.busy) return
    const { width, height } = store.state.options
    store.update((s) => {
      s.busy = true
    })
    try {
      const result = await renderFit()
      await downloadBitmap(result, width, height)
    } catch (err) {
      console.error('Engine render failed, falling back to the preview canvas', err)
      try {
        await downloadPreviewCanvas(width, height)
        showToast('Engine unavailable — saved the preview instead')
      } catch (fallbackErr) {
        console.error('Fallback save failed', fallbackErr)
        showToast('Save failed')
      }
    } finally {
      store.update((s) => {
        s.busy = false
      })
    }
  }

  // ---- rendering ---------------------------------------------------------------

  let panelKey: string | null = null

  function patchPanelValues(state: AppState): void {
    const panel = els.optionPanel
    const active = document.activeElement

    const widthEl = panel.querySelector<HTMLInputElement>('#widthInput')
    if (widthEl && widthEl !== active) widthEl.value = String(state.options.width)
    const heightEl = panel.querySelector<HTMLInputElement>('#heightInput')
    if (heightEl && heightEl !== active) heightEl.value = String(state.options.height)

    panel.querySelectorAll<HTMLElement>('[data-ratio]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.ratio === state.preset))
    })
    panel.querySelectorAll<HTMLElement>('[data-align]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.align === state.options.align))
    })
    panel.querySelectorAll<HTMLElement>('[data-align-y]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.alignY === state.options.alignY))
    })
    const isBlur = state.options.background.mode === 'blur'
    panel.querySelectorAll<HTMLElement>('[data-bg]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String((btn.dataset.bg === 'blur') === isBlur))
    })

    const nudgeEl = panel.querySelector('#nudgeReadout')
    if (nudgeEl) nudgeEl.textContent = `${state.options.offsetX}, ${state.options.offsetY}`

    const colorEl = panel.querySelector<HTMLInputElement>('#bgColorInput')
    if (colorEl && colorEl !== active) {
      colorEl.value = state.options.background.mode === 'color' ? state.options.background.color : state.color
    }

    const blurRow = panel.querySelector<HTMLElement>('#blurRow')
    if (blurRow) blurRow.hidden = !isBlur
    const sigma = state.options.background.mode === 'blur' ? state.options.background.sigma : state.sigma
    const blurRangeEl = panel.querySelector<HTMLInputElement>('#blurRange')
    if (blurRangeEl && blurRangeEl !== active) blurRangeEl.value = String(sigma)
    const blurValueEl = panel.querySelector('#blurValue')
    if (blurValueEl) blurValueEl.textContent = String(sigma)
  }

  function render(state: AppState): void {
    const hasSource = !!state.source

    els.stage.classList.toggle('is-empty', !hasSource)
    els.dropzone.hidden = hasSource
    els.canvas.hidden = !hasSource
    els.sizeBadge.hidden = !hasSource
    if (hasSource) {
      els.sizeBadge.textContent = `${Math.round(state.options.width)} × ${Math.round(state.options.height)}`
      drawPreview(els.canvas, state)
    }
    els.dragOverlay.hidden = !state.dragging

    els.resetBtn.toggleAttribute('disabled', !hasSource)
    els.saveBtn.toggleAttribute('disabled', !hasSource || state.busy)
    els.saveBtn.classList.toggle('is-busy', state.busy)
    byId('saveIcon').innerHTML = state.busy ? icons.spinner : icons.save

    for (const tool of TOOLS) {
      byId(`toolTab-${tool}`).setAttribute('aria-pressed', String(state.tool === tool))
    }

    const key = hasSource ? state.tool : 'none'
    if (key !== panelKey) {
      els.optionPanel.innerHTML = renderPanel(state)
      panelKey = key
    }
    patchPanelValues(state)

    if (state.toast) {
      els.toast.hidden = false
      els.toast.classList.toggle('is-error', state.toast.kind === 'error')
      els.toast.innerHTML = `${state.toast.kind === 'error' ? icons.warning : icons.check}<span>${escapeHtml(state.toast.text)}</span>`
    } else {
      els.toast.hidden = true
    }
  }

  store.subscribe(render)

  // ---- events -------------------------------------------------------------

  els.openBtn.addEventListener('click', () => els.fileInput.click())
  els.dropzone.addEventListener('click', () => els.fileInput.click())
  els.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      els.fileInput.click()
    }
  })
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files?.[0]
    if (file) void loadFile(file)
    els.fileInput.value = ''
  })

  els.stage.addEventListener('dragover', (e) => {
    e.preventDefault()
    if (!store.state.dragging) store.update((s) => (s.dragging = true))
  })
  els.stage.addEventListener('dragleave', (e) => {
    // dragleave also fires when the pointer crosses into a CHILD of the stage, which
    // would make the overlay flicker; only a leave that really exits the stage counts.
    const to = e.relatedTarget
    if (to instanceof Node && els.stage.contains(to)) return
    store.update((s) => (s.dragging = false))
  })
  els.stage.addEventListener('drop', (e) => {
    e.preventDefault()
    store.update((s) => (s.dragging = false))
    const file = e.dataTransfer?.files?.[0]
    if (file) void loadFile(file)
  })

  window.addEventListener('paste', (e) => {
    const item = Array.from(e.clipboardData?.items ?? []).find((it) => it.type.startsWith('image/'))
    const file = item?.getAsFile()
    if (file) void loadFile(file)
  })

  els.resetBtn.addEventListener('click', () => resetAll())
  els.saveBtn.addEventListener('click', () => void handleSave())

  els.toolStrip.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tool]')
    if (btn?.dataset.tool) setTool(btn.dataset.tool as Tool)
  })

  els.optionPanel.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const ratioBtn = target.closest<HTMLElement>('[data-ratio]')
    if (ratioBtn) {
      applyPreset(ratioBtn.dataset.ratio as AspectPreset)
      return
    }
    const alignYBtn = target.closest<HTMLElement>('[data-align-y]')
    if (alignYBtn) {
      setAlignY(alignYBtn.dataset.alignY as AlignY)
      return
    }
    const alignBtn = target.closest<HTMLElement>('[data-align]')
    if (alignBtn) {
      setAlign(alignBtn.dataset.align as Align)
      return
    }
    const bgBtn = target.closest<HTMLElement>('[data-bg]')
    if (bgBtn) {
      setBackgroundMode(bgBtn.dataset.bg as 'color' | 'blur')
      return
    }
    if (target.closest('#swapBtn')) swapDimensions()
  })

  els.optionPanel.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement
    if (target.id === 'widthInput') setDimension('width', target.value)
    else if (target.id === 'heightInput') setDimension('height', target.value)
    else if (target.id === 'bgColorInput') setColor(target.value)
    else if (target.id === 'blurRange') setSigma(Number(target.value))
  })

  // D-pad hold-to-repeat: 500ms initial delay, then every 50ms. Bound once on the
  // panel container (delegated) so it survives the panel's innerHTML being replaced.
  const NUDGE_DIRS: Record<string, [number, number]> = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
  }
  let holdTimeout: number | null = null
  let holdInterval: number | null = null
  function stopHold(): void {
    if (holdTimeout !== null) {
      window.clearTimeout(holdTimeout)
      holdTimeout = null
    }
    if (holdInterval !== null) {
      window.clearInterval(holdInterval)
      holdInterval = null
    }
  }
  function startHold(dir: [number, number]): void {
    stopHold()
    nudge(dir[0], dir[1])
    holdTimeout = window.setTimeout(() => {
      holdInterval = window.setInterval(() => nudge(dir[0], dir[1]), 50)
    }, 500)
  }
  els.optionPanel.addEventListener('pointerdown', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-dir]')
    if (!btn?.dataset.dir) return
    const dir = NUDGE_DIRS[btn.dataset.dir]
    if (!dir) return
    e.preventDefault()
    startHold(dir)
  })
  els.optionPanel.addEventListener('pointerup', stopHold)
  els.optionPanel.addEventListener('pointerleave', stopHold)
  els.optionPanel.addEventListener('pointercancel', stopHold)
  window.addEventListener('pointerup', stopHold)
  window.addEventListener('blur', stopHold)

  window.addEventListener('keydown', (e) => {
    if (store.state.tool !== 'position' || !store.state.source) return
    const target = e.target as HTMLElement | null
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
    const dir =
      e.key === 'ArrowUp' ? [0, -1] : e.key === 'ArrowDown' ? [0, 1] : e.key === 'ArrowLeft' ? [-1, 0] : e.key === 'ArrowRight' ? [1, 0] : null
    if (!dir) return
    e.preventDefault()
    nudge(dir[0], dir[1])
  })
}
