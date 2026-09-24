/**
 * End-to-end browser test (ARCHITECTURE.md §6).
 *
 * Builds `dist/` if needed, serves it over HTTP (with `application/wasm` for the module),
 * opens it in the *system* Chrome through puppeteer-core, and drives the real UI with
 * real clicks/keystrokes. After every interaction it runs the wasm fit through
 * `window.__imageFitter.render()` and asserts the output dimensions and actual pixels:
 * the four quadrant colours inside the placement rectangle and the background colour
 * outside it. It also uploads a real BMP through the file input, compares the wasm
 * result against the engine's preview frame on a sampling grid, and checks that Save writes
 * a real PNG.
 *
 * Run with: npm run test:browser
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'
import type { Browser, ElementHandle, Page } from 'puppeteer-core'

import { computePlacement, planStack } from '../../src/engine/types'
import type { Align, AlignY, Bitmap, FitOptions, StackOptions } from '../../src/engine/types'
import { OUT_DIR, REPO_ROOT, makeFitter, quadrantBitmap } from '../node/helpers'

const DIST = join(REPO_ROOT, 'dist')
const DOWNLOADS = join(OUT_DIR, 'downloads')
const CHROME =
  process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const SRC_W = 640
const SRC_H = 480

/** Solid-region tolerance: Q8 + two different resamplers (Lanczos vs the canvas). */
const PIXEL_TOL = 3
/** Preview-vs-wasm tolerance on the sampling grid (different resamplers entirely). */
const PREVIEW_TOL = 26

type RGBA = [number, number, number, number]

const RED: RGBA = [255, 0, 0, 255]
const GREEN: RGBA = [0, 255, 0, 255]
const BLUE: RGBA = [0, 0, 255, 255]
const YELLOW: RGBA = [255, 255, 0, 255]
const WHITE: RGBA = [255, 255, 255, 255]

// ---------------------------------------------------------------- reporting

let checks = 0
let failures = 0
const failureLog: string[] = []

function check(ok: boolean, message: string): boolean {
  checks++
  if (!ok) {
    failures++
    failureLog.push(message)
    console.error(`  FAIL  ${message}`)
  }
  return ok
}

function step(name: string): void {
  console.log(`\n== ${name}`)
}

function maxDiff(a: RGBA, b: RGBA): number {
  let worst = 0
  for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
  return worst
}

function checkPixel(got: RGBA, want: RGBA, tol: number, message: string): void {
  const d = maxDiff(got, want)
  check(d <= tol, `${message}: got rgba(${got.join(',')}), want rgba(${want.join(',')}) (diff ${d} > ${tol})`)
}

// ---------------------------------------------------------------- static server

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
}

function startServer(root: string): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]!
    const rel = normalize(decodeURIComponent(url)).replace(/^([/\\])+/, '')
    // Refuse anything that escapes the served root.
    if (rel.split(/[/\\]/).includes('..')) {
      res.writeHead(403).end('forbidden')
      return
    }
    const file = rel === '' ? join(root, 'index.html') : join(root, rel)
    if (!file.startsWith(root + sep) && file !== join(root, 'index.html')) {
      res.writeHead(403).end('forbidden')
      return
    }
    readFile(file)
      .then((body) => {
        res.writeHead(200, {
          'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'content-length': body.byteLength,
          'cache-control': 'no-store',
        })
        res.end(body)
      })
      .catch(() => {
        res.writeHead(404).end('not found')
      })
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('server did not bind a port'))
        return
      }
      resolve({ server, port: addr.port })
    })
  })
}

// ---------------------------------------------------------------- page helpers

/** The subset of `window.__imageFitter` the tests use, as seen from inside the page. */
interface PageHook {
  state: {
    mode: 'fit' | 'stack' | null
    images: Array<{ key: number; width: number; height: number; name: string }>
    stack: StackOptions
    source: { width: number; height: number; name: string } | null
    preset: string
    options: FitOptions
    tool: string
    busy: boolean
    engine: string
    toast: { text: string; kind: string } | null
  }
  lastResult?: Bitmap
  engineVersion: string
  loadBitmap(bitmap: Bitmap): void
  loadBitmaps(bitmaps: Bitmap[]): void
  render(): Promise<Bitmap>
  whenIdle(): Promise<void>
}

/** Waits until the engine has painted the preview frame for the current options. */
async function waitForPreview(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const hook = (window as unknown as { __imageFitter?: PageHook }).__imageFitter
    if (!hook) throw new Error('window.__imageFitter is missing')
    await hook.whenIdle()
  })
}

async function readState(page: Page): Promise<PageHook['state']> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __imageFitter?: PageHook }).__imageFitter
    if (!hook) throw new Error('window.__imageFitter is missing')
    return JSON.parse(JSON.stringify(hook.state)) as PageHook['state']
  })
}

/** Runs the wasm fit in the page and samples the requested points out of the result. */
async function renderAndProbe(
  page: Page,
  probes: Array<[number, number]>,
): Promise<{ width: number; height: number; pixels: RGBA[]; ms: number }> {
  return page.evaluate(async (pts: Array<[number, number]>) => {
    const h = (window as unknown as { __imageFitter?: PageHook }).__imageFitter
    if (!h) throw new Error('window.__imageFitter is missing')
    const t0 = performance.now()
    const out = await h.render()
    const ms = performance.now() - t0
    const pixels = pts.map(([x, y]) => {
      const i = (y * out.width + x) * 4
      return [out.data[i]!, out.data[i + 1]!, out.data[i + 2]!, out.data[i + 3]!] as RGBA
    })
    return { width: out.width, height: out.height, pixels, ms }
  }, probes)
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Quadrant-centre probe points (skipping any that fall off the canvas). */
function quadrantProbes(rect: Rect, W: number, H: number): Array<{ point: [number, number]; want: RGBA; name: string }> {
  const qw = rect.width / 2
  const qh = rect.height / 2
  const spec: Array<[string, number, number, RGBA]> = [
    ['top-left/red', rect.x + qw * 0.5, rect.y + qh * 0.5, RED],
    ['top-right/green', rect.x + qw * 1.5, rect.y + qh * 0.5, GREEN],
    ['bottom-left/blue', rect.x + qw * 0.5, rect.y + qh * 1.5, BLUE],
    ['bottom-right/yellow', rect.x + qw * 1.5, rect.y + qh * 1.5, YELLOW],
  ]
  const out: Array<{ point: [number, number]; want: RGBA; name: string }> = []
  for (const [name, fx, fy, want] of spec) {
    const x = Math.round(fx)
    const y = Math.round(fy)
    if (x < 0 || y < 0 || x >= W || y >= H) continue
    out.push({ point: [x, y], want, name })
  }
  return out
}

/** Canvas corners that lie outside the placement rectangle (i.e. pure background). */
function backgroundProbes(rect: Rect, W: number, H: number): Array<{ point: [number, number]; name: string }> {
  const candidates: Array<[string, number, number]> = [
    ['top-left corner', 2, 2],
    ['top-right corner', W - 3, 2],
    ['bottom-left corner', 2, H - 3],
    ['bottom-right corner', W - 3, H - 3],
  ]
  const out: Array<{ point: [number, number]; name: string }> = []
  for (const [name, x, y] of candidates) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue
    const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
    if (!inside) out.push({ point: [x, y], name })
  }
  return out
}

function hexToRGBA(hex: string): RGBA {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255]
}

/**
 * The core assertion: read the live state, compute the placement with the very same pure
 * function the engine uses, render through wasm and verify the pixels that follow from it.
 */
async function assertFit(page: Page, label: string): Promise<{ ms: number; state: PageHook['state'] }> {
  const state = await readState(page)
  if (!state.source) throw new Error(`${label}: no source loaded`)
  const W = Math.round(state.options.width)
  const H = Math.round(state.options.height)
  const rect = computePlacement(state.source.width, state.source.height, state.options)

  const quads = quadrantProbes(rect, W, H)
  const bgs = state.options.background.mode === 'color' ? backgroundProbes(rect, W, H) : []
  const probes = [...quads.map((q) => q.point), ...bgs.map((b) => b.point)]

  const result = await renderAndProbe(page, probes)
  check(result.width === W && result.height === H, `${label}: output is ${result.width}x${result.height}, want ${W}x${H}`)

  quads.forEach((q, i) => {
    checkPixel(result.pixels[i]!, q.want, PIXEL_TOL, `${label}: ${q.name} at (${q.point.join(',')})`)
  })
  if (state.options.background.mode === 'color') {
    const want = hexToRGBA(state.options.background.color)
    bgs.forEach((b, i) => {
      checkPixel(result.pixels[quads.length + i]!, want, PIXEL_TOL, `${label}: background ${b.name} at (${b.point.join(',')})`)
    })
  }
  console.log(
    `  ok    ${label}: ${W}x${H} rect=${rect.width}x${rect.height}@${rect.x},${rect.y} ` +
      `(${quads.length} quadrant + ${bgs.length} background probes) wasm fit ${result.ms.toFixed(0)} ms`,
  )
  return { ms: result.ms, state }
}

// ---------------------------------------------------------------- interactions

async function clickTool(page: Page, tool: string): Promise<void> {
  await page.click(`#toolTab-${tool}`)
  const active = await page.$eval(`#toolTab-${tool}`, (el) => el.getAttribute('aria-pressed'))
  check(active === 'true', `tool tab ${tool} is aria-pressed after the click`)
}

/** Sets an <input>'s value the way a user's edit looks to the app: value + input event. */
async function setInputValue(page: Page, selector: string, value: string): Promise<void> {
  await page.$eval(
    selector,
    (el, v) => {
      const input = el as HTMLInputElement
      input.value = v
      input.dispatchEvent(new Event('input', { bubbles: true }))
    },
    value,
  )
}

/**
 * Contain-fit means only ONE axis ever has slack: a target wider than the source's 4:3
 * leaves horizontal bands, a taller one leaves vertical bands. Tests that want to see
 * background around the image therefore have to pick the target shape deliberately.
 */
async function setSize(page: Page, width: number, height: number): Promise<void> {
  await clickTool(page, 'size')
  await typeIntoNumberInput(page, '#widthInput', String(width))
  await typeIntoNumberInput(page, '#heightInput', String(height))
}

async function typeIntoNumberInput(page: Page, selector: string, value: string): Promise<void> {
  await page.click(selector, { count: 3 })
  await page.keyboard.press('Backspace')
  await page.type(selector, value)
  // Blur so the store's value is not shadowed by the focused-input guard in render().
  await page.$eval(selector, (el) => (el as HTMLInputElement).blur())
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })
  await rm(DOWNLOADS, { recursive: true, force: true })
  await mkdir(DOWNLOADS, { recursive: true })

  // 1. dist ------------------------------------------------------------------
  step('build')
  if (!existsSync(join(DIST, 'index.html'))) {
    console.log('  dist/ missing, running vite build')
    const built = spawnSync('npx', ['vite', 'build'], { cwd: REPO_ROOT, stdio: 'inherit', shell: true })
    if (built.status !== 0) throw new Error('vite build failed')
  }
  const distFiles = await readdir(join(DIST, 'assets'))
  const wasmAsset = distFiles.find((f) => f.endsWith('.wasm'))
  check(!!wasmAsset, `dist/assets contains a .wasm asset (got ${distFiles.join(', ')})`)

  // 2. a real BMP to upload through the file input ----------------------------
  step('fixture')
  const { fitter } = await makeFitter()
  const srcBitmap: Bitmap = quadrantBitmap(SRC_W, SRC_H)
  const bmpPath = join(OUT_DIR, 'browser-upload-source.bmp')
  await writeFile(bmpPath, fitter.encode(srcBitmap, 'BMP'))
  fitter.dispose()
  console.log(`  ok    wrote ${bmpPath} (${SRC_W}x${SRC_H} quadrant BMP, encoded by the wasm engine)`)

  const { server, port } = await startServer(DIST)
  const base = `http://127.0.0.1:${port}/`
  console.log(`  ok    serving dist/ at ${base}`)

  let browser: Browser | undefined
  try {
    if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_PATH)`)
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-device-scale-factor=1'],
      defaultViewport: { width: 1280, height: 860 },
    })
    const page = await browser.newPage()

    // Any console error or uncaught exception fails the run.
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`)
    })
    page.on('pageerror', (err: unknown) => consoleErrors.push(`pageerror: ${err instanceof Error ? err.message : String(err)}`))
    page.on('requestfailed', (req) => {
      consoleErrors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText ?? ''}`)
    })

    const cdp = await page.createCDPSession()
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS })

    // 3. boot ------------------------------------------------------------------
    step('boot')
    await page.goto(base, { waitUntil: 'load' })
    await page.waitForFunction(() => '__imageFitter' in window, { timeout: 20_000 })
    check(true, 'window.__imageFitter installed')

    const engineT0 = Date.now()
    await page.waitForFunction(
      () => {
        const h = (window as unknown as { __imageFitter?: PageHook }).__imageFitter
        return !!h && h.state.engine !== 'loading'
      },
      { timeout: 60_000 },
    )
    const engineMs = Date.now() - engineT0
    const booted = await readState(page)
    check(booted.engine === 'ready', `wasm engine status is 'ready' (got '${booted.engine}')`)
    console.log(`  ok    engine ready after ${engineMs} ms`)
    const bootUi = await page.evaluate(() => ({
      bootHidden: (document.getElementById('boot') as HTMLElement).hidden,
      shellHidden: (document.getElementById('appShell') as HTMLElement).hidden,
      version: (window as unknown as { __imageFitter?: PageHook }).__imageFitter?.engineVersion ?? '',
    }))
    check(bootUi.bootHidden && !bootUi.shellHidden, 'boot screen is hidden and the editor shell is shown once the engine is ready')
    check(bootUi.version.length > 0, `engine version reported by the worker (${bootUi.version})`)

    const intro = await page.evaluate(() => ({
      visible: !(document.getElementById('intro') as HTMLElement).hidden,
      cards: [...document.querySelectorAll('.intro-card')].map((c) => (c as HTMLElement).dataset.mode),
      stripHidden: (document.getElementById('toolStrip') as HTMLElement).hidden,
    }))
    check(intro.visible && intro.cards.join(',') === 'fit,stack', `intro shows the Fit and Stack cards (got ${intro.cards.join(',')})`)
    check(intro.stripHidden, 'the tool strip is hidden on the intro')
    check(await page.$eval('#saveBtn', (el) => (el as HTMLButtonElement).disabled), 'Save is disabled with no image')
    await page.screenshot({ path: join(OUT_DIR, 'browser-empty.png') })

    // 4. synthetic bitmap through the debug hook -------------------------------
    step('loadBitmap (synthetic 640x480 quadrants)')
    await page.evaluate(
      (w: number, h: number) => {
        const data = new Uint8ClampedArray(w * h * 4)
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const top = y < h / 2
            const left = x < w / 2
            const c = top ? (left ? [255, 0, 0] : [0, 255, 0]) : left ? [0, 0, 255] : [255, 255, 0]
            const i = (y * w + x) * 4
            data[i] = c[0]!
            data[i + 1] = c[1]!
            data[i + 2] = c[2]!
            data[i + 3] = 255
          }
        }
        const h2 = (window as unknown as { __imageFitter?: PageHook }).__imageFitter
        if (!h2) throw new Error('no hook')
        h2.loadBitmap({ width: w, height: h, data })
      },
      SRC_W,
      SRC_H,
    )
    const loaded = await readState(page)
    check(loaded.source?.width === SRC_W && loaded.source?.height === SRC_H, 'source dims recorded')
    check(loaded.options.width === SRC_W && loaded.options.height === SRC_H, 'target size starts at the source size')
    check(loaded.preset === 'custom', "preset starts as 'custom'")
    check(loaded.options.alignY === 'center', "alignY defaults to 'center'")
    check(!(await page.$eval('#saveBtn', (el) => (el as HTMLButtonElement).disabled)), 'Save is enabled once loaded')
    const badge = await page.$eval('#sizeBadge', (el) => el.textContent ?? '')
    check(badge.includes(`${SRC_W}`) && badge.includes(`${SRC_H}`), `size badge reads the target size (got "${badge}")`)
    await assertFit(page, 'initial 1:1 pass-through')

    // 5. Ratio chips ------------------------------------------------------------
    step('Ratio tool')
    await clickTool(page, 'ratio')
    for (const ratio of ['1:1', '16:9', '4:3', '3:2', 'custom'] as const) {
      await page.click(`[data-ratio="${ratio}"]`)
      const s = await readState(page)
      check(s.preset === ratio, `preset is ${ratio} after clicking its chip`)
      const pressed = await page.$eval(`[data-ratio="${ratio}"]`, (el) => el.getAttribute('aria-pressed'))
      check(pressed === 'true', `${ratio} chip is aria-pressed`)
      await assertFit(page, `ratio ${ratio}`)
    }

    // 6. Size tool --------------------------------------------------------------
    step('Size tool')
    await clickTool(page, 'size')
    await typeIntoNumberInput(page, '#widthInput', '900')
    await typeIntoNumberInput(page, '#heightInput', '500')
    let s = await readState(page)
    check(s.options.width === 900 && s.options.height === 500, `size inputs set 900x500 (got ${s.options.width}x${s.options.height})`)
    check(s.preset === 'custom', "editing a dimension switches the preset to 'custom'")
    await assertFit(page, 'size 900x500')

    await page.click('#swapBtn')
    s = await readState(page)
    check(s.options.width === 500 && s.options.height === 900, `swap gives 500x900 (got ${s.options.width}x${s.options.height})`)
    await assertFit(page, 'size swapped 500x900')

    // An emptied input falls back to 800/600.
    await setInputValue(page, '#widthInput', '')
    s = await readState(page)
    check(s.options.width === 800, `empty width falls back to 800 (got ${s.options.width})`)
    await typeIntoNumberInput(page, '#widthInput', '900')
    await typeIntoNumberInput(page, '#heightInput', '500')

    // 7. Position tool: horizontal, vertical (§8), D-pad, keyboard --------------
    // A 900x500 target is wider than the 4:3 source, so the slack is horizontal.
    step('Position tool — horizontal (wide 900x500 target)')
    await setSize(page, 900, 500)
    await clickTool(page, 'position')
    for (const align of ['left', 'right', 'center'] as Align[]) {
      await page.click(`[data-align="${align}"]`)
      s = await readState(page)
      check(s.options.align === align, `align is ${align}`)
      check(s.options.offsetX === 0, `choosing align=${align} resets offsetX`)
      await assertFit(page, `align ${align}`)
    }

    // A 600x900 target is taller than the source, so now the slack is vertical and the
    // Top/Middle/Bottom chips actually have somewhere to move the image.
    step('Position tool — vertical §8 (tall 600x900 target)')
    await setSize(page, 600, 900)
    await clickTool(page, 'position')
    for (const alignY of ['top', 'bottom', 'center'] as AlignY[]) {
      await page.click(`[data-align-y="${alignY}"]`)
      s = await readState(page)
      check(s.options.alignY === alignY, `alignY is ${alignY}`)
      check(s.options.offsetY === 0, `choosing alignY=${alignY} resets offsetY`)
      const pressed = await page.$eval(`[data-align-y="${alignY}"]`, (el) => el.getAttribute('aria-pressed'))
      check(pressed === 'true', `${alignY} chip is aria-pressed`)
      await assertFit(page, `alignY ${alignY}`)
    }

    // top / bottom really push the image against the canvas edge.
    await page.click('[data-align-y="top"]')
    s = await readState(page)
    let rect = computePlacement(SRC_W, SRC_H, s.options)
    check(rect.height < s.options.height, 'the tall target really leaves vertical slack to align in')
    check(rect.y === 0, `alignY=top puts the rect at y=0 (got ${rect.y})`)
    let probe = await renderAndProbe(page, [
      [Math.round(rect.x + rect.width * 0.25), 1],
      [Math.round(rect.x + rect.width * 0.25), s.options.height - 2],
    ])
    checkPixel(probe.pixels[0]!, RED, PIXEL_TOL, 'alignY=top: source touches the first row')
    checkPixel(probe.pixels[1]!, WHITE, PIXEL_TOL, 'alignY=top: background at the bottom')

    await page.click('[data-align-y="bottom"]')
    s = await readState(page)
    rect = computePlacement(SRC_W, SRC_H, s.options)
    check(rect.y === s.options.height - rect.height, `alignY=bottom puts the rect at the bottom edge (y=${rect.y})`)
    probe = await renderAndProbe(page, [
      [Math.round(rect.x + rect.width * 0.25), s.options.height - 2],
      [Math.round(rect.x + rect.width * 0.25), 1],
    ])
    checkPixel(probe.pixels[0]!, BLUE, PIXEL_TOL, 'alignY=bottom: source touches the last row')
    checkPixel(probe.pixels[1]!, WHITE, PIXEL_TOL, 'alignY=bottom: background at the top')
    await page.click('[data-align-y="center"]')

    // D-pad single clicks.
    await page.click('[data-align="center"]')
    for (let i = 0; i < 3; i++) await page.click('[data-dir="right"]')
    for (let i = 0; i < 2; i++) await page.click('[data-dir="down"]')
    s = await readState(page)
    check(s.options.offsetX === 3 && s.options.offsetY === 2, `D-pad clicks nudge to 3,2 (got ${s.options.offsetX},${s.options.offsetY})`)
    const readout = await page.$eval('#nudgeReadout', (el) => el.textContent ?? '')
    check(readout.trim() === '3, 2', `nudge readout reads "3, 2" (got "${readout.trim()}")`)
    await assertFit(page, 'nudged by 3,2')

    // Hold-to-repeat: 500 ms delay then every 50 ms.
    const leftBtn = await page.$('[data-dir="left"]')
    if (leftBtn) {
      const box = await leftBtn.boundingBox()
      if (box) {
        const before = (await readState(page)).options.offsetX
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.down()
        await sleep(800)
        await page.mouse.up()
        const after = (await readState(page)).options.offsetX
        check(after <= before - 3, `hold-to-repeat fired several nudges (offsetX ${before} -> ${after})`)
      }
    }

    // Keyboard nudge (Position tool active).
    await page.$eval('#stage', (el) => (el as HTMLElement).focus())
    const beforeKeys = (await readState(page)).options.offsetY
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    const afterKeys = (await readState(page)).options.offsetY
    check(afterKeys === beforeKeys - 2, `ArrowUp nudges up twice (offsetY ${beforeKeys} -> ${afterKeys})`)

    // 8. Background tool ---------------------------------------------------------
    step('Background tool')
    await clickTool(page, 'background')
    await page.click('[data-bg="color"]')
    await setInputValue(page, '#bgColorInput', '#204080')
    s = await readState(page)
    check(
      s.options.background.mode === 'color' && s.options.background.color === '#204080',
      `background colour is #204080 (got ${JSON.stringify(s.options.background)})`,
    )
    await assertFit(page, 'background #204080')

    // Blur: the background band must be a smooth mix, never a flat colour.
    // Back to a wide target and right alignment so a wide blurred band is visible on the
    // left; the align chips live in the Position panel, so switch tools to reach them.
    await setSize(page, 900, 500)
    await clickTool(page, 'position')
    await page.click('[data-align="right"]')
    await clickTool(page, 'background')
    await page.click('[data-bg="blur"]')
    await setInputValue(page, '#blurRange', '14')
    s = await readState(page)
    check(s.options.background.mode === 'blur', 'background mode is blur')
    check(s.options.background.mode === 'blur' && s.options.background.sigma === 14, 'blur sigma is 14')
    const blurValue = await page.$eval('#blurValue', (el) => el.textContent ?? '')
    check(blurValue.trim() === '14', `blur readout reads 14 (got "${blurValue.trim()}")`)
    check(!(await page.$eval('#blurRow', (el) => (el as HTMLElement).hidden)), 'the blur row is visible in blur mode')

    s = await readState(page)
    rect = computePlacement(SRC_W, SRC_H, s.options)
    check(rect.x > 40, `the right-aligned rect leaves a blurred band on the left (rect.x=${rect.x})`)
    const bandX = Math.max(0, Math.round(rect.x / 2))
    const blurT0 = Date.now()
    const blurProbe = await renderAndProbe(page, [
      [bandX, 5],
      [bandX, Math.round(s.options.height / 2)],
      [Math.max(0, rect.x - 3), Math.round(s.options.height / 2)],
    ])
    const blurMs = Date.now() - blurT0
    check(blurProbe.width === Math.round(s.options.width), 'blur render has the target width')
    const flat = blurProbe.pixels.every((p) => maxDiff(p, blurProbe.pixels[0]!) === 0)
    check(!flat, 'the blurred background varies across the canvas (not a flat fill)')
    const anyWhite = blurProbe.pixels.some((p) => maxDiff(p, WHITE) <= 2)
    check(!anyWhite, 'the blurred background is not the white colour background')
    console.log(`  ok    blur-background fit took ${blurMs} ms at ${blurProbe.width}x${blurProbe.height}`)

    // The on-screen preview must show the blur too (it is rendered by the engine, not by
    // ctx.filter, which iOS Safari ignores). Sample the band left of the image on the
    // preview canvas itself.
    await waitForPreview(page)
    const previewBand = await page.evaluate(
      (fx: number, targetW: number, targetH: number) => {
        const canvas = document.getElementById('previewCanvas') as HTMLCanvasElement
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('no 2d context')
        const px = Math.round((fx * canvas.width) / targetW)
        const ys = [0.1, 0.5, 0.9].map((f) => Math.round(f * (canvas.height - 1)))
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
        return {
          hidden: canvas.hidden,
          size: [canvas.width, canvas.height],
          pixels: ys.map((py) => {
            const i = (py * canvas.width + px) * 4
            return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!] as RGBA
          }),
          target: [targetW, targetH],
        }
      },
      bandX,
      Math.round(s.options.width),
      Math.round(s.options.height),
    )
    check(!previewBand.hidden, 'the preview canvas is visible in blur mode')
    check(
      Math.abs(previewBand.size[0]! / previewBand.size[1]! - previewBand.target[0]! / previewBand.target[1]!) < 0.02,
      `preview frame keeps the target aspect (${previewBand.size.join('x')} for ${previewBand.target.join('x')})`,
    )
    const previewFlat = previewBand.pixels.every((p) => maxDiff(p, previewBand.pixels[0]!) === 0)
    check(!previewFlat, 'the preview canvas shows a blurred (varying) background band, not a flat fill')
    check(!previewBand.pixels.some((p) => maxDiff(p, WHITE) <= 2), 'the preview canvas band is not the white colour background')
    await page.screenshot({ path: join(OUT_DIR, 'browser-blur.png') })

    // 9. full-resolution wasm result vs the engine-rendered preview frame ---------
    step('wasm vs preview frame')
    await page.click('[data-bg="color"]')
    await setInputValue(page, '#bgColorInput', '#204080')
    await clickTool(page, 'position')
    await page.click('[data-align="center"]')
    await page.click('[data-align-y="center"]')
    s = await readState(page)
    rect = computePlacement(SRC_W, SRC_H, s.options)

    // Sample an 9x7 grid, skipping points near any edge where the two resamplers
    // (Lanczos vs. the browser's) legitimately disagree.
    const W = Math.round(s.options.width)
    const H = Math.round(s.options.height)
    const MARGIN = 12
    const grid: Array<[number, number]> = []
    for (let gy = 1; gy <= 7; gy++) {
      for (let gx = 1; gx <= 9; gx++) {
        const x = Math.round((gx * W) / 10)
        const y = Math.round((gy * H) / 8)
        const nearEdge =
          Math.abs(x - rect.x) < MARGIN ||
          Math.abs(x - (rect.x + rect.width)) < MARGIN ||
          Math.abs(y - rect.y) < MARGIN ||
          Math.abs(y - (rect.y + rect.height)) < MARGIN ||
          // the source's own internal quadrant boundaries, mapped onto the canvas
          Math.abs(x - (rect.x + rect.width / 2)) < MARGIN ||
          Math.abs(y - (rect.y + rect.height / 2)) < MARGIN
        if (!nearEdge) grid.push([x, y])
      }
    }
    check(grid.length >= 20, `grid has enough safe sample points (${grid.length})`)

    const wasmGrid = await renderAndProbe(page, grid)
    await waitForPreview(page)
    const canvasGrid = await page.evaluate(
      (pts: Array<[number, number]>, targetW: number, targetH: number) => {
        const canvas = document.getElementById('previewCanvas') as HTMLCanvasElement
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('no 2d context')
        // The preview canvas holds the engine's preview frame: the same fit rendered by
        // MagickWand at the target size capped on its long side.
        const sx = canvas.width / targetW
        const sy = canvas.height / targetH
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
        return pts.map(([x, y]) => {
          const px = Math.min(canvas.width - 1, Math.round(x * sx))
          const py = Math.min(canvas.height - 1, Math.round(y * sy))
          const i = (py * canvas.width + px) * 4
          return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!] as RGBA
        })
      },
      grid,
      W,
      H,
    )

    let worstGrid = 0
    let worstAt = ''
    for (let i = 0; i < grid.length; i++) {
      const d = maxDiff(wasmGrid.pixels[i]!, canvasGrid[i]!)
      if (d > worstGrid) {
        worstGrid = d
        worstAt = `(${grid[i]!.join(',')}) wasm rgba(${wasmGrid.pixels[i]!.join(',')}) vs canvas rgba(${canvasGrid[i]!.join(',')})`
      }
    }
    check(worstGrid <= PREVIEW_TOL, `wasm and preview agree on ${grid.length} grid points (worst diff ${worstGrid} at ${worstAt})`)
    console.log(`  ok    preview/wasm worst channel diff = ${worstGrid} over ${grid.length} points`)

    await page.screenshot({ path: join(OUT_DIR, 'browser-editing.png') })

    // 10. real file upload through the file input --------------------------------
    step('file upload (real BMP through #fileInput)')
    // `page.$` is typed off the selector string, so it hands back ElementHandle<Element>;
    // uploadFile is only declared on ElementHandle<HTMLInputElement>.
    const input = (await page.$('#fileInput')) as ElementHandle<HTMLInputElement> | null
    if (!input) throw new Error('#fileInput not found')
    await input.uploadFile(bmpPath)
    await page.waitForFunction(
      () => {
        const h = (window as unknown as { __imageFitter?: PageHook }).__imageFitter
        return !!h && h.state.source?.name === 'browser-upload-source.bmp'
      },
      { timeout: 15_000 },
    )
    s = await readState(page)
    check(s.source?.width === SRC_W && s.source?.height === SRC_H, `uploaded BMP decoded to ${SRC_W}x${SRC_H} (got ${s.source?.width}x${s.source?.height})`)
    check(s.options.width === SRC_W && s.options.height === SRC_H, 'target size follows the uploaded image')
    check(s.preset === 'custom', 'upload resets the preset to custom')

    // Drive it once more end to end on the uploaded (browser-decoded) pixels.
    await clickTool(page, 'ratio')
    await page.click('[data-ratio="16:9"]')
    await assertFit(page, 'uploaded BMP + 16:9')
    await clickTool(page, 'position')
    await page.click('[data-align-y="bottom"]')
    const uploadedFit = await assertFit(page, 'uploaded BMP + 16:9 + bottom')
    console.log(`  ok    wasm fit of the uploaded image: ${uploadedFit.ms.toFixed(0)} ms`)

    // 11. Save ------------------------------------------------------------------
    step('Save')
    s = await readState(page)
    const expectedName = `fitted-image-${Math.round(s.options.width)}x${Math.round(s.options.height)}.png`
    await page.click('#saveBtn')

    let downloaded: Buffer | undefined
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const files = await readdir(DOWNLOADS).catch(() => [] as string[])
      if (files.includes(expectedName)) {
        const bytes = await readFile(join(DOWNLOADS, expectedName))
        if (bytes.byteLength > 0) {
          downloaded = bytes
          break
        }
      }
      await sleep(150)
    }
    if (check(!!downloaded, `Save wrote ${expectedName} into ${DOWNLOADS}`)) {
      const sig = [...downloaded!.subarray(0, 8)]
      check(
        sig.join(',') === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].join(','),
        `the download starts with the PNG signature (got ${sig.map((b) => b.toString(16)).join(' ')})`,
      )
      // IHDR width/height must be the target size.
      const w = downloaded!.readUInt32BE(16)
      const h = downloaded!.readUInt32BE(20)
      check(
        w === Math.round(s.options.width) && h === Math.round(s.options.height),
        `the PNG is ${Math.round(s.options.width)}x${Math.round(s.options.height)} (IHDR says ${w}x${h})`,
      )
      console.log(`  ok    saved ${expectedName} (${downloaded!.byteLength} bytes, ${w}x${h})`)
    }
    const afterSave = await readState(page)
    check(afterSave.busy === false, 'the Save button is no longer busy afterwards')
    check(afterSave.toast === null, `no error toast after Save (got ${JSON.stringify(afterSave.toast)})`)

    // 12. Reset -------------------------------------------------------------------
    step('Reset')
    await page.click('#resetBtn')
    s = await readState(page)
    check(s.options.width === SRC_W && s.options.height === SRC_H, 'Reset restores the source size')
    check(s.options.align === 'center' && s.options.alignY === 'center', 'Reset restores center/center alignment')
    check(s.options.offsetX === 0 && s.options.offsetY === 0, 'Reset clears the nudges')
    check(
      s.options.background.mode === 'color' && s.options.background.color === '#ffffff',
      'Reset restores the white colour background',
    )
    check(s.preset === 'custom', 'Reset restores the custom preset')
    await assertFit(page, 'after Reset')

    // 13. mobile viewport ----------------------------------------------------------
    step('mobile viewport 390x844')
    // NB: no isMobile/hasTouch here on purpose — changing either makes puppeteer RELOAD
    // the page (to re-negotiate the emulation), which would throw away the loaded image
    // and the app state this step is meant to inspect.
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
    await sleep(250)
    check((await readState(page)).source !== null, 'the resize did not reload the page / drop the image')
    const overflow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      innerW: window.innerWidth,
    }))
    check(
      overflow.scrollW <= overflow.clientW + 1,
      `no horizontal page scroll at 390 px (scrollWidth ${overflow.scrollW} vs clientWidth ${overflow.clientW})`,
    )
    check(overflow.innerW === 390, `the viewport really is 390 px wide (got ${overflow.innerW})`)
    const stripVisible = await page.evaluate(() => {
      const strip = document.getElementById('toolStrip')
      if (!strip) return false
      const shown = [...strip.querySelectorAll<HTMLElement>('[data-tool]')].filter((b) => !b.hidden)
      return shown.length === 4 && shown.every((b) => b.offsetParent !== null)
    })
    check(stripVisible, 'all four fit tool tabs are visible at 390 px')
    await clickTool(page, 'position')
    await page.screenshot({ path: join(OUT_DIR, 'browser-mobile.png') })
    await assertFit(page, 'mobile viewport render')

    // 14. Stack mode -----------------------------------------------------------------
    step('Stack mode')
    const STACK_SRC: Array<{ w: number; h: number; c: RGBA }> = [
      { w: 300, h: 200, c: RED },
      { w: 100, h: 200, c: GREEN },
      { w: 150, h: 100, c: BLUE },
    ]
    await page.evaluate((specs: Array<{ w: number; h: number; c: RGBA }>) => {
      const hook = (window as unknown as { __imageFitter?: PageHook }).__imageFitter
      if (!hook) throw new Error('no hook')
      hook.loadBitmaps(
        specs.map(({ w, h, c }) => {
          const data = new Uint8ClampedArray(w * h * 4)
          for (let i = 0; i < data.length; i += 4) data.set(c, i)
          return { width: w, height: h, data }
        }),
      )
    }, STACK_SRC)

    /** Renders and checks: stacked size, and — while the fit is a pass-through — every
     *  image's colour at the centre of the cell the plan predicts plus gap/slack pixels. */
    async function assertStack(label: string): Promise<PageHook['state']> {
      const st = await readState(page)
      const colors = st.images.map((img) => STACK_SRC[Number(img.name.split('-').pop()) - 1]!.c)
      const plan = planStack(st.images, st.stack)
      check(
        st.source?.width === plan.width && st.source?.height === plan.height,
        `${label}: source is the stacked size ${plan.width}x${plan.height} (got ${st.source?.width}x${st.source?.height})`,
      )
      const W = Math.round(st.options.width)
      const H = Math.round(st.options.height)
      const passThrough = W === plan.width && H === plan.height
      const probes: Array<[number, number]> = passThrough
        ? plan.cells.map((c) => [c.x + (c.width >> 1), c.y + (c.height >> 1)] as [number, number])
        : []
      const result = await renderAndProbe(page, probes)
      check(result.width === W && result.height === H, `${label}: output is ${result.width}x${result.height}, want ${W}x${H}`)
      probes.forEach((p, i) => checkPixel(result.pixels[i]!, colors[i]!, PIXEL_TOL, `${label}: image ${i + 1} at (${p.join(',')})`))
      console.log(`  ok    ${label}: ${plan.width}x${plan.height} -> ${W}x${H}, ${st.images.length} images, wasm ${result.ms.toFixed(0)} ms`)
      return st
    }

    s = await readState(page)
    check(s.mode === 'stack', `loadBitmaps opens Stack mode (got ${s.mode})`)
    check(s.tool === 'layout', `Stack mode opens on the Layout tool (got ${s.tool})`)
    const stackTabs = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('#toolStrip [data-tool]')].filter((b) => !b.hidden).map((b) => b.dataset.tool),
    )
    check(
      stackTabs.join(',') === 'images,layout,sizing,ratio,size,position,background',
      `Stack mode shows its tools plus the fit tools (got ${stackTabs.join(',')})`,
    )
    await assertStack('stack: default row, matched heights')

    await page.click('[data-layout="vertical"]')
    await assertStack('stack: column')
    await page.click('[data-layout="grid"]')
    await setInputValue(page, '#columnsInput', '2')
    await assertStack('stack: grid of 2 columns')
    await setInputValue(page, '#gapRange', '12')
    s = await assertStack('stack: grid + 12px gap')
    check(s.stack.gap === 12, `gap is 12 (got ${s.stack.gap})`)
    await waitForPreview(page)
    await page.screenshot({ path: join(OUT_DIR, 'browser-stack-layout.png') })

    await clickTool(page, 'sizing')
    await page.click('[data-match="none"]')
    await page.click('[data-stack-align="end"]')
    s = await assertStack('stack: grid, no matching, end-aligned')
    check(s.stack.match === 'none' && s.stack.align === 'end', 'sizing chips update match/align')

    await clickTool(page, 'images')
    await page.click('.thumb [data-move="1"]')
    s = await assertStack('stack: first image moved later')
    check(
      s.images.map((i) => i.name).join(',') === 'debug-bitmap-2,debug-bitmap-1,debug-bitmap-3',
      `reorder swaps images 1 and 2 (got ${s.images.map((i) => i.name).join(',')})`,
    )
    const thumbCount = await page.$$eval('.thumb[data-key]', (els) => els.length)
    check(thumbCount === 3, `images panel lists 3 thumbnails (got ${thumbCount})`)
    await waitForPreview(page)
    await page.screenshot({ path: join(OUT_DIR, 'browser-stack-images.png') })
    await page.click('.thumb-strip > .thumb:nth-child(3) [data-remove]')
    s = await assertStack('stack: third image removed')
    check(s.images.length === 2, `removing leaves 2 images (got ${s.images.length})`)

    await clickTool(page, 'ratio')
    await page.click('[data-ratio="1:1"]')
    s = await assertStack('stack: fitted 1:1')
    const side = Math.max(s.source!.width, s.source!.height)
    check(s.options.width === side && s.options.height === side, `1:1 squares the stacked size (${side})`)
    await page.screenshot({ path: join(OUT_DIR, 'browser-stack.png') })

    await clickTool(page, 'layout')
    await page.click('[data-layout="horizontal"]')
    s = await readState(page)
    const followSide = Math.max(s.source!.width, s.source!.height)
    check(s.options.width === followSide, 'the 1:1 target follows the stack when the layout changes')

    await page.click('#homeBtn')
    s = await readState(page)
    const home = await page.evaluate(() => !(document.getElementById('intro') as HTMLElement).hidden)
    check(s.mode === null && s.images.length === 0 && home, 'Back returns to the intro and drops the images')

    // 15. console cleanliness -------------------------------------------------------
    step('console')
    check(consoleErrors.length === 0, `no console errors or page exceptions (got ${consoleErrors.length}):\n    ${consoleErrors.join('\n    ')}`)
  } finally {
    await browser?.close().catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  console.log(
    `\nscreenshots: ${join(OUT_DIR, 'browser-empty.png')}, ${join(OUT_DIR, 'browser-editing.png')}, ` +
      `${join(OUT_DIR, 'browser-blur.png')}, ${join(OUT_DIR, 'browser-mobile.png')}`,
  )
  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) {
    console.error(`\n${failures} FAILED:`)
    for (const f of failureLog) console.error(`  - ${f}`)
    process.exitCode = 1
  } else {
    console.log('all browser checks passed')
  }
}

main().catch((err: unknown) => {
  console.error('\nbrowser test crashed:', err)
  process.exitCode = 1
})
