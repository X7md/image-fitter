// Wires the whole UI together: DOM refs, event handling, and the single render()
// function that keeps the DOM in sync with the store. No framework.
//
// Two modes share one editor: Fit (one image onto a canvas) and Stack (several images
// joined in a row/column/grid, then fitted with the same tools). Every pixel on the
// stage comes from the wasm engine (MagickWand in a worker): a change to the options
// schedules a preview render (latest-wins, one in flight), and Save renders the same
// pipeline at full resolution.
import {
  DEFAULT_OPTIONS,
  DEFAULT_STACK,
  BLUR_RANGE,
  FALLBACK_SIZE,
  STACK_GAP_RANGE,
  coerceDimension,
  clampSigma,
  planStack,
  presetDimensions,
} from '../engine/types'
import type {
  Align,
  AlignY,
  AspectPreset,
  Bitmap,
  FitOptions,
  StackAlign,
  StackLayout,
  StackMatch,
} from '../engine/types'
import type { EngineClient, RenderJob } from '../engine/client'
import { createInitialState, createStore, toolsFor, TOOLS } from './state'
import type { AppState, LoadedImage, Mode, SourceImage, Tool } from './state'
import { icons } from './icons'
import { installDebugHook } from './debug'
import type { ImageFitterDebug } from './debug'
import { bitmapThumbnail, bitmapToPngBlob, decodeImageFile, drawBitmap } from './stage'
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

function renderJob(state: AppState): RenderJob {
  return {
    images: state.images.map((img) => img.key),
    stack: state.mode === 'stack' ? { ...state.stack } : null,
    fit: cloneOptions(state.options),
  }
}

/** What the fit tools see: the single image, or the stacked result's size. */
function computeSource(state: AppState): SourceImage | null {
  if (!state.mode || state.images.length === 0) return null
  if (state.mode === 'fit') {
    const { width, height, name } = state.images[0]!
    return { width, height, name }
  }
  const plan = planStack(state.images, state.stack)
  return { width: plan.width, height: plan.height, name: `stack of ${state.images.length}` }
}

/** Recompute `source`; while the target follows the source, keep it on the source size
 *  (or on the chosen ratio preset of it). */
function syncSource(state: AppState): void {
  const prev = state.source
  state.source = computeSource(state)
  const next = state.source
  if (!next || !state.sizeFollowsSource) return
  if (prev && prev.width === next.width && prev.height === next.height) return
  const dims = presetDimensions(state.preset, next.width, next.height)
  state.options.width = dims.width
  state.options.height = dims.height
}

const DEFAULT_COLOR = DEFAULT_OPTIONS.background.mode === 'color' ? DEFAULT_OPTIONS.background.color : '#ffffff'
const DEFAULT_TOOL: Record<Mode, Tool> = { fit: 'ratio', stack: 'layout' }

interface Decoded {
  bitmap: Bitmap
  name: string
}

export function startApp(engine: EngineClient, engineVersion: string): void {
  const store = createStore(createInitialState())

  const els = {
    homeBtn: byId<HTMLButtonElement>('homeBtn'),
    modePill: byId('modePill'),
    openBtn: byId<HTMLButtonElement>('openBtn'),
    resetBtn: byId<HTMLButtonElement>('resetBtn'),
    saveBtn: byId<HTMLButtonElement>('saveBtn'),
    fileInput: byId<HTMLInputElement>('fileInput'),
    stackInput: byId<HTMLInputElement>('stackInput'),
    stage: byId('stage'),
    canvas: byId<HTMLCanvasElement>('previewCanvas'),
    intro: byId('intro'),
    fitCard: byId<HTMLButtonElement>('fitCard'),
    stackCard: byId<HTMLButtonElement>('stackCard'),
    dragOverlay: byId('dragOverlay'),
    dragOverlayText: byId('dragOverlayText'),
    sizeBadge: byId('sizeBadge'),
    sizeText: byId('sizeText'),
    optionPanel: byId('optionPanel'),
    toolStrip: byId('toolStrip'),
    toast: byId('toast'),
  }

  // Static icons, injected once.
  byId('brandMark').innerHTML = icons.logo
  byId('homeIcon').innerHTML = icons.back
  byId('openIcon').innerHTML = icons.open
  byId('resetIcon').innerHTML = icons.reset
  byId('saveIcon').innerHTML = icons.save
  byId('fitCardIcon').innerHTML = icons.fit
  byId('stackCardIcon').innerHTML = icons.stack
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
      s.sizeFollowsSource = true
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
      s.sizeFollowsSource = false
    })
  }

  function swapDimensions(): void {
    store.update((s) => {
      const { width, height } = s.options
      s.options.width = height
      s.options.height = width
      s.preset = 'custom'
      s.sizeFollowsSource = false
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

  /** Change the stack options; the fit target follows the new stacked size. */
  function updateStack(mutate: (state: AppState) => void): void {
    store.update((s) => {
      mutate(s)
      syncSource(s)
    })
  }

  function resetAll(): void {
    store.update((s) => {
      s.stack = { ...DEFAULT_STACK }
      s.preset = 'custom'
      s.sizeFollowsSource = true
      s.color = DEFAULT_COLOR
      s.sigma = BLUR_RANGE.default
      syncSource(s)
      const width = s.source ? s.source.width : FALLBACK_SIZE.width
      const height = s.source ? s.source.height : FALLBACK_SIZE.height
      s.options = freshOptions(width, height)
    })
  }

  // ---- images --------------------------------------------------------------------

  let nextKey = 1
  /** Bumped whenever the engine's image set changes; preview results tagged with an
   *  older token are dropped. */
  let sourceToken = 0

  /** Hand pixels to the engine (posted before the state changes, so any render that
   *  follows is queued after it in the worker). The buffer is transferred. */
  function register({ bitmap, name }: Decoded): LoadedImage {
    const key = nextKey++
    const image: LoadedImage = { key, width: bitmap.width, height: bitmap.height, name, thumb: bitmapThumbnail(bitmap) }
    engine.addImage(key, bitmap).catch((err: unknown) => {
      if (!store.state.images.some((img) => img.key === key)) return
      console.error('Engine rejected the image', err)
      showToast('Could not load that image into the engine')
      dropImage(key)
    })
    return image
  }

  function clearEngine(): void {
    sourceToken++
    engine.clearImages().catch((err: unknown) => console.error('clearImages failed', err))
  }

  /** Start a fresh Fit or Stack session with `loaded` (Fit keeps the first image). */
  function openSession(mode: Mode, loaded: Decoded[]): void {
    if (loaded.length === 0) return
    clearEngine()
    const images = (mode === 'fit' ? loaded.slice(0, 1) : loaded).map(register)
    store.update((s) => {
      if (s.mode !== mode) s.tool = DEFAULT_TOOL[mode]
      s.mode = mode
      s.images = images
      s.stack = { ...DEFAULT_STACK }
      s.preview = null
      s.preset = 'custom'
      s.sizeFollowsSource = true
      s.color = DEFAULT_COLOR
      s.sigma = BLUR_RANGE.default
      s.source = null
      syncSource(s)
      const src = s.source as SourceImage | null
      s.options = freshOptions(src?.width ?? FALLBACK_SIZE.width, src?.height ?? FALLBACK_SIZE.height)
    })
  }

  function addToStack(loaded: Decoded[]): void {
    if (loaded.length === 0) return
    sourceToken++
    const images = loaded.map(register)
    store.update((s) => {
      s.images.push(...images)
      syncSource(s)
    })
  }

  function dropImage(key: number): void {
    sourceToken++
    engine.removeImage(key).catch((err: unknown) => console.error('removeImage failed', err))
    store.update((s) => {
      s.images = s.images.filter((img) => img.key !== key)
      if (s.images.length === 0) {
        s.mode = null
        s.source = null
        s.preview = null
        return
      }
      syncSource(s)
    })
  }

  function moveImage(key: number, delta: number): void {
    updateStack((s) => {
      const i = s.images.findIndex((img) => img.key === key)
      const j = i + delta
      if (i < 0 || j < 0 || j >= s.images.length) return
      const [moved] = s.images.splice(i, 1)
      s.images.splice(j, 0, moved!)
    })
  }

  function goHome(): void {
    clearEngine()
    store.update((s) => {
      s.mode = null
      s.images = []
      s.source = null
      s.preview = null
    })
  }

  async function decodeFiles(files: readonly File[]): Promise<Decoded[]> {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) {
      if (files.length > 0) showToast('Please choose an image file')
      return []
    }
    const results = await Promise.allSettled(images.map((f) => decodeImageFile(f)))
    const decoded: Decoded[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') decoded.push({ bitmap: r.value, name: images[i]!.name })
      else console.error('Failed to decode image', r.reason)
    })
    if (decoded.length < files.length) {
      showToast(decoded.length === 0 ? 'Could not read that image' : 'Some files could not be read')
    }
    return decoded
  }

  /**
   * `target` is where the files were aimed: a mode card / picker, or 'auto' (drop on the
   * stage, paste). Auto adds to an open stack, replaces the image in Fit, and on the
   * intro picks Fit for one file and Stack for several.
   */
  async function loadFiles(files: readonly File[], target: Mode | 'auto'): Promise<void> {
    const loaded = await decodeFiles(files)
    if (loaded.length === 0) return
    const mode = store.state.mode
    if (target === 'auto') {
      if (mode === 'stack') addToStack(loaded)
      else openSession(mode ?? (loaded.length > 1 ? 'stack' : 'fit'), loaded)
      return
    }
    if (target === 'stack' && mode === 'stack') addToStack(loaded)
    else openSession(target, loaded)
  }

  function copyBitmap(bitmap: Bitmap): Bitmap {
    // Copy: addImage transfers the buffer and the caller may still hold theirs.
    return { width: bitmap.width, height: bitmap.height, data: new Uint8ClampedArray(bitmap.data) }
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
        const job = renderJob(store.state)
        try {
          const frame = await engine.render(job, 'preview')
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

  /** Runs before render(): schedules a preview whenever the images or options changed. */
  function previewWatcher(state: AppState): void {
    const key = state.source ? `${sourceToken}|${JSON.stringify(renderJob(state))}` : ''
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
    const result = await engine.render(renderJob(store.state), 'full')
    debugHook.lastResult = result
    return result
  }

  const debugHook: ImageFitterDebug = {
    state: store.state,
    engine,
    engineVersion,
    lastResult: undefined,
    loadBitmap: (bitmap) => openSession('fit', [{ bitmap: copyBitmap(bitmap), name: 'debug-bitmap' }]),
    loadBitmaps: (bitmaps) =>
      openSession(
        'stack',
        bitmaps.map((b, i) => ({ bitmap: copyBitmap(b), name: `debug-bitmap-${i + 1}` })),
      ),
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
    const prefix = store.state.mode === 'stack' ? 'stacked-image' : 'fitted-image'
    store.update((s) => {
      s.busy = true
    })
    try {
      const result = await renderFull()
      await downloadBlob(await bitmapToPngBlob(result), `${prefix}-${width}x${height}.png`)
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

  function pressAll(panel: HTMLElement, attr: string, current: string): void {
    panel.querySelectorAll<HTMLElement>(`[${attr}]`).forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.getAttribute(attr) === current))
    })
  }

  function patchPanelValues(state: AppState): void {
    const panel = els.optionPanel
    const active = document.activeElement

    const widthEl = panel.querySelector<HTMLInputElement>('#widthInput')
    if (widthEl && widthEl !== active) widthEl.value = String(state.options.width)
    const heightEl = panel.querySelector<HTMLInputElement>('#heightInput')
    if (heightEl && heightEl !== active) heightEl.value = String(state.options.height)

    pressAll(panel, 'data-ratio', state.preset)
    pressAll(panel, 'data-align', state.options.align)
    pressAll(panel, 'data-align-y', state.options.alignY)
    const isBlur = state.options.background.mode === 'blur'
    pressAll(panel, 'data-bg', isBlur ? 'blur' : 'color')

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

    // Stack tools
    const { stack } = state
    pressAll(panel, 'data-layout', stack.layout)
    pressAll(panel, 'data-match', stack.match)
    pressAll(panel, 'data-stack-align', stack.align)
    const columnsRow = panel.querySelector<HTMLElement>('#columnsRow')
    if (columnsRow) columnsRow.hidden = stack.layout !== 'grid'
    const columnsEl = panel.querySelector<HTMLInputElement>('#columnsInput')
    if (columnsEl) {
      columnsEl.max = String(Math.max(1, state.images.length))
      if (columnsEl !== active) columnsEl.value = String(stack.columns)
    }
    const gapEl = panel.querySelector<HTMLInputElement>('#gapRange')
    if (gapEl && gapEl !== active) gapEl.value = String(stack.gap)
    const gapValueEl = panel.querySelector('#gapValue')
    if (gapValueEl) gapValueEl.textContent = String(stack.gap)
    const stackColorEl = panel.querySelector<HTMLInputElement>('#stackColorInput')
    if (stackColorEl && stackColorEl !== active) stackColorEl.value = stack.background
  }

  function render(state: AppState): void {
    const hasSource = !!state.source
    const hasFrame = hasSource && !!state.preview

    els.stage.classList.toggle('is-empty', !hasSource)
    els.stage.classList.toggle('is-rendering', hasSource && state.rendering)
    els.intro.hidden = !!state.mode
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
    els.dragOverlay.hidden = !(state.dragging && state.mode)
    els.dragOverlayText.textContent = state.mode === 'stack' ? 'Release to add images' : 'Release to replace the image'

    els.homeBtn.hidden = !state.mode
    els.modePill.hidden = !state.mode
    els.modePill.textContent = state.mode === 'stack' ? 'Stack' : 'Fit'
    els.openBtn.setAttribute('aria-label', state.mode === 'stack' ? 'Add images' : 'Open image')
    els.resetBtn.toggleAttribute('disabled', !hasSource)
    els.saveBtn.toggleAttribute('disabled', !hasSource || state.busy || state.engine !== 'ready')
    els.saveBtn.classList.toggle('is-busy', state.busy)
    byId('saveIcon').innerHTML = state.busy ? icons.spinner : icons.save

    const tools = toolsFor(state.mode)
    els.toolStrip.hidden = !state.mode
    for (const tool of TOOLS) {
      const tab = byId(`toolTab-${tool}`)
      tab.hidden = !tools.includes(tool)
      tab.setAttribute('aria-pressed', String(state.tool === tool))
    }

    const key = hasSource
      ? [
          state.mode,
          state.tool,
          state.tool === 'images' ? state.images.map((img) => img.key).join(',') : '',
          state.tool === 'sizing' ? state.stack.layout : '',
        ].join('|')
      : 'none'
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

  const pickFit = () => els.fileInput.click()
  const pickStack = () => els.stackInput.click()

  els.homeBtn.addEventListener('click', goHome)
  els.openBtn.addEventListener('click', () => (store.state.mode === 'stack' ? pickStack() : pickFit()))
  els.fitCard.addEventListener('click', pickFit)
  els.stackCard.addEventListener('click', pickStack)
  els.fileInput.addEventListener('change', () => {
    const files = [...(els.fileInput.files ?? [])]
    if (files.length) void loadFiles(files, 'fit')
    els.fileInput.value = ''
  })
  els.stackInput.addEventListener('change', () => {
    const files = [...(els.stackInput.files ?? [])]
    if (files.length) void loadFiles(files, 'stack')
    els.stackInput.value = ''
  })

  function highlightCard(card: Element | null): void {
    for (const c of [els.fitCard, els.stackCard]) c.classList.toggle('is-drop-target', c === card)
  }

  els.stage.addEventListener('dragover', (e) => {
    e.preventDefault()
    highlightCard((e.target as HTMLElement).closest('.intro-card'))
    if (!store.state.dragging) store.update((s) => (s.dragging = true))
  })
  els.stage.addEventListener('dragleave', (e) => {
    // dragleave also fires when the pointer crosses into a CHILD of the stage, which
    // would make the overlay flicker; only a leave that really exits the stage counts.
    const to = e.relatedTarget
    if (to instanceof Node && els.stage.contains(to)) return
    highlightCard(null)
    store.update((s) => (s.dragging = false))
  })
  els.stage.addEventListener('drop', (e) => {
    e.preventDefault()
    highlightCard(null)
    store.update((s) => (s.dragging = false))
    const files = [...(e.dataTransfer?.files ?? [])]
    if (!files.length) return
    const card = store.state.mode ? null : (e.target as HTMLElement).closest<HTMLElement>('[data-mode]')
    void loadFiles(files, (card?.dataset.mode as Mode | undefined) ?? 'auto')
  })

  window.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f)
    if (files.length) void loadFiles(files, 'auto')
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
    const layoutBtn = target.closest<HTMLElement>('[data-layout]')
    if (layoutBtn) {
      updateStack((s) => (s.stack.layout = layoutBtn.dataset.layout as StackLayout))
      return
    }
    const matchBtn = target.closest<HTMLElement>('[data-match]')
    if (matchBtn) {
      updateStack((s) => (s.stack.match = matchBtn.dataset.match as StackMatch))
      return
    }
    const stackAlignBtn = target.closest<HTMLElement>('[data-stack-align]')
    if (stackAlignBtn) {
      updateStack((s) => (s.stack.align = stackAlignBtn.dataset.stackAlign as StackAlign))
      return
    }
    const moveBtn = target.closest<HTMLElement>('[data-move]')
    if (moveBtn) {
      moveImage(Number(moveBtn.dataset.key), Number(moveBtn.dataset.move))
      return
    }
    const removeBtn = target.closest<HTMLElement>('[data-remove]')
    if (removeBtn) {
      dropImage(Number(removeBtn.dataset.key))
      return
    }
    if (target.closest('#addImagesBtn')) {
      pickStack()
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
    else if (target.id === 'columnsInput') {
      const columns = coerceDimension(target.value, 1)
      updateStack((s) => (s.stack.columns = Math.min(columns, Math.max(1, s.images.length))))
    } else if (target.id === 'gapRange') {
      const gap = Math.min(STACK_GAP_RANGE.max, Math.max(STACK_GAP_RANGE.min, Math.round(Number(target.value)) || 0))
      updateStack((s) => (s.stack.gap = gap))
    } else if (target.id === 'stackColorInput') {
      updateStack((s) => (s.stack.background = target.value))
    }
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
