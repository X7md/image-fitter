// Single reactive state object for the whole UI. Mutations go through `store.update()`;
// every subscribed render() runs synchronously afterwards so the DOM is always in sync
// with the state by the time an event handler returns (tests rely on that).
import type { AspectPreset, Bitmap, FitOptions, StackOptions } from '../engine/types'
import { BLUR_RANGE, DEFAULT_OPTIONS, DEFAULT_STACK, FALLBACK_SIZE } from '../engine/types'

/** Fit: one image onto a canvas. Stack: several images joined, then fitted. */
export type Mode = 'fit' | 'stack'

export type Tool = 'images' | 'layout' | 'sizing' | 'ratio' | 'size' | 'position' | 'background'

export const FIT_TOOLS: readonly Tool[] = ['ratio', 'size', 'position', 'background']
export const STACK_TOOLS: readonly Tool[] = ['images', 'layout', 'sizing', ...FIT_TOOLS]
export const TOOLS: readonly Tool[] = STACK_TOOLS

export function toolsFor(mode: Mode | null): readonly Tool[] {
  return mode === 'stack' ? STACK_TOOLS : FIT_TOOLS
}

/** The UI is only started once the wasm engine is ready, so this is 'ready' from the
 *  first render and only flips to 'failed' if the engine worker dies later. */
export type EngineStatus = 'ready' | 'failed'

export interface LoadedImage {
  /** Engine key (see EngineClient.addImage); never reused. */
  key: number
  /** Intrinsic size (the pixels themselves live in the engine worker). */
  width: number
  height: number
  /** File name (or a synthetic one for bitmaps loaded through the debug hook). */
  name: string
  /** Small data: URL for the Images panel. */
  thumb: string
}

/** What the fit tools work on: the single image, or the stacked result. */
export interface SourceImage {
  width: number
  height: number
  name: string
}

export interface AppState {
  /** null = intro screen. */
  mode: Mode | null
  /** In order. Exactly one in fit mode. */
  images: LoadedImage[]
  stack: StackOptions
  source: SourceImage | null
  /** The fit target tracks the source size (or the ratio preset of it) until the user
   *  types a size, so restacking keeps the output matching the stack. */
  sizeFollowsSource: boolean
  preset: AspectPreset
  options: FitOptions
  /** Last chosen colour — survives switching to Blur and back. */
  color: string
  /** Last chosen blur sigma — survives switching to Color and back. */
  sigma: number
  tool: Tool
  /** Latest preview frame rendered by the engine (capped size), shown on the stage. */
  preview: Bitmap | null
  /** A preview render is in flight or queued. */
  rendering: boolean
  /** Save in progress. */
  busy: boolean
  engine: EngineStatus
  /** A file is being dragged over the stage. */
  dragging: boolean
  /** Transient status message (error or info); auto-dismissed by the UI layer. */
  toast: { text: string; kind: 'error' | 'info' } | null
}

export function initialOptions(
  width = FALLBACK_SIZE.width,
  height = FALLBACK_SIZE.height,
): FitOptions {
  return {
    width,
    height,
    align: DEFAULT_OPTIONS.align,
    alignY: DEFAULT_OPTIONS.alignY,
    offsetX: DEFAULT_OPTIONS.offsetX,
    offsetY: DEFAULT_OPTIONS.offsetY,
    background: { ...DEFAULT_OPTIONS.background },
  }
}

const DEFAULT_COLOR = DEFAULT_OPTIONS.background.mode === 'color' ? DEFAULT_OPTIONS.background.color : '#ffffff'

export function createInitialState(): AppState {
  return {
    mode: null,
    images: [],
    stack: { ...DEFAULT_STACK },
    source: null,
    sizeFollowsSource: true,
    preset: 'custom',
    options: initialOptions(),
    color: DEFAULT_COLOR,
    sigma: BLUR_RANGE.default,
    tool: 'ratio',
    preview: null,
    rendering: false,
    busy: false,
    engine: 'ready',
    dragging: false,
    toast: null,
  }
}

export type Listener = (state: AppState) => void

export interface Store {
  readonly state: AppState
  /** Mutate the state in place, then notify every subscriber synchronously. */
  update(mutate: (state: AppState) => void): void
  /** Subscribe a render function; it is called once immediately. */
  subscribe(listener: Listener): () => void
  /** Re-run every subscriber without mutating (e.g. after a resize). */
  notify(): void
}

export function createStore(state: AppState = createInitialState()): Store {
  const listeners = new Set<Listener>()
  let depth = 0
  const notify = () => {
    if (depth > 0) return
    for (const l of listeners) l(state)
  }
  return {
    state,
    update(mutate) {
      depth++
      try {
        mutate(state)
      } finally {
        depth--
      }
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => {
        listeners.delete(listener)
      }
    },
    notify,
  }
}
