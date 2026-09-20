// Wires the whole UI together: DOM refs, event handling, and the single render()
// function that keeps the DOM in sync with the store. No framework.
//
// Every pixel on the stage comes from the wasm engine (MagickWand in a worker): a
// change to the fit options schedules a preview render (latest-wins, one in flight),
// and Save renders the same pipeline at full resolution.
import {
  DEFAULT_OPTIONS,
  BLUR_RANGE,
  FALLBACK_SIZE,
  coerceDimension,
  clampSigma,
  presetDimensions,
} from '../engine/types'
import type { Align, AlignY, AspectPreset, Bitmap, FitOptions } from '../engine/types'
import type { EngineClient } from '../engine/client'
import { createInitialState, createStore, TOOLS } from './state'
import type { AppState, Tool } from './state'
import { icons } from './icons'
import { installDebugHook } from './debug'
import type { ImageFitterDebug } from './debug'
import { bitmapToPngBlob, decodeImageFile, drawBitmap } from './stage'
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

function cloneOptions(options: FitOptions): FitOptions {
  return { ...options, background: { ...options.background } }
}

const DEFAULT_COLOR = DEFAULT_OPTIONS.background.mode === 'color' ? DEFAULT_OPTIONS.background.color : '#ffffff'

export function startApp(engine: EngineClient, engineVersion: string): void {
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
    sizeText: byId('sizeText'),
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

  // ---- source loading --------------------------------------------------------

  /** Bumped for every new source; preview results tagged with an older token are dropped. */
  let sourceToken = 0

  /** Hand the pixels to the engine (posted before the state changes, so any render()
   *  that follows is guaranteed to see the new source in the worker's queue). */
  function installSource(bitmap: Bitmap, name: string): void {
    const token = ++sourceToken
    const { width, height } = bitmap
    engine.setSource(bitmap).catch((err: unknown) => {
      if (token !== sourceToken) return
      console.error('Engine rejected the image', err)
      showToast('Could not load that image into the engine')
      store.update((s) => {
        s.source = null
        s.preview = null
      })
    })
    store.update((s) => {
      s.source = { width, height, name }
      s.preview = null
      s.preset = 'custom'
      s.options = freshOptions(width, height)
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
      const bitmap = await decodeImageFile(file)
      installSource(bitmap, file.name)
    } catch (err) {
      console.error('Failed to decode image', err)
      showToast('Could not read that image')
    }
  }

  function loadSourceFromBitmap(bitmap: Bitmap): void {
    // Copy: setSource transfers the buffer and the caller may still hold theirs.
    installSource({ width: bitmap.width, height: bitmap.height, data: new Uint8ClampedArray(bitmap.data) }, 'debug-bitmap')
  }

  // ---- preview rendering (engine, latest-wins) -------------------------------

  let previewInFlight = false
  let previewDirty = false
  let previewKey = ''
  const idleWaiters: Array<() => void> = []

  function engineFailed(err: unknown): void {
    console.error('Engine render failed', err)
    store.update((s) => {
      s.engine = 'failed'
    })
    showToast('Image engine failed — reload the page')
  }

  async function runPreview(): Promise<void> {
    previewInFlight = true
    try {
      while (previewDirty) {
        previewDirty = false
        const token = sourceToken
        if (!store.state.source) continue
        const options = cloneOptions(store.state.options)
        try {
          const frame = await engine.fit(options, 'preview')
          if (token !== sourceToken) continue
          store.update((s) => {
            s.preview = frame
          })
        } catch (err) {
          if (token !== sourceToken) continue
          engineFailed(err)
          previewDirty = false
        }
      }
    } finally {
      previewInFlight = false
      store.update((s) => {
        s.rendering = false
      })
      for (const resolve of idleWaiters.splice(0)) resolve()
    }
  }

  /** Runs before render(): schedules a preview whenever the source or options changed. */
  function previewWatcher(state: AppState): void {
    const key = state.source ? `${sourceToken}|${JSON.stringify(state.options)}` : ''
    if (key === previewKey) return
    previewKey = key
    if (!state.source) return
    previewDirty = true
    state.rendering = true
    if (!previewInFlight) void runPreview()
  }

  function whenIdle(): Promise<void> {
    if (!previewInFlight && !previewDirty) return Promise.resolve()
    return new Promise((resolve) => idleWaiters.push(resolve))
  }

  // ---- full render / debug hook ----------------------------------------------

  async function renderFull(): Promise<Bitmap> {
    if (!store.state.source) throw new Error('No image loaded')
    const result = await engine.fit(cloneOptions(store.state.options), 'full')
    debugHook.lastResult = result
    return result
  }

  const debugHook: ImageFitterDebug = {
    state: store.state,
    engine,
    engineVersion,
    lastResult: undefined,
    loadBitmap: loadSourceFromBitmap,
    render: renderFull,
    whenIdle,
  }
  installDebugHook(debugHook)

  // ---- save / download -------------------------------------------------------

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

  async function handleSave(): Promise<void> {
    if (!store.state.source || store.state.busy) return
    const { width, height } = store.state.options
    store.update((s) => {
      s.busy = true
    })
    try {
      const result = await renderFull()
      await downloadBlob(await bitmapToPngBlob(result), `fitted-image-${width}x${height}.png`)
    } catch (err) {
      console.error('Save failed', err)
      showToast('Save failed')
    } finally {
      store.update((s) => {
        s.busy = false
      })
    }
  }

  // ---- rendering ---------------------------------------------------------------

  let panelKey: string | null = null
  let drawnPreview: Bitmap | null = null

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
    const hasFrame = hasSource && !!state.preview

    els.stage.classList.toggle('is-empty', !hasSource)
    els.stage.classList.toggle('is-rendering', hasSource && state.rendering)
    els.dropzone.hidden = hasSource
    els.canvas.hidden = !hasFrame
    els.sizeBadge.hidden = !hasSource
    if (hasSource) {
      els.sizeText.textContent = `${Math.round(state.options.width)} × ${Math.round(state.options.height)}`
    }
    if (state.preview && state.preview !== drawnPreview) {
      drawBitmap(els.canvas, state.preview)
      drawnPreview = state.preview
    } else if (!state.preview) {
      drawnPreview = null
    }
    els.dragOverlay.hidden = !state.dragging

    els.resetBtn.toggleAttribute('disabled', !hasSource)
    els.saveBtn.toggleAttribute('disabled', !hasSource || state.busy || state.engine !== 'ready')
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

  // Order matters: the watcher marks `rendering` before render() paints the same pass.
  store.subscribe(previewWatcher)
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
