/**
 * Minimal WASI `wasi_snapshot_preview1` shim + in-memory file system.
 *
 * Runs unchanged in Node 22 and in browsers: there are no `node:*` imports and the only
 * host APIs touched are `TextEncoder`/`TextDecoder`, `Date`, `performance` and
 * `crypto.getRandomValues`.
 *
 * The import object is generated from `WebAssembly.Module.imports(module)`, so every
 * function the module actually asks for gets *some* implementation: a real one for the
 * calls listed in ARCHITECTURE.md §2, and an `ENOSYS` (errno 52) stub for anything else.
 * A stub logs one `console.warn` the first time it is really hit, and only when
 * `debug: true` is passed.
 *
 * Memory safety rule used throughout: wasm memory can grow at any time, which detaches
 * every existing `ArrayBuffer` view. No typed-array view is ever cached across a call
 * boundary — `u8()` / `dv()` build a fresh view each time.
 */

/* ------------------------------------------------------------------ constants -- */

/** `$errno` (wasi_snapshot_preview1). */
export const ERRNO = {
  SUCCESS: 0,
  TOOBIG: 1,
  ACCES: 2,
  ADDRINUSE: 3,
  ADDRNOTAVAIL: 4,
  AFNOSUPPORT: 5,
  AGAIN: 6,
  ALREADY: 7,
  BADF: 8,
  BADMSG: 9,
  BUSY: 10,
  CANCELED: 11,
  CHILD: 12,
  CONNABORTED: 13,
  CONNREFUSED: 14,
  CONNRESET: 15,
  DEADLK: 16,
  DESTADDRREQ: 17,
  DOM: 18,
  DQUOT: 19,
  EXIST: 20,
  FAULT: 21,
  FBIG: 22,
  HOSTUNREACH: 23,
  IDRM: 24,
  ILSEQ: 25,
  INPROGRESS: 26,
  INTR: 27,
  INVAL: 28,
  IO: 29,
  ISCONN: 30,
  ISDIR: 31,
  LOOP: 32,
  MFILE: 33,
  MLINK: 34,
  MSGSIZE: 35,
  MULTIHOP: 36,
  NAMETOOLONG: 37,
  NETDOWN: 38,
  NETRESET: 39,
  NETUNREACH: 40,
  NFILE: 41,
  NOBUFS: 42,
  NODEV: 43,
  NOENT: 44,
  NOEXEC: 45,
  NOLCK: 46,
  NOLINK: 47,
  NOMEM: 48,
  NOMSG: 49,
  NOPROTOOPT: 50,
  NOSPC: 51,
  NOSYS: 52,
  NOTCONN: 53,
  NOTDIR: 54,
  NOTEMPTY: 55,
  NOTRECOVERABLE: 56,
  NOTSOCK: 57,
  NOTSUP: 58,
  NOTTY: 59,
  NXIO: 60,
  OVERFLOW: 61,
  OWNERDEAD: 62,
  PERM: 63,
  PIPE: 64,
  PROTO: 65,
  PROTONOSUPPORT: 66,
  PROTOTYPE: 67,
  RANGE: 68,
  ROFS: 69,
  SPIPE: 70,
  SRCH: 71,
  STALE: 72,
  TIMEDOUT: 73,
  TXTBSY: 74,
  XDEV: 75,
  NOTCAPABLE: 76,
} as const

/** `$filetype`. */
export const FILETYPE = {
  UNKNOWN: 0,
  BLOCK_DEVICE: 1,
  CHARACTER_DEVICE: 2,
  DIRECTORY: 3,
  REGULAR_FILE: 4,
  SOCKET_DGRAM: 5,
  SOCKET_STREAM: 6,
  SYMBOLIC_LINK: 7,
} as const

/** `$rights` — a 64-bit flag set, so these are `bigint`. */
export const RIGHTS = {
  FD_DATASYNC: 1n << 0n,
  FD_READ: 1n << 1n,
  FD_SEEK: 1n << 2n,
  FD_FDSTAT_SET_FLAGS: 1n << 3n,
  FD_SYNC: 1n << 4n,
  FD_TELL: 1n << 5n,
  FD_WRITE: 1n << 6n,
  FD_ADVISE: 1n << 7n,
  FD_ALLOCATE: 1n << 8n,
  PATH_CREATE_DIRECTORY: 1n << 9n,
  PATH_CREATE_FILE: 1n << 10n,
  PATH_LINK_SOURCE: 1n << 11n,
  PATH_LINK_TARGET: 1n << 12n,
  PATH_OPEN: 1n << 13n,
  FD_READDIR: 1n << 14n,
  PATH_READLINK: 1n << 15n,
  PATH_RENAME_SOURCE: 1n << 16n,
  PATH_RENAME_TARGET: 1n << 17n,
  PATH_FILESTAT_GET: 1n << 18n,
  PATH_FILESTAT_SET_SIZE: 1n << 19n,
  PATH_FILESTAT_SET_TIMES: 1n << 20n,
  FD_FILESTAT_GET: 1n << 21n,
  FD_FILESTAT_SET_SIZE: 1n << 22n,
  FD_FILESTAT_SET_TIMES: 1n << 23n,
  PATH_SYMLINK: 1n << 24n,
  PATH_REMOVE_DIRECTORY: 1n << 25n,
  PATH_UNLINK_FILE: 1n << 26n,
  POLL_FD_READWRITE: 1n << 27n,
  SOCK_SHUTDOWN: 1n << 28n,
  SOCK_ACCEPT: 1n << 29n,
} as const

const RIGHTS_FILE =
  RIGHTS.FD_DATASYNC |
  RIGHTS.FD_READ |
  RIGHTS.FD_SEEK |
  RIGHTS.FD_FDSTAT_SET_FLAGS |
  RIGHTS.FD_SYNC |
  RIGHTS.FD_TELL |
  RIGHTS.FD_WRITE |
  RIGHTS.FD_ADVISE |
  RIGHTS.FD_ALLOCATE |
  RIGHTS.FD_FILESTAT_GET |
  RIGHTS.FD_FILESTAT_SET_SIZE |
  RIGHTS.FD_FILESTAT_SET_TIMES |
  RIGHTS.POLL_FD_READWRITE

const RIGHTS_DIR =
  RIGHTS.FD_FDSTAT_SET_FLAGS |
  RIGHTS.FD_SYNC |
  RIGHTS.FD_ADVISE |
  RIGHTS.PATH_CREATE_DIRECTORY |
  RIGHTS.PATH_CREATE_FILE |
  RIGHTS.PATH_LINK_SOURCE |
  RIGHTS.PATH_LINK_TARGET |
  RIGHTS.PATH_OPEN |
  RIGHTS.FD_READDIR |
  RIGHTS.PATH_READLINK |
  RIGHTS.PATH_RENAME_SOURCE |
  RIGHTS.PATH_RENAME_TARGET |
  RIGHTS.PATH_FILESTAT_GET |
  RIGHTS.PATH_FILESTAT_SET_SIZE |
  RIGHTS.PATH_FILESTAT_SET_TIMES |
  RIGHTS.FD_FILESTAT_GET |
  RIGHTS.FD_FILESTAT_SET_TIMES |
  RIGHTS.PATH_SYMLINK |
  RIGHTS.PATH_REMOVE_DIRECTORY |
  RIGHTS.PATH_UNLINK_FILE |
  RIGHTS.POLL_FD_READWRITE

const RIGHTS_TTY =
  RIGHTS.FD_DATASYNC |
  RIGHTS.FD_READ |
  RIGHTS.FD_SYNC |
  RIGHTS.FD_WRITE |
  RIGHTS.FD_ADVISE |
  RIGHTS.FD_FILESTAT_GET |
  RIGHTS.POLL_FD_READWRITE

/** `$oflags` passed to `path_open`. */
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 } as const
/** `$fdflags`. */
const FDFLAGS = { APPEND: 1, DSYNC: 2, NONBLOCK: 4, RSYNC: 8, SYNC: 16 } as const
/** `$whence` for `fd_seek`. */
const WHENCE = { SET: 0, CUR: 1, END: 2 } as const
/** `$clockid`. */
const CLOCKID = { REALTIME: 0, MONOTONIC: 1, PROCESS_CPUTIME: 2, THREAD_CPUTIME: 3 } as const
/** `$eventtype` for `poll_oneoff`. */
const EVENTTYPE = { CLOCK: 0, FD_READ: 1, FD_WRITE: 2 } as const
/** `$subclockflags`: timeout is an absolute time. */
const SUBSCRIPTION_CLOCK_ABSTIME = 1

const encoder = /* @__PURE__ */ new TextEncoder()
const decoder = /* @__PURE__ */ new TextDecoder()

/* ------------------------------------------------------------------- errors -- */

/** Thrown by `proc_exit`. Callers should catch it around wasm entry points. */
export class WasiExit extends Error {
  readonly code: number
  constructor(code: number) {
    super(`WASI proc_exit(${code})`)
    this.name = 'WasiExit'
    this.code = code
  }
}

/** Internal control-flow error carrying a WASI errno. Never escapes a syscall. */
class WasiError extends Error {
  readonly errno: number
  constructor(errno: number) {
    super(`WASI errno ${errno}`)
    this.name = 'WasiError'
    this.errno = errno
  }
}

/* -------------------------------------------------------------------- MemFS -- */

interface FileNode {
  readonly kind: 'file'
  /** Backing store; may be larger than `size` (capacity for cheap appends). */
  buffer: Uint8Array
  size: number
  mtime: bigint
}

interface DirNode {
  readonly kind: 'dir'
  mtime: bigint
}

type Node = FileNode | DirNode

function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n
}

/**
 * Normalise a POSIX path to an absolute, `.`/`..`-free form with no trailing slash
 * (except the root, which is `'/'`). Relative input is resolved against `base`.
 */
export function normalizePath(path: string, base = '/'): string {
  const raw = path.startsWith('/') ? path : `${base}/${path}`
  const out: string[] = []
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return `/${out.join('/')}`.replace(/\/+$/, '') || '/'
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  if (i <= 0) return '/'
  return path.slice(0, i)
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** In-memory file system: a flat `Map` of absolute path -> file or directory node. */
export class MemFS {
  private readonly nodes = new Map<string, Node>()

  constructor() {
    this.nodes.set('/', { kind: 'dir', mtime: nowNs() })
  }

  /** Write (creating or replacing) a regular file, creating parent directories. */
  writeFile(path: string, data: Uint8Array): void {
    const p = normalizePath(path)
    if (p === '/') throw new Error('MemFS.writeFile: cannot write to the root directory')
    this.mkdirp(dirname(p))
    const copy = new Uint8Array(data.length)
    copy.set(data)
    this.nodes.set(p, { kind: 'file', buffer: copy, size: copy.length, mtime: nowNs() })
  }

  /** Read a regular file, or `undefined` if it is missing or is a directory. */
  readFile(path: string): Uint8Array | undefined {
    const node = this.nodes.get(normalizePath(path))
    if (!node || node.kind !== 'file') return undefined
    return node.buffer.slice(0, node.size)
  }

  exists(path: string): boolean {
    return this.nodes.has(normalizePath(path))
  }

  isDirectory(path: string): boolean {
    return this.nodes.get(normalizePath(path))?.kind === 'dir'
  }

  /** Remove a file, or an empty directory. Removing a missing path is a no-op. */
  remove(path: string): void {
    const p = normalizePath(path)
    if (p === '/') throw new Error('MemFS.remove: cannot remove the root directory')
    const node = this.nodes.get(p)
    if (!node) return
    if (node.kind === 'dir' && this.list(p).length > 0) {
      throw new Error(`MemFS.remove: directory not empty: ${p}`)
    }
    this.nodes.delete(p)
  }

  /** Direct children (base names) of a directory, sorted. */
  list(dir: string): string[] {
    const p = normalizePath(dir)
    const prefix = p === '/' ? '/' : `${p}/`
    const out: string[] = []
    for (const key of this.nodes.keys()) {
      if (key === p || !key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      if (rest.length > 0 && !rest.includes('/')) out.push(rest)
    }
    return out.sort()
  }

  /** Create a directory and every missing parent. */
  mkdirp(path: string): void {
    const p = normalizePath(path)
    const parts = p === '/' ? [] : p.slice(1).split('/')
    let cur = ''
    for (const part of parts) {
      cur += `/${part}`
      const existing = this.nodes.get(cur)
      if (existing) {
        if (existing.kind !== 'dir') throw new Error(`MemFS.mkdirp: not a directory: ${cur}`)
        continue
      }
      this.nodes.set(cur, { kind: 'dir', mtime: nowNs() })
    }
  }

  /* --- internals used by the Wasi syscalls (kept out of the public contract) --- */

  /** @internal */
  getNode(path: string): Node | undefined {
    return this.nodes.get(normalizePath(path))
  }

  /** @internal */
  createFile(path: string): FileNode {
    const p = normalizePath(path)
    const parent = this.nodes.get(dirname(p))
    if (!parent || parent.kind !== 'dir') throw new WasiError(ERRNO.NOENT)
    const node: FileNode = { kind: 'file', buffer: new Uint8Array(0), size: 0, mtime: nowNs() }
    this.nodes.set(p, node)
    return node
  }

  /** @internal */
  createDirectory(path: string): void {
    const p = normalizePath(path)
    if (this.nodes.has(p)) throw new WasiError(ERRNO.EXIST)
    const parent = this.nodes.get(dirname(p))
    if (!parent || parent.kind !== 'dir') throw new WasiError(ERRNO.NOENT)
    this.nodes.set(p, { kind: 'dir', mtime: nowNs() })
  }

  /** @internal */
  unlink(path: string, expectDirectory: boolean): void {
    const p = normalizePath(path)
    const node = this.nodes.get(p)
    if (!node) throw new WasiError(ERRNO.NOENT)
    if (expectDirectory) {
      if (node.kind !== 'dir') throw new WasiError(ERRNO.NOTDIR)
      if (this.list(p).length > 0) throw new WasiError(ERRNO.NOTEMPTY)
    } else if (node.kind === 'dir') {
      throw new WasiError(ERRNO.ISDIR)
    }
    this.nodes.delete(p)
  }

  /** @internal Rename a file or a whole directory subtree. */
  rename(from: string, to: string): void {
    const a = normalizePath(from)
    const b = normalizePath(to)
    if (a === b) return
    const node = this.nodes.get(a)
    if (!node) throw new WasiError(ERRNO.NOENT)
    const parent = this.nodes.get(dirname(b))
    if (!parent || parent.kind !== 'dir') throw new WasiError(ERRNO.NOENT)
    const moves: Array<[string, string]> = [[a, b]]
    if (node.kind === 'dir') {
      const prefix = a === '/' ? '/' : `${a}/`
      for (const key of this.nodes.keys()) {
        if (key !== a && key.startsWith(prefix)) moves.push([key, b + key.slice(a.length)])
      }
    }
    for (const [src, dst] of moves) {
      const n = this.nodes.get(src)
      if (n) {
        this.nodes.delete(src)
        this.nodes.set(dst, n)
      }
    }
  }
}

/** Grow a file node's backing buffer so it can hold at least `needed` bytes. */
function ensureCapacity(node: FileNode, needed: number): void {
  if (node.buffer.length >= needed) return
  const grown = new Uint8Array(Math.max(needed, node.buffer.length * 2, 1024))
  grown.set(node.buffer.subarray(0, node.size))
  node.buffer = grown
}

/* ------------------------------------------------------------------ options -- */

export interface WasiOptions {
  fs?: MemFS
  args?: string[]
  env?: Record<string, string>
  /** Receives whole lines written to fd 1 (newline stripped). Default: `console.log`. */
  stdout?: (text: string) => void
  /** Receives whole lines written to fd 2 (newline stripped). Default: `console.error`. */
  stderr?: (text: string) => void
  /** Guest path -> MemFS directory. Default `{ '/': '/' }`. */
  preopens?: Record<string, string>
  /** Log a `console.warn` the first time an unimplemented syscall is actually called. */
  debug?: boolean
}

/* --------------------------------------------------------------- descriptors -- */

interface FdEntry {
  kind: 'stdin' | 'stdout' | 'stderr' | 'file' | 'dir'
  /** MemFS path (file/dir entries only). */
  path: string
  /** Guest-visible preopen name, for `fd_prestat_dir_name`. */
  preopen?: string
  /** MemFS path the preopen is rooted at; paths may not escape it. */
  root?: string
  offset: number
  fdflags: number
  rightsBase: bigint
  rightsInheriting: bigint
}

/* --------------------------------------------------------------------- Wasi -- */

export class Wasi {
  readonly fs: MemFS

  private readonly argv: string[]
  private readonly envPairs: string[]
  private readonly onStdout: (text: string) => void
  private readonly onStderr: (text: string) => void
  private readonly preopens: Record<string, string>
  private readonly debug: boolean

  private memory: WebAssembly.Memory | undefined
  private readonly fds = new Map<number, FdEntry>()
  private nextFd = 3
  private readonly lineBuffers: Record<number, string> = { 1: '', 2: '' }
  /**
   * One streaming decoder per stdio fd: a multi-byte UTF-8 sequence may be split across
   * two `fd_write` calls (stdio buffers are byte-sized), and a non-streaming decode would
   * turn each half into U+FFFD.
   */
  private readonly stdDecoders: Record<1 | 2, TextDecoder> = {
    1: new TextDecoder(),
    2: new TextDecoder(),
  }
  private readonly warned = new Set<string>()
  private readonly timeOrigin = Date.now()
  private readonly perfOrigin =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : 0

  constructor(opts: WasiOptions = {}) {
    this.fs = opts.fs ?? new MemFS()
    this.argv = opts.args ?? ['magick']
    this.envPairs = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`)
    this.onStdout = opts.stdout ?? ((t) => console.log(t))
    this.onStderr = opts.stderr ?? ((t) => console.error(t))
    this.preopens = opts.preopens ?? { '/': '/' }
    this.debug = opts.debug ?? false

    this.fds.set(0, this.stdEntry('stdin'))
    this.fds.set(1, this.stdEntry('stdout'))
    this.fds.set(2, this.stdEntry('stderr'))

    for (const [guest, host] of Object.entries(this.preopens)) {
      const root = normalizePath(host)
      this.fs.mkdirp(root)
      const fd = this.nextFd++
      this.fds.set(fd, {
        kind: 'dir',
        path: root,
        preopen: normalizePath(guest),
        root,
        offset: 0,
        fdflags: 0,
        rightsBase: RIGHTS_DIR,
        rightsInheriting: RIGHTS_DIR | RIGHTS_FILE,
      })
    }
  }

  private stdEntry(kind: 'stdin' | 'stdout' | 'stderr'): FdEntry {
    return {
      kind,
      path: '',
      offset: 0,
      fdflags: 0,
      rightsBase: RIGHTS_TTY,
      rightsInheriting: 0n,
    }
  }

  /* ------------------------------------------------------------ memory views -- */

  private u8(): Uint8Array {
    if (!this.memory) throw new Error('Wasi: memory is not bound; call initialize() first')
    return new Uint8Array(this.memory.buffer)
  }

  private dv(): DataView {
    if (!this.memory) throw new Error('Wasi: memory is not bound; call initialize() first')
    return new DataView(this.memory.buffer)
  }

  private readString(ptr: number, len: number): string {
    return decoder.decode(this.u8().slice(ptr, ptr + len))
  }

  /* -------------------------------------------------------------- lifecycle -- */

  /**
   * Import object for `module`. Contains an entry for every function `module` imports
   * (real implementation where we have one, `ENOSYS` stub otherwise), so instantiation
   * can never fail on a missing import.
   */
  imports(module: WebAssembly.Module): WebAssembly.Imports {
    const real = this.syscalls()
    const result: WebAssembly.Imports = {}
    for (const desc of WebAssembly.Module.imports(module)) {
      const ns = (result[desc.module] ??= {}) as Record<string, WebAssembly.ImportValue>
      if (desc.name in ns) continue
      if (desc.kind !== 'function') {
        // Nothing sensible to fabricate for a global/table/memory import; leaving it out
        // makes instantiation throw with a clear "incompatible import type" message.
        continue
      }
      const impl = desc.module === 'wasi_snapshot_preview1' || desc.module === 'wasi_unstable'
        ? real[desc.name]
        : undefined
      ns[desc.name] = impl ?? this.stub(`${desc.module}.${desc.name}`)
    }
    // Guarantee the namespace exists even for a module that imports nothing.
    result['wasi_snapshot_preview1'] ??= {}
    return result
  }

  /** Bind the instance's memory and run the reactor's `_initialize`, if present. */
  initialize(instance: WebAssembly.Instance): void {
    const exports = instance.exports as Record<string, unknown>
    const memory = exports['memory']
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new Error('Wasi.initialize: the instance does not export `memory`')
    }
    this.memory = memory
    const init = exports['_initialize']
    if (typeof init === 'function') (init as () => void)()
  }

  /** Flush any partial stdout/stderr line that has no trailing newline yet. */
  flush(): void {
    for (const fd of [1, 2] as const) {
      // Terminate the streaming decode so a trailing partial sequence is emitted too.
      const pending = this.lineBuffers[fd] + this.stdDecoders[fd].decode()
      if (pending) {
        this.lineBuffers[fd] = ''
        ;(fd === 1 ? this.onStdout : this.onStderr)(pending)
      }
    }
  }

  private stub(name: string): (...args: unknown[]) => number {
    return (..._args: unknown[]) => {
      if (this.debug && !this.warned.has(name)) {
        this.warned.add(name)
        console.warn(`[wasi] unimplemented syscall ${name}() -> ENOSYS`)
      }
      return ERRNO.NOSYS
    }
  }

  /* ------------------------------------------------------------- fd helpers -- */

  private entry(fd: number): FdEntry {
    const e = this.fds.get(fd)
    if (!e) throw new WasiError(ERRNO.BADF)
    return e
  }

  private fileNode(entry: FdEntry): FileNode {
    const node = this.fs.getNode(entry.path)
    if (!node) throw new WasiError(ERRNO.NOENT)
    if (node.kind !== 'file') throw new WasiError(ERRNO.ISDIR)
    return node
  }

  /** Resolve `path` relative to the directory `fd`, refusing to escape its preopen root. */
  private resolve(fd: number, path: string): string {
    const entry = this.entry(fd)
    if (entry.kind !== 'dir') throw new WasiError(ERRNO.NOTDIR)
    const resolved = normalizePath(path, entry.path)
    const root = entry.root ?? '/'
    if (root !== '/' && resolved !== root && !resolved.startsWith(`${root}/`)) {
      throw new WasiError(ERRNO.NOTCAPABLE)
    }
    return resolved
  }

  /** Scatter/gather helper: the total of an iovec array. */
  private iovecs(ptr: number, count: number): Array<{ buf: number; len: number }> {
    const view = this.dv()
    const out: Array<{ buf: number; len: number }> = []
    for (let i = 0; i < count; i++) {
      out.push({
        buf: view.getUint32(ptr + i * 8, true),
        len: view.getUint32(ptr + i * 8 + 4, true),
      })
    }
    return out
  }

  private writeStd(fd: 1 | 2, bytes: Uint8Array): void {
    const sink = fd === 1 ? this.onStdout : this.onStderr
    let text = this.lineBuffers[fd] + this.stdDecoders[fd].decode(bytes, { stream: true })
    let nl = text.indexOf('\n')
    while (nl >= 0) {
      sink(text.slice(0, nl))
      text = text.slice(nl + 1)
      nl = text.indexOf('\n')
    }
    this.lineBuffers[fd] = text
  }

  private writeFilestat(ptr: number, path: string, node: Node): void {
    const view = this.dv()
    // filestat: dev u64 @0, ino u64 @8, filetype u8 @16, nlink u64 @24, size u64 @32,
    //           atim u64 @40, mtim u64 @48, ctim u64 @56  (64 bytes)
    view.setBigUint64(ptr, 1n, true)
    view.setBigUint64(ptr + 8, inode(path), true)
    view.setUint8(ptr + 16, node.kind === 'dir' ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE)
    view.setBigUint64(ptr + 24, 1n, true)
    view.setBigUint64(ptr + 32, node.kind === 'file' ? BigInt(node.size) : 0n, true)
    view.setBigUint64(ptr + 40, node.mtime, true)
    view.setBigUint64(ptr + 48, node.mtime, true)
    view.setBigUint64(ptr + 56, node.mtime, true)
  }

  private clockNs(id: number): bigint {
    if (id === CLOCKID.REALTIME) return BigInt(Date.now()) * 1_000_000n
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return BigInt(Math.round((performance.now() - this.perfOrigin) * 1e6))
    }
    return BigInt(Date.now() - this.timeOrigin) * 1_000_000n
  }

  /* --------------------------------------------------------------- syscalls -- */

  /** Wrap a syscall body so a thrown `WasiError` becomes its errno. */
  private guard(fn: () => number): number {
    try {
      return fn()
    } catch (err) {
      if (err instanceof WasiError) return err.errno
      if (err instanceof WasiExit) throw err
      if (this.debug) console.warn('[wasi] syscall threw', err)
      return ERRNO.IO
    }
  }

  private syscalls(): Record<string, (...args: never[]) => unknown> {
    const self = this
    return {
      args_get(argvPtr: number, argvBufPtr: number): number {
        return self.guard(() => writeStringArray(self, self.argv, argvPtr, argvBufPtr))
      },
      args_sizes_get(countPtr: number, bufSizePtr: number): number {
        return self.guard(() => writeStringArraySizes(self, self.argv, countPtr, bufSizePtr))
      },
      environ_get(envPtr: number, envBufPtr: number): number {
        return self.guard(() => writeStringArray(self, self.envPairs, envPtr, envBufPtr))
      },
      environ_sizes_get(countPtr: number, bufSizePtr: number): number {
        return self.guard(() => writeStringArraySizes(self, self.envPairs, countPtr, bufSizePtr))
      },

      clock_res_get(id: number, out: number): number {
        return self.guard(() => {
          if (id > CLOCKID.THREAD_CPUTIME) return ERRNO.INVAL
          // Must not overstate what clock_time_get delivers: REALTIME is Date.now()
          // (1 ms); the others come from performance.now() (1 µs is a safe floor).
          self.dv().setBigUint64(out, id === CLOCKID.REALTIME ? 1_000_000n : 1000n, true)
          return ERRNO.SUCCESS
        })
      },
      clock_time_get(id: number, _precision: bigint, out: number): number {
        return self.guard(() => {
          if (id > CLOCKID.THREAD_CPUTIME) return ERRNO.INVAL
          self.dv().setBigUint64(out, self.clockNs(id), true)
          return ERRNO.SUCCESS
        })
      },

      fd_close(fd: number): number {
        return self.guard(() => {
          const entry = self.entry(fd)
          if (entry.preopen !== undefined) return ERRNO.NOTSUP
          self.fds.delete(fd)
          return ERRNO.SUCCESS
        })
      },

      fd_fdstat_get(fd: number, out: number): number {
        return self.guard(() => {
          const entry = self.entry(fd)
          const view = self.dv()
          // fdstat: filetype u8 @0, fdflags u16 @2, rights_base u64 @8, rights_inheriting u64 @16
          const filetype =
            entry.kind === 'dir'
              ? FILETYPE.DIRECTORY
              : entry.kind === 'file'
                ? FILETYPE.REGULAR_FILE
                : FILETYPE.CHARACTER_DEVICE
          view.setUint8(out, filetype)
          view.setUint8(out + 1, 0)
          view.setUint16(out + 2, entry.fdflags, true)
          view.setUint32(out + 4, 0, true)
          view.setBigUint64(out + 8, entry.rightsBase, true)
          view.setBigUint64(out + 16, entry.rightsInheriting, true)
          return ERRNO.SUCCESS
        })
      },
      fd_fdstat_set_flags(fd: number, flags: number): number {
        return self.guard(() => {
          self.entry(fd).fdflags = flags & 0xffff
          return ERRNO.SUCCESS
        })
      },
      fd_fdstat_set_rights(fd: number, base: bigint, inheriting: bigint): number {
        return self.guard(() => {
          const entry = self.entry(fd)
          // Rights may only be narrowed.
          if ((base & ~entry.rightsBase) !== 0n) return ERRNO.NOTCAPABLE
          entry.rightsBase = base
          entry.rightsInheriting = inheriting
          return ERRNO.SUCCESS
        })
      },

      fd_filestat_get(fd: number, out: number): number {
        return self.guard(() => {
          const entry = self.entry(fd)
          if (entry.kind === 'file' || entry.kind === 'dir') {
            const node = self.fs.getNode(entry.path)
            if (!node) return ERRNO.NOENT
            self.writeFilestat(out, entry.path, node)
          } else {
            const view = self.dv()
            for (let i = 0; i < 64; i += 8) view.setBigUint64(out + i, 0n, true)
            view.setUint8(out + 16, FILETYPE.CHARACTER_DEVICE)
          }
          return ERRNO.SUCCESS
        })
      },
      fd_filestat_set_size(fd: number, size: bigint): number {
        return self.guard(() => {
          const node = self.fileNode(self.entry(fd))
          const n = Number(size)
          ensureCapacity(node, n)
          if (n > node.size) node.buffer.fill(0, node.size, n)
          node.size = n
          node.mtime = nowNs()
          return ERRNO.SUCCESS
        })
      },
      fd_filestat_set_times(fd: number, _atim: bigint, mtim: bigint, flags: number): number {
        return self.guard(() => {
          const entry = self.entry(fd)
          const node = self.fs.getNode(entry.path)
          if (!node) return ERRNO.BADF
          // bit 2 = MTIM, bit 3 = MTIM_NOW
          if (flags & 0b0100) node.mtime = mtim
          else if (flags & 0b1000) node.mtime = nowNs()
          return ERRNO.SUCCESS
        })
      },

      fd_read(fd: number, iovs: number, iovsLen: number, nreadPtr: number): number {
        return self.guard(() => {
          const entry = self.entry(fd)
          if (entry.kind === 'stdin') {
            self.dv().setUint32(nreadPtr, 0, true) // stdin is always at EOF
            return ERRNO.SUCCESS
          }
          const read = self.readInto(entry, self.iovecs(iovs, iovsLen), entry.offset)
          entry.offset += read
          self.dv().setUint32(nreadPtr, read, true)
          return ERRNO.SUCCESS
        })
      },
      fd_pread(fd: number, iovs: number, iovsLen: number, offset: bigint, nreadPtr: number): number {
        return self.guard(() => {
          const entry = self.entry(fd)
          if (entry.kind !== 'file') return ERRNO.SPIPE
          const read = self.readInto(entry, self.iovecs(iovs, iovsLen), Number(offset))
          self.dv().setUint32(nreadPtr, read, true)
          return ERRNO.SUCCESS
        })
      },

      fd_write(fd: number, iovs: number, iovsLen: number, nwrittenPtr: number): number {
        return self.guard(() => {
          const entry = self.entry(fd)
          const vecs = self.iovecs(iovs, iovsLen)
          if (entry.kind === 'stdout' || entry.kind === 'stderr') {
            let total = 0
            for (const v of vecs) {
              if (v.len === 0) continue
              self.writeStd(entry.kind === 'stdout' ? 1 : 2, self.u8().slice(v.buf, v.buf + v.len))
              total += v.len
            }
            self.dv().setUint32(nwrittenPtr, total, true)
            return ERRNO.SUCCESS
          }
          if (entry.kind === 'stdin') return ERRNO.BADF
          const node = self.fileNode(entry)
          const at = entry.fdflags & FDFLAGS.APPEND ? node.size : entry.offset
          const written = self.writeFrom(node, vecs, at)
          entry.offset = at + written
          self.dv().setUint32(nwrittenPtr, written, true)
          return ERRNO.SUCCESS
        })
      },
      fd_pwrite(
        fd: number,
        iovs: number,
        iovsLen: number,
        offset: bigint,
        nwrittenPtr: number,
      ): number {
        return self.guard(() => {
          const entry = self.entry(fd)
          if (entry.kind !== 'file') return ERRNO.SPIPE
          const written = self.writeFrom(
            self.fileNode(entry),
            self.iovecs(iovs, iovsLen),
            Number(offset),
          )
          self.dv().setUint32(nwrittenPtr, written, true)
          return ERRNO.SUCCESS
        })
      },

      fd_seek(fd: number, offset: bigint, whence: number, newOffsetPtr: number): number {
        return self.guard(() => {
          const entry = self.entry(fd)
          if (entry.kind !== 'file') return ERRNO.SPIPE
          const node = self.fileNode(entry)
          let next: number
          switch (whence) {
            case WHENCE.SET:
              next = Number(offset)
              break
            case WHENCE.CUR:
              next = entry.offset + Number(offset)
              break
            case WHENCE.END:
              next = node.size + Number(offset)
              break
            default:
              return ERRNO.INVAL
          }
          if (next < 0) return ERRNO.INVAL
          entry.offset = next
          self.dv().setBigUint64(newOffsetPtr, BigInt(next), true)
          return ERRNO.SUCCESS
        })
      },
      fd_tell(fd: number, out: number): number {
        return self.guard(() => {
          const entry = self.entry(fd)
          if (entry.kind !== 'file') return ERRNO.SPIPE
          self.dv().setBigUint64(out, BigInt(entry.offset), true)
          return ERRNO.SUCCESS
        })
      },
      fd_sync(fd: number): number {
        return self.guard(() => {
          self.entry(fd)
          self.flush()
          return ERRNO.SUCCESS
        })
      },
      fd_datasync(fd: number): number {
        return self.guard(() => {
          self.entry(fd)
          return ERRNO.SUCCESS
        })
      },
      fd_advise(fd: number): number {
        return self.guard(() => {
          self.entry(fd)
          return ERRNO.SUCCESS
        })
      },
      fd_allocate(fd: number, offset: bigint, len: bigint): number {
        return self.guard(() => {
          const node = self.fileNode(self.entry(fd))
          const end = Number(offset) + Number(len)
          if (end > node.size) {
            ensureCapacity(node, end)
            node.buffer.fill(0, node.size, end)
            node.size = end
          }
          return ERRNO.SUCCESS
        })
      },

      fd_prestat_get(fd: number, out: number): number {
        return self.guard(() => {
          const entry = self.fds.get(fd)
          if (!entry || entry.preopen === undefined) return ERRNO.BADF
          const view = self.dv()
          // prestat: tag u8 @0 (0 = dir), pr_name_len u32 @4
          view.setUint8(out, 0)
          view.setUint32(out + 4, encoder.encode(entry.preopen).length, true)
          return ERRNO.SUCCESS
        })
      },
      fd_prestat_dir_name(fd: number, pathPtr: number, pathLen: number): number {
        return self.guard(() => {
          const entry = self.fds.get(fd)
          if (!entry || entry.preopen === undefined) return ERRNO.BADF
          const bytes = encoder.encode(entry.preopen)
          if (bytes.length > pathLen) return ERRNO.NAMETOOLONG
          self.u8().set(bytes, pathPtr)
          return ERRNO.SUCCESS
        })
      },

      fd_readdir(fd: number, buf: number, bufLen: number, cookie: bigint, usedPtr: number): number {
        return self.guard(() => {
          const entry = self.entry(fd)
          if (entry.kind !== 'dir') return ERRNO.NOTDIR
          const names = ['.', '..', ...self.fs.list(entry.path)]
          let offset = 0
          for (let i = Number(cookie); i < names.length; i++) {
            const name = names[i]!
            const nameBytes = encoder.encode(name)
            const full = self.fs.getNode(
              name === '.' ? entry.path : name === '..' ? dirname(entry.path) : `${entry.path}/${name}`,
            )
            // dirent: d_next u64 @0, d_ino u64 @8, d_namlen u32 @16, d_type u8 @20 (24 bytes)
            if (offset + 24 > bufLen) break
            const view = self.dv()
            view.setBigUint64(buf + offset, BigInt(i + 1), true)
            view.setBigUint64(buf + offset + 8, inode(`${entry.path}/${name}`), true)
            view.setUint32(buf + offset + 16, nameBytes.length, true)
            view.setUint8(
              buf + offset + 20,
              !full || full.kind === 'dir' ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE,
            )
            offset += 24
            const n = Math.min(nameBytes.length, bufLen - offset)
            if (n > 0) self.u8().set(nameBytes.subarray(0, n), buf + offset)
            offset += nameBytes.length
            if (offset >= bufLen) {
              offset = bufLen
              break
            }
          }
          self.dv().setUint32(usedPtr, Math.min(offset, bufLen), true)
          return ERRNO.SUCCESS
        })
      },

      path_open(
        dirfd: number,
        _dirflags: number,
        pathPtr: number,
        pathLen: number,
        oflags: number,
        rightsBase: bigint,
        rightsInheriting: bigint,
        fdflags: number,
        outFd: number,
      ): number {
        return self.guard(() => {
          const path = self.resolve(dirfd, self.readString(pathPtr, pathLen))
          let node = self.fs.getNode(path)
          if (node && oflags & OFLAGS.EXCL && oflags & OFLAGS.CREAT) return ERRNO.EXIST
          if (!node) {
            if (!(oflags & OFLAGS.CREAT)) return ERRNO.NOENT
            if (oflags & OFLAGS.DIRECTORY) return ERRNO.NOENT
            node = self.fs.createFile(path)
          }
          if (oflags & OFLAGS.DIRECTORY && node.kind !== 'dir') return ERRNO.NOTDIR
          if (node.kind === 'file' && oflags & OFLAGS.TRUNC) {
            node.size = 0
            node.mtime = nowNs()
          }
          const parent = self.entry(dirfd)
          const fd = self.nextFd++
          self.fds.set(fd, {
            kind: node.kind === 'dir' ? 'dir' : 'file',
            path,
            root: parent.root,
            offset: 0,
            fdflags: fdflags & 0xffff,
            rightsBase: rightsBase === 0n ? (node.kind === 'dir' ? RIGHTS_DIR : RIGHTS_FILE) : rightsBase,
            rightsInheriting,
          })
          self.dv().setUint32(outFd, fd, true)
          return ERRNO.SUCCESS
        })
      },

      path_filestat_get(
        dirfd: number,
        _flags: number,
        pathPtr: number,
        pathLen: number,
        out: number,
      ): number {
        return self.guard(() => {
          const path = self.resolve(dirfd, self.readString(pathPtr, pathLen))
          const node = self.fs.getNode(path)
          if (!node) return ERRNO.NOENT
          self.writeFilestat(out, path, node)
          return ERRNO.SUCCESS
        })
      },
      path_filestat_set_times(
        dirfd: number,
        _flags: number,
        pathPtr: number,
        pathLen: number,
        _atim: bigint,
        mtim: bigint,
        fstflags: number,
      ): number {
        return self.guard(() => {
          const node = self.fs.getNode(self.resolve(dirfd, self.readString(pathPtr, pathLen)))
          if (!node) return ERRNO.NOENT
          if (fstflags & 0b0100) node.mtime = mtim
          else if (fstflags & 0b1000) node.mtime = nowNs()
          return ERRNO.SUCCESS
        })
      },
      path_create_directory(dirfd: number, pathPtr: number, pathLen: number): number {
        return self.guard(() => {
          self.fs.createDirectory(self.resolve(dirfd, self.readString(pathPtr, pathLen)))
          return ERRNO.SUCCESS
        })
      },
      path_remove_directory(dirfd: number, pathPtr: number, pathLen: number): number {
        return self.guard(() => {
          self.fs.unlink(self.resolve(dirfd, self.readString(pathPtr, pathLen)), true)
          return ERRNO.SUCCESS
        })
      },
      path_unlink_file(dirfd: number, pathPtr: number, pathLen: number): number {
        return self.guard(() => {
          self.fs.unlink(self.resolve(dirfd, self.readString(pathPtr, pathLen)), false)
          return ERRNO.SUCCESS
        })
      },
      path_rename(
        oldFd: number,
        oldPtr: number,
        oldLen: number,
        newFd: number,
        newPtr: number,
        newLen: number,
      ): number {
        return self.guard(() => {
          self.fs.rename(
            self.resolve(oldFd, self.readString(oldPtr, oldLen)),
            self.resolve(newFd, self.readString(newPtr, newLen)),
          )
          return ERRNO.SUCCESS
        })
      },

      poll_oneoff(inPtr: number, outPtr: number, nsubs: number, neventsPtr: number): number {
        return self.guard(() => self.pollOneoff(inPtr, outPtr, nsubs, neventsPtr))
      },

      proc_exit(code: number): never {
        self.flush()
        throw new WasiExit(code)
      },
      proc_raise(): number {
        return ERRNO.NOSYS
      },
      sched_yield(): number {
        return ERRNO.SUCCESS
      },

      random_get(buf: number, len: number): number {
        return self.guard(() => {
          const bytes = new Uint8Array(len)
          const c: Crypto | undefined = globalThis.crypto
          if (c && typeof c.getRandomValues === 'function') {
            // getRandomValues refuses more than 65536 bytes per call.
            for (let i = 0; i < len; i += 65536) {
              c.getRandomValues(bytes.subarray(i, Math.min(i + 65536, len)))
            }
          } else {
            for (let i = 0; i < len; i++) bytes[i] = (Math.random() * 256) | 0
          }
          self.u8().set(bytes, buf)
          return ERRNO.SUCCESS
        })
      },
    }
  }

  /* -------------------------------------------------------- syscall helpers -- */

  private readInto(
    entry: FdEntry,
    vecs: Array<{ buf: number; len: number }>,
    from: number,
  ): number {
    const node = this.fileNode(entry)
    let offset = from
    let total = 0
    for (const v of vecs) {
      if (offset >= node.size) break
      const n = Math.min(v.len, node.size - offset)
      if (n <= 0) continue
      // Snapshot the slice first: `u8()` must be re-derived because a prior iteration
      // could in principle have run through a growth point.
      const chunk = node.buffer.slice(offset, offset + n)
      this.u8().set(chunk, v.buf)
      offset += n
      total += n
    }
    return total
  }

  private writeFrom(
    node: FileNode,
    vecs: Array<{ buf: number; len: number }>,
    from: number,
  ): number {
    let offset = from
    let total = 0
    for (const v of vecs) {
      if (v.len === 0) continue
      const chunk = this.u8().slice(v.buf, v.buf + v.len)
      ensureCapacity(node, offset + v.len)
      if (offset > node.size) node.buffer.fill(0, node.size, offset)
      node.buffer.set(chunk, offset)
      offset += v.len
      total += v.len
      if (offset > node.size) node.size = offset
    }
    node.mtime = nowNs()
    return total
  }

  /**
   * `poll_oneoff` limited to sleeping, as the contract allows. Clock subscriptions are
   * honoured with a bounded busy-wait (there is no synchronous sleep on the web); fd
   * subscriptions report "ready" immediately, since our files never block.
   */
  private pollOneoff(inPtr: number, outPtr: number, nsubs: number, neventsPtr: number): number {
    const view = this.dv()
    let deadlineMs = 0
    // subscription (48 bytes): userdata u64 @0, tag u8 @8,
    //   clock { id u32 @16, timeout u64 @24, precision u64 @32, flags u16 @40 }
    //   fd_readwrite { fd u32 @16 }
    for (let i = 0; i < nsubs; i++) {
      const s = inPtr + i * 48
      if (view.getUint8(s + 8) !== EVENTTYPE.CLOCK) continue
      const id = view.getUint32(s + 16, true)
      const timeoutNs = view.getBigUint64(s + 24, true)
      const flags = view.getUint16(s + 40, true)
      const ms = Number(timeoutNs / 1_000_000n)
      const target =
        flags & SUBSCRIPTION_CLOCK_ABSTIME
          ? id === CLOCKID.REALTIME
            ? ms
            : Date.now() + (ms - Number(this.clockNs(id) / 1_000_000n))
          : Date.now() + ms
      deadlineMs = Math.max(deadlineMs, target)
    }
    // Bounded: a runaway timeout must not wedge the browser's main thread.
    const cap = Date.now() + 1000
    const until = Math.min(deadlineMs, cap)
    while (Date.now() < until) {
      /* spin */
    }

    let events = 0
    for (let i = 0; i < nsubs; i++) {
      const s = inPtr + i * 48
      const userdata = this.dv().getBigUint64(s, true)
      const tag = this.dv().getUint8(s + 8)
      const e = outPtr + events * 32
      // event (32 bytes): userdata u64 @0, errno u16 @8, type u8 @10,
      //   fd_readwrite { nbytes u64 @16, flags u16 @24 }
      const out = this.dv()
      out.setBigUint64(e, userdata, true)
      out.setUint16(e + 8, ERRNO.SUCCESS, true)
      out.setUint8(e + 10, tag)
      out.setBigUint64(e + 16, 0n, true)
      out.setUint16(e + 24, 0, true)
      events++
    }
    this.dv().setUint32(neventsPtr, events, true)
    return ERRNO.SUCCESS
  }
}

/* ------------------------------------------------------------------ helpers -- */

/** Stable-ish synthetic inode: a 64-bit FNV-1a of the path. */
function inode(path: string): bigint {
  let h = 0xcbf29ce484222325n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < path.length; i++) {
    h = (h ^ BigInt(path.charCodeAt(i))) & mask
    h = (h * 0x100000001b3n) & mask
  }
  return h
}

function writeStringArray(wasi: Wasi, values: string[], ptrArray: number, ptrBuf: number): number {
  // `wasi` private members are not reachable here, so go through the two tiny bridges
  // below that Wasi exposes to this module only.
  const mem = memoryOf(wasi)
  const view = new DataView(mem.buffer)
  const bytes = new Uint8Array(mem.buffer)
  let cursor = ptrBuf
  for (let i = 0; i < values.length; i++) {
    view.setUint32(ptrArray + i * 4, cursor, true)
    const encoded = encoder.encode(values[i]!)
    bytes.set(encoded, cursor)
    bytes[cursor + encoded.length] = 0
    cursor += encoded.length + 1
  }
  return ERRNO.SUCCESS
}

function writeStringArraySizes(
  wasi: Wasi,
  values: string[],
  countPtr: number,
  bufSizePtr: number,
): number {
  const view = new DataView(memoryOf(wasi).buffer)
  let size = 0
  for (const v of values) size += encoder.encode(v).length + 1
  view.setUint32(countPtr, values.length, true)
  view.setUint32(bufSizePtr, size, true)
  return ERRNO.SUCCESS
}

/** Module-private accessor for the bound memory (the field itself stays private). */
function memoryOf(wasi: Wasi): WebAssembly.Memory {
  const mem = (wasi as unknown as { memory: WebAssembly.Memory | undefined }).memory
  if (!mem) throw new Error('Wasi: memory is not bound; call initialize() first')
  return mem
}
