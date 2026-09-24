// Renders the contextual option-panel markup for the active tool. Pure string
// templates; app.ts owns wiring events (via delegation, so re-rendering is cheap).
import { icons } from './icons'
import type { AppState } from './state'

const RATIO_LABELS: Record<string, string> = {
  '1:1': '1:1',
  '16:9': '16:9',
  '4:3': '4:3',
  '3:2': '3:2',
  custom: 'Custom',
}

function chip(pressed: boolean, attr: string, value: string, label: string): string {
  return `<button type="button" class="chip" data-${attr}="${value}" aria-pressed="${pressed}">${label}</button>`
}

function ratioPanel(state: AppState): string {
  const chips = Object.entries(RATIO_LABELS)
    .map(([value, label]) => chip(state.preset === value, 'ratio', value, label))
    .join('')
  return `
    <div class="option-row">
      <span class="option-label">Ratio</span>
      <div class="chip-group" role="group" aria-label="Aspect ratio">${chips}</div>
    </div>
  `
}

function sizePanel(state: AppState): string {
  const { width, height } = state.options
  return `
    <div class="option-row">
      <div class="field">
        <label for="widthInput">Width</label>
        <input type="number" id="widthInput" inputmode="numeric" min="1" value="${width}">
      </div>
      <span class="dim-separator" aria-hidden="true">&times;</span>
      <div class="field">
        <label for="heightInput">Height</label>
        <input type="number" id="heightInput" inputmode="numeric" min="1" value="${height}">
      </div>
      <button type="button" class="icon-btn-flat" id="swapBtn" aria-label="Swap width and height" title="Swap width and height">${icons.swap}</button>
    </div>
  `
}

const ALIGN_Y_LABELS: Record<string, string> = { top: 'Top', center: 'Middle', bottom: 'Bottom' }

function positionPanel(state: AppState): string {
  const aligns = (['left', 'center', 'right'] as const)
    .map((a) => chip(state.options.align === a, 'align', a, a[0].toUpperCase() + a.slice(1)))
    .join('')
  const alignsY = (['top', 'center', 'bottom'] as const)
    .map((a) => chip(state.options.alignY === a, 'align-y', a, ALIGN_Y_LABELS[a]))
    .join('')
  const { offsetX, offsetY } = state.options
  return `
    <div class="option-row position-row">
      <div class="align-groups">
        <div class="chip-group" role="group" aria-label="Horizontal alignment">${aligns}</div>
        <div class="chip-group" role="group" aria-label="Vertical alignment">${alignsY}</div>
      </div>
      <div class="dpad" role="group" aria-label="Nudge position">
        <button type="button" data-dir="up" aria-label="Nudge up">${icons.up}</button>
        <button type="button" data-dir="left" aria-label="Nudge left">${icons.left}</button>
        <button type="button" data-dir="right" aria-label="Nudge right">${icons.right}</button>
        <button type="button" data-dir="down" aria-label="Nudge down">${icons.down}</button>
      </div>
      <span class="nudge-readout" id="nudgeReadout">${offsetX}, ${offsetY}</span>
    </div>
  `
}

function backgroundPanel(state: AppState): string {
  const { background } = state.options
  const isBlur = background.mode === 'blur'
  const color = background.mode === 'color' ? background.color : state.color
  const sigma = background.mode === 'blur' ? background.sigma : state.sigma
  return `
    <div class="option-row">
      <div class="chip-group" role="group" aria-label="Background type">
        ${chip(!isBlur, 'bg', 'color', 'Color')}
        ${chip(isBlur, 'bg', 'blur', 'Blur')}
      </div>
      <input type="color" class="color-swatch-input" id="bgColorInput" aria-label="Background color" value="${color}">
    </div>
    <div class="option-row" id="blurRow" ${isBlur ? '' : 'hidden'}>
      <span class="option-label">Blur</span>
      <div class="range-row">
        <input type="range" id="blurRange" min="1" max="20" step="1" value="${sigma}" aria-label="Blur intensity">
        <span class="range-value" id="blurValue">${sigma}</span>
      </div>
    </div>
  `
}

function escapeAttr(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function imagesPanel(state: AppState): string {
  const last = state.images.length - 1
  const thumbs = state.images
    .map(
      (img, i) => `
      <div class="thumb" data-key="${img.key}">
        <img src="${img.thumb}" alt="${escapeAttr(img.name)}" draggable="false">
        <span class="thumb-index">${i + 1}</span>
        <div class="thumb-actions">
          <button type="button" data-move="-1" data-key="${img.key}" aria-label="Move ${escapeAttr(img.name)} earlier" ${i === 0 ? 'disabled' : ''}>${icons.left}</button>
          <button type="button" data-remove data-key="${img.key}" aria-label="Remove ${escapeAttr(img.name)}">${icons.close}</button>
          <button type="button" data-move="1" data-key="${img.key}" aria-label="Move ${escapeAttr(img.name)} later" ${i === last ? 'disabled' : ''}>${icons.right}</button>
        </div>
      </div>`,
    )
    .join('')
  return `
    <div class="thumb-strip" role="list" aria-label="Stacked images">
      ${thumbs}
      <button type="button" class="thumb thumb-add" id="addImagesBtn" aria-label="Add images">${icons.plus}<span>Add</span></button>
    </div>
  `
}

const LAYOUT_CHIPS = [
  ['horizontal', 'Row', icons.row],
  ['vertical', 'Column', icons.column],
  ['grid', 'Grid', icons.layout],
] as const

function layoutPanel(state: AppState): string {
  const { stack } = state
  const chips = LAYOUT_CHIPS.map(
    ([value, label, icon]) =>
      `<button type="button" class="chip" data-layout="${value}" aria-pressed="${stack.layout === value}">${icon}${label}</button>`,
  ).join('')
  return `
    <div class="option-row">
      <div class="chip-group" role="group" aria-label="Stack layout">${chips}</div>
      <div class="field field-inline" id="columnsRow" ${stack.layout === 'grid' ? '' : 'hidden'}>
        <label for="columnsInput">Columns</label>
        <input type="number" id="columnsInput" inputmode="numeric" min="1" max="${Math.max(1, state.images.length)}" value="${stack.columns}">
      </div>
    </div>
    <div class="option-row">
      <span class="option-label">Gap</span>
      <div class="range-row">
        <input type="range" id="gapRange" min="0" max="200" step="1" value="${stack.gap}" aria-label="Gap between images">
        <span class="range-value" id="gapValue">${stack.gap}</span>
      </div>
      <input type="color" class="color-swatch-input" id="stackColorInput" aria-label="Gap color" value="${stack.background}">
    </div>
  `
}

const MATCH_LABELS: Record<string, string> = { none: 'Off', smallest: 'Smallest', largest: 'Largest', first: 'First' }

/** Alignment chips read in the axis they act on: rows align vertically, columns horizontally. */
function alignLabels(state: AppState): Record<string, string> {
  return state.stack.layout === 'vertical'
    ? { start: 'Left', center: 'Center', end: 'Right' }
    : { start: 'Top', center: 'Middle', end: 'Bottom' }
}

function sizingPanel(state: AppState): string {
  const { stack } = state
  const matches = Object.entries(MATCH_LABELS)
    .map(([value, label]) => chip(stack.match === value, 'match', value, label))
    .join('')
  const labels = alignLabels(state)
  const aligns = (['start', 'center', 'end'] as const)
    .map((a) => chip(stack.align === a, 'stack-align', a, labels[a]!))
    .join('')
  const matchWhat = stack.layout === 'vertical' ? 'widths' : 'heights'
  return `
    <div class="option-row">
      <span class="option-label">Match ${matchWhat}</span>
      <div class="chip-group" role="group" aria-label="Match ${matchWhat}">${matches}</div>
    </div>
    <div class="option-row">
      <span class="option-label">Align</span>
      <div class="chip-group" role="group" aria-label="Align images">${aligns}</div>
    </div>
  `
}

export function renderPanel(state: AppState): string {
  if (!state.source) return ''
  switch (state.tool) {
    case 'images':
      return imagesPanel(state)
    case 'layout':
      return layoutPanel(state)
    case 'sizing':
      return sizingPanel(state)
    case 'ratio':
      return ratioPanel(state)
    case 'size':
      return sizePanel(state)
    case 'position':
      return positionPanel(state)
    case 'background':
      return backgroundPanel(state)
    default:
      return ''
  }
}
