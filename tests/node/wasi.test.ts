/**
 * (a) The module loads through OUR `Wasi` shim (not `node:wasi`), plus a few direct
 * checks on the shim's MemFS and on the generated import object.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { MemFS, Wasi, WasiExit, normalizePath } from '../../src/wasm/wasi'
import { loadMagick } from '../../src/wasm/magick'
import { wasmBytes } from './helpers'

test('MemFS: files, directories, listing and removal', () => {
  const fs = new MemFS()
  assert.equal(fs.exists('/'), true)
  assert.equal(fs.isDirectory('/'), true)

  fs.writeFile('/tmp/a.txt', new TextEncoder().encode('hello'))
  assert.equal(fs.exists('/tmp'), true, 'parent directories are created implicitly')
  assert.equal(fs.isDirectory('/tmp'), true)
  assert.deepEqual(new TextDecoder().decode(fs.readFile('/tmp/a.txt')!), 'hello')

  fs.writeFile('/tmp/b.bin', new Uint8Array([1, 2, 3]))
  fs.mkdirp('/tmp/sub/deeper')
  assert.deepEqual(fs.list('/tmp'), ['a.txt', 'b.bin', 'sub'])
  assert.deepEqual(fs.list('/tmp/sub'), ['deeper'])

  assert.equal(fs.readFile('/nope'), undefined)
  assert.equal(fs.readFile('/tmp'), undefined, 'a directory is not readable as a file')

  fs.remove('/tmp/a.txt')
  assert.equal(fs.exists('/tmp/a.txt'), false)
  assert.throws(() => fs.remove('/tmp'), /not empty/)
})

test('normalizePath resolves . and .. and strips trailing slashes', () => {
  assert.equal(normalizePath('/a/b/../c/'), '/a/c')
  assert.equal(normalizePath('./x', '/base'), '/base/x')
  assert.equal(normalizePath('/'), '/')
  assert.equal(normalizePath('//a//b//'), '/a/b')
})

test('Wasi.imports() covers every function the module asks for', async () => {
  const module = await WebAssembly.compile(wasmBytes())
  const wasi = new Wasi()
  const imports = wasi.imports(module)

  const namespaces = new Set(WebAssembly.Module.imports(module).map((i) => i.module))
  assert.deepEqual([...namespaces], ['wasi_snapshot_preview1'], 'only WASI may be imported')

  for (const desc of WebAssembly.Module.imports(module)) {
    const ns = imports[desc.module] as Record<string, unknown> | undefined
    assert.ok(ns, `namespace ${desc.module} is present`)
    assert.equal(typeof ns![desc.name], 'function', `${desc.module}.${desc.name} is implemented`)
  }
})

test('WasiExit carries the exit code', () => {
  const e = new WasiExit(3)
  assert.equal(e.code, 3)
  assert.equal(e.name, 'WasiExit')
  assert.ok(e instanceof Error)
})

test('loadMagick through our shim: version, formats, and silent stdio', async () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const magick = await loadMagick(wasmBytes(), {
    wasi: { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t), debug: true },
  })
  try {
    assert.ok(magick.version.length > 0, 'version string is non-empty')
    assert.match(magick.version, /ImageMagick 7\./)

    const formats = magick.formats()
    assert.ok(formats.length > 100, `expected many formats, got ${formats.length}`)
    for (const want of ['BMP', 'BMP3', 'PNM', 'PAM', 'PGM', 'PPM', 'RGBA', 'GRAY', 'TXT']) {
      assert.ok(formats.includes(want), `formats include ${want}`)
    }
    // PNG/JPEG need delegates that this build deliberately does not link.
    assert.equal(formats.includes('PNG'), false, 'no PNG coder without delegates')

    // Memory helpers round-trip.
    const ptr = magick.cstring('héllo')
    assert.equal(magick.readCString(ptr), 'héllo')
    magick.free(ptr)

    const dataPtr = magick.writeBytes(new Uint8Array([9, 8, 7]))
    assert.deepEqual([...magick.readBytes(dataPtr, 3)], [9, 8, 7])
    magick.free(dataPtr)

    assert.ok(magick.view() instanceof DataView)
  } finally {
    magick.terminate()
  }
  assert.deepEqual(stdout, [], 'the module writes nothing to stdout')
  assert.deepEqual(stderr, [], 'the module writes nothing to stderr')
})
