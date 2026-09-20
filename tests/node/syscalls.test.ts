/**
 * Raw `wasi_snapshot_preview1` syscall tests against `src/wasm/wasi.ts`, with no
 * ImageMagick involved: a hand-assembled module that only *imports* the syscalls gives
 * `Wasi.imports()` something to build from, and a plain `WebAssembly.Memory` stands in
 * for the instance. Every test pokes iovecs/paths into that memory and calls the shim
 * function directly, so each syscall's ABI (offsets, errno values, whence handling,
 * UTF-8 splitting, memory growth) is checked in isolation.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ERRNO, FILETYPE, Wasi, WasiExit } from '../../src/wasm/wasi'

type Syscalls = Record<string, (...args: number[]) => number> & {
  fd_seek(fd: number, offset: bigint, whence: number, out: number): number
  fd_pread(fd: number, iovs: number, n: number, offset: bigint, out: number): number
  path_open(
    dirfd: number,
    dirflags: number,
    path: number,
    pathLen: number,
    oflags: number,
    rightsBase: bigint,
    rightsInheriting: bigint,
    fdflags: number,
    out: number,
  ): number
  clock_time_get(id: number, precision: bigint, out: number): number
}

const SYSCALLS = [
  'fd_write',
  'fd_read',
  'fd_pread',
  'fd_seek',
  'fd_tell',
  'fd_close',
  'fd_fdstat_get',
  'fd_filestat_get',
  'fd_prestat_get',
  'fd_prestat_dir_name',
  'path_open',
  'path_filestat_get',
  'path_unlink_file',
  'clock_res_get',
  'clock_time_get',
  'random_get',
  'proc_exit',
  'not_a_real_syscall',
]

/** LEB128-encode an unsigned 32-bit integer. */
function uleb(n: number): number[] {
  const out: number[] = []
  do {
    let b = n & 0x7f
    n >>>= 7
    if (n !== 0) b |= 0x80
    out.push(b)
  } while (n !== 0)
  return out
}

function str(s: string): number[] {
  const bytes = [...new TextEncoder().encode(s)]
  return [...uleb(bytes.length), ...bytes]
}

function section(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body]
}

/** A valid module whose only content is one function import per name (type i32,i32 -> i32). */
function moduleImporting(names: string[]): WebAssembly.Module {
  const typeSection = section(1, [1, 0x60, 2, 0x7f, 0x7f, 1, 0x7f])
  const importBody = [
    ...uleb(names.length),
    ...names.flatMap((n) => [...str('wasi_snapshot_preview1'), ...str(n), 0x00, ...uleb(0)]),
  ]
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...typeSection,
    ...section(2, importBody),
  ])
  return new WebAssembly.Module(bytes)
}

interface Harness {
  wasi: Wasi
  sys: Syscalls
  memory: WebAssembly.Memory
  stdout: string[]
  stderr: string[]
  u8(): Uint8Array
  dv(): DataView
  /** Copy bytes into memory at `ptr`. */
  put(ptr: number, bytes: ArrayLike<number>): void
  /** Write an iovec array at `ptr` pointing at the given (buf, len) pairs. */
  iov(ptr: number, vecs: Array<[number, number]>): void
  /** Write a NUL-free path at `ptr`; returns its byte length. */
  path(ptr: number, s: string): number
}

function harness(): Harness {
  const stdout: string[] = []
  const stderr: string[] = []
  const wasi = new Wasi({ stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) })
  const imports = wasi.imports(moduleImporting(SYSCALLS))
  const sys = imports['wasi_snapshot_preview1'] as unknown as Syscalls
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 })
  wasi.initialize({ exports: { memory } } as unknown as WebAssembly.Instance)
  const h: Harness = {
    wasi,
    sys,
    memory,
    stdout,
    stderr,
    u8: () => new Uint8Array(memory.buffer),
    dv: () => new DataView(memory.buffer),
    put: (ptr, bytes) => h.u8().set(bytes, ptr),
    iov: (ptr, vecs) => {
      const dv = h.dv()
      vecs.forEach(([buf, len], i) => {
        dv.setUint32(ptr + i * 8, buf, true)
        dv.setUint32(ptr + i * 8 + 4, len, true)
      })
    },
    path: (ptr, s) => {
      const bytes = new TextEncoder().encode(s)
      h.put(ptr, bytes)
      return bytes.length
    },
  }
  return h
}

/* Scratch layout inside the 64 KiB test page. */
const IOV = 0x100 // iovec array
const OUT = 0x200 // scalar out-params
const BUF = 0x400 // data
const PATH = 0x800 // path strings

test('imports(): every requested function exists, unknown ones are ENOSYS stubs', () => {
  const h = harness()
  for (const name of SYSCALLS) assert.equal(typeof h.sys[name], 'function', name)
  assert.equal(h.sys['not_a_real_syscall']!(), ERRNO.NOSYS)
})

test('fd_write: a UTF-8 sequence split across two writes decodes intact (fix: streaming decoder)', () => {
  const h = harness()
  // "é" is C3 A9; hand the two bytes to stdout in separate fd_write calls.
  h.put(BUF, [0xc3])
  h.iov(IOV, [[BUF, 1]])
  assert.equal(h.sys['fd_write']!(1, IOV, 1, OUT), ERRNO.SUCCESS)
  assert.equal(h.dv().getUint32(OUT, true), 1, 'nwritten counts bytes, not characters')
  h.put(BUF, [0xa9, 0x0a])
  h.iov(IOV, [[BUF, 2]])
  assert.equal(h.sys['fd_write']!(1, IOV, 1, OUT), ERRNO.SUCCESS)
  assert.deepEqual(h.stdout, ['é'])

  // Same on stderr, with the line split across three iovecs of one call.
  h.put(BUF, [0xe2, 0x82, 0xac, 0x0a]) // "€\n"
  h.iov(IOV, [
    [BUF, 1],
    [BUF + 1, 2],
    [BUF + 3, 1],
  ])
  assert.equal(h.sys['fd_write']!(2, IOV, 3, OUT), ERRNO.SUCCESS)
  assert.equal(h.dv().getUint32(OUT, true), 4)
  assert.deepEqual(h.stderr, ['€'])
})

test('fd_write: stdout is line-buffered and flush() emits a trailing partial line', () => {
  const h = harness()
  const bytes = new TextEncoder().encode('one\ntwo')
  h.put(BUF, bytes)
  h.iov(IOV, [[BUF, bytes.length]])
  assert.equal(h.sys['fd_write']!(1, IOV, 1, OUT), ERRNO.SUCCESS)
  assert.deepEqual(h.stdout, ['one'], 'only the complete line is forwarded')
  h.wasi.flush()
  assert.deepEqual(h.stdout, ['one', 'two'])
  h.wasi.flush()
  assert.deepEqual(h.stdout, ['one', 'two'], 'a second flush emits nothing')
  assert.equal(h.sys['fd_write']!(0, IOV, 1, OUT), ERRNO.BADF, 'stdin is not writable')
})

test('clock_res_get does not overstate clock_time_get (fix: 1 ms for REALTIME)', () => {
  const h = harness()
  assert.equal(h.sys['clock_res_get']!(0, OUT), ERRNO.SUCCESS)
  assert.equal(h.dv().getBigUint64(OUT, true), 1_000_000n, 'REALTIME comes from Date.now(): 1 ms')
  assert.equal(h.sys['clock_res_get']!(1, OUT), ERRNO.SUCCESS)
  assert.equal(h.dv().getBigUint64(OUT, true), 1000n, 'MONOTONIC comes from performance.now(): 1 µs')
  assert.equal(h.sys['clock_res_get']!(9, OUT), ERRNO.INVAL)

  const before = BigInt(Date.now()) * 1_000_000n
  assert.equal(h.sys.clock_time_get(0, 0n, OUT), ERRNO.SUCCESS)
  const realtime = h.dv().getBigUint64(OUT, true)
  const after = BigInt(Date.now()) * 1_000_000n
  assert.ok(realtime >= before && realtime <= after, `REALTIME ${realtime} within [${before}, ${after}]`)

  assert.equal(h.sys.clock_time_get(1, 0n, OUT), ERRNO.SUCCESS)
  const m1 = h.dv().getBigUint64(OUT, true)
  for (let i = 0; i < 1000; i++) {
    /* burn a little time */
  }
  assert.equal(h.sys.clock_time_get(1, 0n, OUT), ERRNO.SUCCESS)
  const m2 = h.dv().getBigUint64(OUT, true)
  assert.ok(m2 >= m1, 'MONOTONIC never goes backwards')
  assert.equal(h.sys.clock_time_get(4, 0n, OUT), ERRNO.INVAL)
})

test('path_open + fd_write + fd_seek (all three whence values) + fd_read/fd_pread/fd_tell', () => {
  const h = harness()
  const len = h.path(PATH, 'notes.txt')
  const CREAT = 1
  assert.equal(h.sys.path_open(3, 0, PATH, len, CREAT, 0n, 0n, 0, OUT), ERRNO.SUCCESS)
  const fd = h.dv().getUint32(OUT, true)
  assert.ok(fd >= 4, `new fd ${fd} is above the preopen`)

  const text = new TextEncoder().encode('hello world')
  h.put(BUF, text)
  h.iov(IOV, [[BUF, text.length]])
  assert.equal(h.sys['fd_write']!(fd, IOV, 1, OUT), ERRNO.SUCCESS)
  assert.equal(h.dv().getUint32(OUT, true), 11)
  assert.deepEqual(new TextDecoder().decode(h.wasi.fs.readFile('/notes.txt')!), 'hello world')

  // SET
  assert.equal(h.sys.fd_seek(fd, 6n, 0, OUT), ERRNO.SUCCESS)
  assert.equal(h.dv().getBigUint64(OUT, true), 6n)
  h.iov(IOV, [[BUF + 64, 32]])
  assert.equal(h.sys['fd_read']!(fd, IOV, 1, OUT), ERRNO.SUCCESS)
  assert.equal(h.dv().getUint32(OUT, true), 5, 'read stops at EOF')
  assert.equal(new TextDecoder().decode(h.u8().slice(BUF + 64, BUF + 69)), 'world')
  // CUR (now at 11): -5 -> 6
  assert.equal(h.sys.fd_seek(fd, -5n, 1, OUT), ERRNO.SUCCESS)
  assert.equal(h.dv().getBigUint64(OUT, true), 6n)
  assert.equal(h.sys['fd_tell']!(fd, OUT), ERRNO.SUCCESS)
  assert.equal(h.dv().getBigUint64(OUT, true), 6n)
  // END: -11 -> 0
  assert.equal(h.sys.fd_seek(fd, -11n, 2, OUT), ERRNO.SUCCESS)
  assert.equal(h.dv().getBigUint64(OUT, true), 0n)
  // invalid whence / negative result
  assert.equal(h.sys.fd_seek(fd, 0n, 7, OUT), ERRNO.INVAL)
  assert.equal(h.sys.fd_seek(fd, -1n, 0, OUT), ERRNO.INVAL)
  // seeking past EOF is allowed; a write there zero-fills the gap
  assert.equal(h.sys.fd_seek(fd, 13n, 0, OUT), ERRNO.SUCCESS)
  h.put(BUF, [0x21])
  h.iov(IOV, [[BUF, 1]])
  assert.equal(h.sys['fd_write']!(fd, IOV, 1, OUT), ERRNO.SUCCESS)
  assert.deepEqual([...h.wasi.fs.readFile('/notes.txt')!.slice(11)], [0, 0, 0x21])
  // pread does not move the cursor
  h.iov(IOV, [[BUF + 64, 5]])
  assert.equal(h.sys.fd_pread(fd, IOV, 1, 0n, OUT), ERRNO.SUCCESS)
  assert.equal(new TextDecoder().decode(h.u8().slice(BUF + 64, BUF + 69)), 'hello')
  assert.equal(h.sys['fd_tell']!(fd, OUT), ERRNO.SUCCESS)
  assert.equal(h.dv().getBigUint64(OUT, true), 14n)

  // stdio is not seekable
  assert.equal(h.sys.fd_seek(1, 0n, 0, OUT), ERRNO.SPIPE)
  assert.equal(h.sys['fd_tell']!(1, OUT), ERRNO.SPIPE)

  assert.equal(h.sys['fd_close']!(fd), ERRNO.SUCCESS)
  assert.equal(h.sys['fd_close']!(fd), ERRNO.BADF, 'closing twice')
  assert.equal(h.sys['fd_close']!(3), ERRNO.NOTSUP, 'the preopen cannot be closed')
})

test('path_open: oflags (CREAT / EXCL / TRUNC / DIRECTORY) and errno values', () => {
  const h = harness()
  const CREAT = 1,
    DIRECTORY = 2,
    EXCL = 4,
    TRUNC = 8
  const len = h.path(PATH, 'f.bin')
  assert.equal(h.sys.path_open(3, 0, PATH, len, 0, 0n, 0n, 0, OUT), ERRNO.NOENT, 'missing, no CREAT')
  assert.equal(h.sys.path_open(3, 0, PATH, len, CREAT | EXCL, 0n, 0n, 0, OUT), ERRNO.SUCCESS)
  assert.equal(h.sys.path_open(3, 0, PATH, len, CREAT | EXCL, 0n, 0n, 0, OUT), ERRNO.EXIST, 'EXCL on existing')
  assert.equal(h.sys.path_open(3, 0, PATH, len, DIRECTORY, 0n, 0n, 0, OUT), ERRNO.NOTDIR, 'DIRECTORY on a file')

  h.wasi.fs.writeFile('/f.bin', new Uint8Array([1, 2, 3, 4]))
  assert.equal(h.sys.path_open(3, 0, PATH, len, TRUNC, 0n, 0n, 0, OUT), ERRNO.SUCCESS)
  assert.equal(h.wasi.fs.readFile('/f.bin')!.length, 0, 'TRUNC empties the file')

  const dlen = h.path(PATH + 64, 'sub')
  h.wasi.fs.mkdirp('/sub')
  assert.equal(h.sys.path_open(3, 0, PATH + 64, dlen, DIRECTORY, 0n, 0n, 0, OUT), ERRNO.SUCCESS)
  const dirFd = h.dv().getUint32(OUT, true)
  assert.equal(h.sys['fd_fdstat_get']!(dirFd, OUT), ERRNO.SUCCESS)
  assert.equal(h.dv().getUint8(OUT), FILETYPE.DIRECTORY)
  // paths are resolved relative to the directory fd
  const rlen = h.path(PATH + 128, 'inner.txt')
  assert.equal(h.sys.path_open(dirFd, 0, PATH + 128, rlen, CREAT, 0n, 0n, 0, OUT), ERRNO.SUCCESS)
  assert.ok(h.wasi.fs.exists('/sub/inner.txt'))

  // fdstat of stdio and files
  assert.equal(h.sys['fd_fdstat_get']!(1, OUT), ERRNO.SUCCESS)
  assert.equal(h.dv().getUint8(OUT), FILETYPE.CHARACTER_DEVICE)
  assert.equal(h.sys['fd_fdstat_get']!(99, OUT), ERRNO.BADF)

  // prestat of the root
  assert.equal(h.sys['fd_prestat_get']!(3, OUT), ERRNO.SUCCESS)
  assert.equal(h.dv().getUint8(OUT), 0, 'tag: dir')
  assert.equal(h.dv().getUint32(OUT + 4, true), 1, '"/" is one byte')
  assert.equal(h.sys['fd_prestat_dir_name']!(3, BUF, 1), ERRNO.SUCCESS)
  assert.equal(h.u8()[BUF], 0x2f)
  assert.equal(h.sys['fd_prestat_dir_name']!(3, BUF, 0), ERRNO.NAMETOOLONG)
  assert.equal(h.sys['fd_prestat_get']!(1, OUT), ERRNO.BADF)

  // unlink
  assert.equal(h.sys['path_unlink_file']!(3, PATH, len), ERRNO.SUCCESS)
  assert.equal(h.sys['path_unlink_file']!(3, PATH, len), ERRNO.NOENT)
  assert.equal(h.sys['path_unlink_file']!(3, PATH + 64, dlen), ERRNO.ISDIR)
})

test('random_get fills the buffer; proc_exit throws WasiExit', () => {
  const h = harness()
  h.u8().fill(0, BUF, BUF + 256)
  assert.equal(h.sys['random_get']!(BUF, 256), ERRNO.SUCCESS)
  const bytes = h.u8().slice(BUF, BUF + 256)
  assert.ok(bytes.some((b) => b !== 0), 'not all zero')
  assert.ok(new Set(bytes).size > 16, 'looks random')
  assert.equal(h.u8()[BUF + 256], 0, 'no write past the end')

  const text = new TextEncoder().encode('bye')
  h.put(BUF, text)
  h.iov(IOV, [[BUF, 3]])
  h.sys['fd_write']!(1, IOV, 1, OUT)
  assert.throws(
    () => h.sys['proc_exit']!(7),
    (e: unknown) => e instanceof WasiExit && e.code === 7,
  )
  assert.deepEqual(h.stdout, ['bye'], 'proc_exit flushes pending output first')
})

test('memory growth between calls does not break the shim (no cached views)', () => {
  const h = harness()
  const len = h.path(PATH, 'grow.txt')
  assert.equal(h.sys.path_open(3, 0, PATH, len, 1, 0n, 0n, 0, OUT), ERRNO.SUCCESS)
  const fd = h.dv().getUint32(OUT, true)

  h.memory.grow(1) // detaches every earlier ArrayBuffer view
  const highBuf = 65536 + 16 // inside the new page
  const highIov = 65536 + 256
  h.put(highBuf, new TextEncoder().encode('after growth'))
  h.iov(highIov, [[highBuf, 12]])
  assert.equal(h.sys['fd_write']!(fd, highIov, 1, highIov + 64), ERRNO.SUCCESS)
  assert.equal(h.dv().getUint32(highIov + 64, true), 12)

  h.memory.grow(1)
  h.iov(highIov, [[131072 + 8, 64]])
  assert.equal(h.sys.fd_pread(fd, highIov, 1, 0n, highIov + 64), ERRNO.SUCCESS)
  assert.equal(new TextDecoder().decode(h.u8().slice(131072 + 8, 131072 + 20)), 'after growth')

  assert.equal(h.sys['fd_filestat_get']!(fd, 131072 + 512), ERRNO.SUCCESS)
  assert.equal(h.dv().getUint8(131072 + 512 + 16), FILETYPE.REGULAR_FILE)
  assert.equal(h.dv().getBigUint64(131072 + 512 + 32, true), 12n, 'filestat size')
})
