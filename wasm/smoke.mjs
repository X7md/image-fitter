// Smoke test for src/wasm/magick.wasm.
//
// Deliberately uses node:wasi (NOT our own shim in src/wasm/wasi.ts) so that it
// tests the *module*, independently of the bindings agent's work.  Node prints
// an ExperimentalWarning for node:wasi; that is expected.
//
//   node wasm/smoke.mjs
//
// Exit code 0 = everything passed.

import { WASI } from 'node:wasi';
import { readFileSync, mkdtempSync, openSync, closeSync, statSync, readFileSync as read } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM = join(HERE, '..', 'src', 'wasm', 'magick.wasm');

/* ------------------------------------------------------------------ enums --
   Values read out of wasm/ImageMagick/MagickCore/*.h.  Each enum below is a
   plain contiguous C enum starting at 0, verified by counting members from the
   `Undefined*` entry (the ranges were checked to contain nothing but members).

     MagickCore/pixel.h:156     UndefinedPixel = 0  -> CharPixel        = 1
     MagickCore/resample.h:34   UndefinedFilter = 0 -> LanczosFilter    = 22
     MagickCore/composite.h:27  UndefinedCompositeOp = 0
                                                    -> OverCompositeOp  = 54
*/
const CharPixel = 1;
const LanczosFilter = 22;
const OverCompositeOp = 54;

/* ------------------------------------------------------------- test harness */
let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `got ${actual}, want ${expected}`);
}

/* --------------------------------------------------------------- bootstrap */
const dir = mkdtempSync(join(tmpdir(), 'magick-smoke-'));
const outPath = join(dir, 'stdout.txt');
const errPath = join(dir, 'stderr.txt');
const outFd = openSync(outPath, 'w');
const errFd = openSync(errPath, 'w');

const wasi = new WASI({
  version: 'preview1',
  args: ['magick'],
  env: {},
  preopens: { '/': dir },
  stdout: outFd,
  stderr: errFd,
  returnOnExit: true,
});

const bytes = readFileSync(WASM);
const module = new WebAssembly.Module(bytes);
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
wasi.initialize(instance);

const X = instance.exports;
const mem = X.memory;
const enc = new TextEncoder();
const dec = new TextDecoder();

const u8 = () => new Uint8Array(mem.buffer);
const dv = () => new DataView(mem.buffer);

function cstr(s) {
  const b = enc.encode(s);
  const p = X.malloc(b.length + 1);
  u8().set(b, p);
  u8()[p + b.length] = 0;
  return p;
}
function readCStr(p) {
  if (p === 0) return '';
  const m = u8();
  let e = p;
  while (m[e] !== 0) e++;
  return dec.decode(m.subarray(p, e));
}

/* ------------------------------------------------------------------ tests */
console.log(`module: ${WASM} (${bytes.length} bytes)`);
console.log(`imports: ${[...new Set(WebAssembly.Module.imports(module).map((i) => i.module))].join(', ')}`);
console.log();

X.MagickWandGenesis();
check('MagickWandGenesis / IsMagickWandInstantiated', X.IsMagickWandInstantiated() === 1);

// --- version -----------------------------------------------------------------
const verNum = X.malloc(4);
const verStr = readCStr(X.MagickGetVersion(verNum));
check('MagickGetVersion', /ImageMagick 7\.1\.2/.test(verStr), verStr);
console.log(`       MagickLibVersion = 0x${dv().getUint32(verNum, true).toString(16)}`);
X.free(verNum);

// --- solid red image ---------------------------------------------------------
const dst = X.NewMagickWand();
check('NewMagickWand', dst !== 0 && X.IsMagickWand(dst) === 1);

const pw = X.NewPixelWand();
const red = cstr('#ff0000');
eq('PixelSetColor("#ff0000")', X.PixelSetColor(pw, red), 1);
X.free(red);

eq('MagickNewImage(64,48,red)', X.MagickNewImage(dst, 64, 48, pw), 1);
eq('MagickGetImageWidth', X.MagickGetImageWidth(dst), 64);
eq('MagickGetImageHeight', X.MagickGetImageHeight(dst), 48);

const mapRGBA = cstr('RGBA');
const px = X.malloc(64 * 48 * 4);
eq('MagickExportImagePixels(RGBA,CharPixel)',
   X.MagickExportImagePixels(dst, 0, 0, 64, 48, mapRGBA, CharPixel, px), 1);
{
  const p = u8().slice(px, px + 4);
  check('exported pixel 0 is opaque red', p[0] === 255 && p[1] === 0 && p[2] === 0 && p[3] === 255,
        `[${p.join(',')}]`);
}
X.free(px);

// --- constitute a gradient ---------------------------------------------------
const GW = 64, GH = 48;
const grad = new Uint8Array(GW * GH * 4);
for (let y = 0; y < GH; y++) {
  for (let x = 0; x < GW; x++) {
    const i = (y * GW + x) * 4;
    grad[i] = Math.round((x / (GW - 1)) * 255);
    grad[i + 1] = Math.round((y / (GH - 1)) * 255);
    grad[i + 2] = 64;
    grad[i + 3] = 255;
  }
}
const src = X.NewMagickWand();
const gp = X.malloc(grad.length);
u8().set(grad, gp);
eq('MagickConstituteImage(gradient)', X.MagickConstituteImage(src, GW, GH, mapRGBA, CharPixel, gp), 1);
X.free(gp);
eq('  constituted width', X.MagickGetImageWidth(src), GW);
eq('  constituted height', X.MagickGetImageHeight(src), GH);

// --- resize + blur -----------------------------------------------------------
eq('MagickResizeImage(32,24,Lanczos)', X.MagickResizeImage(src, 32, 24, LanczosFilter), 1);
eq('  resized width', X.MagickGetImageWidth(src), 32);
eq('  resized height', X.MagickGetImageHeight(src), 24);
eq('MagickBlurImage(0,3)', X.MagickBlurImage(src, 0, 3), 1);

// --- composite ---------------------------------------------------------------
eq('MagickCompositeImage(Over, clipToSelf=0, 8, 8)',
   X.MagickCompositeImage(dst, src, OverCompositeOp, 0, 8, 8), 1);
{
  const buf = X.malloc(64 * 48 * 4);
  X.MagickExportImagePixels(dst, 0, 0, 64, 48, mapRGBA, CharPixel, buf);
  const m = u8();
  const at = (x, y) => Array.from(m.slice(buf + (y * 64 + x) * 4, buf + (y * 64 + x) * 4 + 4));
  const outside = at(2, 2);
  const inside = at(20, 20);
  check('  pixel outside composite rect still red',
        outside[0] === 255 && outside[1] === 0 && outside[2] === 0, `[${outside}]`);
  check('  pixel inside composite rect changed',
        !(inside[0] === 255 && inside[1] === 0 && inside[2] === 0), `[${inside}]`);
  X.free(buf);
}

// --- BMP blob round trip -----------------------------------------------------
const fmtBMP = cstr('BMP');
eq('MagickSetImageFormat("BMP")', X.MagickSetImageFormat(dst, fmtBMP), 1);
check('MagickGetImageFormat', readCStr(X.MagickGetImageFormat(dst)) === 'BMP');

const lenPtr = X.malloc(4);
const blobPtr = X.MagickGetImageBlob(dst, lenPtr);
const blobLen = dv().getUint32(lenPtr, true);
const blob = u8().slice(blobPtr, blobPtr + blobLen);
check('MagickGetImageBlob starts with "BM"', blob[0] === 0x42 && blob[1] === 0x4d,
      `${blobLen} bytes, magic ${String.fromCharCode(blob[0], blob[1])}`);
X.MagickRelinquishMemory(blobPtr);

const rt = X.NewMagickWand();
const bp = X.malloc(blobLen);
u8().set(blob, bp);
eq('MagickReadImageBlob(BMP)', X.MagickReadImageBlob(rt, bp, blobLen), 1);
X.free(bp);
eq('  round-tripped width', X.MagickGetImageWidth(rt), 64);
eq('  round-tripped height', X.MagickGetImageHeight(rt), 48);
eq('MagickGetNumberImages', X.MagickGetNumberImages(rt), 1);
X.MagickResetIterator(rt);
X.DestroyMagickWand(rt);

// --- deliberate failure -> exception -----------------------------------------
{
  const bad = X.NewMagickWand();
  const junk = new Uint8Array(64).fill(0x7f);
  const jp = X.malloc(junk.length);
  u8().set(junk, jp);
  const ok = X.MagickReadImageBlob(bad, jp, junk.length);
  X.free(jp);
  eq('MagickReadImageBlob(garbage) fails', ok, 0);

  const sevPtr = X.malloc(4);
  const msgPtr = X.MagickGetException(bad, sevPtr);
  const msg = readCStr(msgPtr);
  const sev = dv().getInt32(sevPtr, true);
  X.MagickRelinquishMemory(msgPtr);
  X.free(sevPtr);
  check('MagickGetException returns a message', msg.length > 0, JSON.stringify(msg));
  check('  severity > 0 and matches MagickGetExceptionType',
        sev > 0 && sev === X.MagickGetExceptionType(bad), `severity=${sev}`);

  X.MagickClearException(bad);
  const sp2 = X.malloc(4);
  const m2 = X.MagickGetException(bad, sp2);
  const after = readCStr(m2);
  X.MagickRelinquishMemory(m2);
  X.free(sp2);
  check('MagickClearException clears it', after.length === 0, JSON.stringify(after));
  X.DestroyMagickWand(bad);
}

// --- formats -----------------------------------------------------------------
{
  const star = cstr('*');
  const nPtr = X.malloc(4);
  const arr = X.MagickQueryFormats(star, nPtr);
  const n = dv().getUint32(nPtr, true);
  const names = [];
  for (let i = 0; i < n; i++) {
    const strPtr = dv().getUint32(arr + i * 4, true);
    names.push(readCStr(strPtr));
    X.MagickRelinquishMemory(strPtr);
  }
  X.MagickRelinquishMemory(arr);
  X.free(nPtr);
  X.free(star);
  check('MagickQueryFormats("*") includes BMP', names.includes('BMP'), `${n} formats`);
  for (const want of ['BMP', 'BMP3', 'PNM', 'PAM', 'PGM', 'PPM', 'RGBA', 'GRAY', 'TXT']) {
    check(`  format ${want}`, names.includes(want));
  }
  console.log(`       first 40: ${names.slice(0, 40).join(' ')}`);
  console.log(`       total   : ${n}`);
}

// --- resource limits ---------------------------------------------------------
// MagickCore/resource_.h:27  UndefinedResource = 0, contiguous.
const Resource = {
  Area: 1, Disk: 2, File: 3, Height: 4, Map: 5,
  Memory: 6, Thread: 7, Throttle: 8, Time: 9, Width: 10, ListLength: 11,
};
{
  // MagickGetResourceLimit returns MagickSizeType (uint64) -> BigInt in JS.
  const human = (v) =>
    v === (2n ** 63n - 1n) ? 'unlimited' :
    v > 1048576n ? `${(Number(v) / 1048576).toFixed(0)} MiB (${v})` : String(v);
  for (const [k, v] of Object.entries(Resource)) {
    if (k === 'Thread' || k === 'Throttle' || k === 'Time') continue;
    console.log(`       limit ${k.padEnd(10)} = ${human(X.MagickGetResourceLimit(v))}`);
  }
  // Force everything to stay in linear memory: never spill to the WASI FS.
  check('MagickSetResourceLimit(Disk, 0)', X.MagickSetResourceLimit(Resource.Disk, 0n) === 1);
  check('MagickSetResourceLimit(Map, 0)', X.MagickSetResourceLimit(Resource.Map, 0n) === 1);
}

// --- performance envelope ----------------------------------------------------
{
  const W = 2000, H = 1500;
  const big = new Uint8Array(W * H * 4);
  for (let i = 0; i < big.length; i += 4) {
    big[i] = (i >> 8) & 0xff;
    big[i + 1] = (i >> 4) & 0xff;
    big[i + 2] = i & 0xff;
    big[i + 3] = 255;
  }
  const w = X.NewMagickWand();
  const t0 = performance.now();
  const bp2 = X.malloc(big.length);
  u8().set(big, bp2);
  const okC = X.MagickConstituteImage(w, W, H, mapRGBA, CharPixel, bp2);
  X.free(bp2);
  const t1 = performance.now();
  const okR = X.MagickResizeImage(w, 1000, 750, LanczosFilter);
  const t2 = performance.now();
  const okB = X.MagickBlurImage(w, 0, 10);
  const t3 = performance.now();
  const ep = X.malloc(1000 * 750 * 4);
  const okE = X.MagickExportImagePixels(w, 0, 0, 1000, 750, mapRGBA, CharPixel, ep);
  X.free(ep);
  const t4 = performance.now();
  check('2000x1500 pipeline', okC === 1 && okR === 1 && okB === 1 && okE === 1);
  const ms = (a, b) => (b - a).toFixed(0).padStart(6) + ' ms';
  console.log(`       constitute 2000x1500 : ${ms(t0, t1)}`);
  console.log(`       resize  -> 1000x750   : ${ms(t1, t2)}`);
  console.log(`       blur(0,10)            : ${ms(t2, t3)}`);
  console.log(`       export 1000x750 RGBA  : ${ms(t3, t4)}`);
  console.log(`       TOTAL                 : ${ms(t0, t4)}`);
  console.log(`       wasm memory           : ${(mem.buffer.byteLength / 1048576).toFixed(0)} MiB`);
  X.DestroyMagickWand(w);
}

// --- teardown ----------------------------------------------------------------
X.free(mapRGBA);
X.free(fmtBMP);
X.free(lenPtr);
X.DestroyPixelWand(pw);
X.DestroyMagickWand(src);
X.DestroyMagickWand(dst);
X.MagickWandTerminus();
check('MagickWandTerminus / not instantiated', X.IsMagickWandInstantiated() === 0);

// --- stdio must stay silent --------------------------------------------------
closeSync(outFd);
closeSync(errFd);
const outTxt = read(outPath, 'utf8');
const errTxt = read(errPath, 'utf8');
check('no stdout noise', outTxt === '', JSON.stringify(outTxt.slice(0, 300)));
check('no stderr noise', errTxt === '', JSON.stringify(errTxt.slice(0, 300)));

console.log();
if (failures) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('all checks passed');
