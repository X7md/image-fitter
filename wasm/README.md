# `wasm/` — ImageMagick 7 as a bare wasm32-wasip1 reactor

This directory builds `src/wasm/magick.wasm`: ImageMagick 7.1.2-31
(MagickCore + MagickWand + all static coders) compiled with **wasi-sdk**, with
**no Emscripten** and **no delegate libraries at all**.

The artifact is committed to git; everything needed to rebuild it bit-for-bit
is here. `wasm/ImageMagick/`, `wasm/out/` and `wasm/*.tar.gz` are gitignored.

```
build.sh          the whole build (Git Bash on Windows, or bash on Linux CI)
config/           the generated/hand-authored ImageMagick config headers
patches/          six minimal, __wasi__-guarded source patches
smoke.mjs         end-to-end test of the artifact via node:wasi
list-exports.mjs  prints a module's exports / import namespaces
exports.txt       symbols forced into the export table (input to build.sh)
```

## Rebuilding

```bash
bash wasm/build.sh                # incremental
bash wasm/build.sh --clean        # full rebuild  (~36 s on 16 cores)
bash wasm/build.sh --jobs 8
node wasm/smoke.mjs               # verify
```

`build.sh` finds the SDK in `$WASI_SDK`, else
`C:/wasi-sdk-33.0-x86_64-windows`, else `/opt/wasi-sdk`, else `~/wasi-sdk`.
It downloads and extracts the ImageMagick tarball if `wasm/ImageMagick/` is
missing, applies `patches/*.patch` (idempotently — a re-run reports "already
applied" and a patch that genuinely does not apply is a hard error), copies
`config/MagickCore/*` over the source tree, generates
`MagickCore/threshold-map.h`, compiles, links, strips and installs.

**`./configure` is not part of a normal build.** Its output is checked in under
`config/`. Use `bash wasm/build.sh --configure` to regenerate it (slow, ~10 min
under Git Bash); that refreshes `config/MagickCore/magick-baseconfig-configure.h`
and `config/MagickCore/version.h` and leaves the hand-authored overrides alone.

## Toolchain

| | |
|---|---|
| SDK | wasi-sdk 33.0 (`clang 22.1.0`) |
| Target | `wasm32-wasip1`, reactor (`-mexec-model=reactor`) |
| Source | ImageMagick 7.1.2-31 (GitHub release tarball) |
| Translation units | 264 (95 MagickCore + 23 MagickWand + 146 coders) |
| Artifact | `src/wasm/magick.wasm`, **2 511 086 bytes** (debug-stripped) |
| Exports | 54 (52 from `exports.txt` + `memory` + `_initialize`) |
| Imports | `wasi_snapshot_preview1` only — asserted by `build.sh` on every link |

### Compile flags

```
--target=wasm32-wasip1 -O2 -std=gnu11 -fno-strict-aliasing -fvisibility=default
-ffunction-sections -fdata-sections
-DHAVE_CONFIG_H
-DMAGICKCORE_HDRI_ENABLE=0 -DMAGICKCORE_QUANTUM_DEPTH=8
-DMAGICKCORE_CHANNEL_MASK_DEPTH=32
-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN
-D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID
-I.
```

Compiles run with `cwd = wasm/ImageMagick`, so `__FILE__` — which ImageMagick
bakes into every exception site through `GetMagickModule()` — is
`MagickCore/foo.c` and not the absolute checkout path. That is what makes the
artifact **byte-identical regardless of where the repository lives** (verified:
building the same tree from `C:/Users/.../image-fitter` and from a temp
directory produced identical files).

### Link flags

```
-mexec-model=reactor -O2
@objects.rsp                        # 264 objects; the command line is too long
-lwasi-emulated-signal -lwasi-emulated-mman
-lwasi-emulated-process-clocks -lwasi-emulated-getpid
-Wl,--export=<sym>                  # one per line of wasm/exports.txt
-Wl,--gc-sections
-Wl,--initial-memory=67108864       # 64 MiB
-Wl,--max-memory=2147483648         # 2 GiB, growable
-Wl,--stack-first                   # shadow stack low, so overflow traps
-Wl,-z,stack-size=1048576           # 1 MiB shadow stack (default is 64 KiB)
llvm-strip --strip-debug
```

The shadow stack size matters: with wasi-sdk's 64 KiB default, `ReadPNMImage`
(two `MagickPathExtent` = 4 KiB header buffers, then `SetImageExtent` →
`SyncImagePixelCache` → `OpenPixelCache`) overflows it and every PNM/PAM/PGM/
PPM/TXT read traps with "memory access out of bounds". A wasm trap also
leaves `__stack_pointer` where it was, so *every later call* into that
instance traps too — a trapped `Magick` must be thrown away, not retried.
1 MiB is the native default and costs nothing until it is used.

`llvm-strip --strip-debug` removes the DWARF sections but keeps the `name`
custom section (~37 KB), so browser devtools still show function names in a
trap's stack trace.

The response file holds **relative** object names and the link runs from
`wasm/out/`: MSYS translates `/c/...` paths in argv but *not* inside a response
file, so absolute names there would not resolve for the native `clang.exe`.

`--gc-sections` currently removes nothing measurable — `MagickCore/static.c`
holds a direct reference to every coder's `Register*`/`Unregister*` pair, which
keeps essentially the whole tree live. It is kept because it costs nothing.

## Configuration

`./configure` was run once, cross-compiling with the wasi-sdk clang:

```bash
CC="$WASI_SDK/bin/clang.exe --target=wasm32-wasip1" \
CFLAGS="-O2 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN \
        -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID" \
./configure --host=wasm32-wasi \
  --disable-shared --enable-static --disable-openmp --without-threads \
  --disable-docs --without-magick-plus-plus --without-perl --without-utilities \
  --enable-zero-configuration --with-quantum-depth=8 --disable-hdri \
  --without-modules --disable-installed --disable-dependency-tracking \
  --disable-assert --disable-cipher --disable-pipes --disable-largefile \
  --with-security-policy=open --without-x --without-gdi32 \
  --without-zlib --without-bzlib --without-lzma --without-zstd --without-zip \
  --without-png --without-jpeg --without-jxl --without-webp --without-tiff \
  --without-openjp2 --without-heic --without-raw --without-uhdr \
  --without-xml --without-fontconfig --without-freetype --without-raqm \
  --without-pango --without-rsvg --without-lcms --without-openexr \
  --without-djvu --without-fftw --without-flif --without-gslib --without-gvc \
  --without-jbig --without-lqr --without-dps --without-wmf --without-dmr \
  --without-fpx --without-autotrace \
  --without-jemalloc --without-tcmalloc --without-umem
```

It succeeded, and its `MagickCore/magick-baseconfig.h` is stored verbatim as
`config/MagickCore/magick-baseconfig-configure.h`.

Autoconf gets a number of answers wrong for a bare wasm reactor, though — its
`AC_CHECK_FUNCS` link probes see wasi-libc *declarations* and the emulation
libraries, not what we actually want to use. So
`config/MagickCore/magick-baseconfig.h` is **hand-authored**: it includes the
configure output and then corrects it. Every override is commented in the file;
in summary:

| Group | `#undef`'d | Why |
|---|---|---|
| mmap | `HAVE_MMAP`, `HAVE_MUNMAP`, `HAVE_SYS_MMAN_H`, `HAVE_MMAP_FILEIO` | `-lwasi-emulated-mman` is a malloc+pread emulation with no writeback; IM's memory-mapped disk cache would silently lose data |
| sockets | `DPC_SUPPORT`, `HAVE_SOCKET`, `HAVE_SYS_SOCKET_H`, `HAVE_NETINET_IN_H`, `HAVE_NETDB_H`, `HAVE_ARPA_INET_H`, `HAVE_SELECT`, `HAVE_POLL` | no sockets in preview1; compiles out the distributed pixel cache |
| processes | `HAVE_POPEN`, `HAVE_SYSTEM`, `HAVE_FORK`, `HAVE_VFORK`, `HAVE_EXECVP`, `HAVE_WAITPID`, `HAVE_SPAWNVP`, `HAVE_SYS_WAIT_H`, `HAVE_PROCESS_H` | no processes |
| threads | `THREAD_SUPPORT`, `HAVE_PTHREAD*`, `OPENMP_SUPPORT`, `HAVE_OPENMP` | single-threaded by design |
| modules | `BUILD_MODULES`, `HAVE_DLFCN_H`, `HAVE_DLOPEN` | static coders only |
| introspection | `HAVE_GETRUSAGE`, `HAVE_SYS_RESOURCE_H`, `HAVE_TIMES`, `HAVE_SYS_TIMES_H`, `HAVE_GETPWUID`, `HAVE_PWD_H`, `HAVE_SYSCONF`, `HAVE_GETPAGESIZE` | absent or meaningless under wasi |
| FS niceties | `HAVE_PUTENV`, `HAVE_SETENV`, `HAVE_REALPATH`, `HAVE_SYMLINK`, `HAVE_READLINK`, `HAVE_LSTAT`, `HAVE_UTIME`, `HAVE_UTIME_H` | wasi's capability FS rejects them |

It also blanks the install-path strings (`CONFIGURE_PATH`, `SHARE_PATH`, …):
MSYS mangled `C:\Program Files` into `C:\\Programusr\\local\\` in the configure
output, and zero-configuration mode never reads those paths anyway.

Finally it pins `MAGICKCORE_QUANTUM_DEPTH=8`, `MAGICKCORE_HDRI_ENABLE=0`,
`MAGICKCORE_CHANNEL_MASK_DEPTH=32` and `MAGICKCORE_ZERO_CONFIGURATION_SUPPORT`
so a stray compile can never pick a different pixel ABI.

### `MagickCore/threshold-map.h`

Zero-configuration `threshold.c` `#include`s this generated header. Upstream
produces it from a Makefile rule; we don't use the Makefile, so `build.sh`
reproduces that rule verbatim (turn `config/thresholds.xml` into a C string
literal).

## Patches

Six patches, all guarded with `#if defined(__wasi__)` (or the moral
equivalent), so none of them changes any other platform.

| Patch | What | Why |
|---|---|---|
| `0001-studio-no-process-headers` | `MagickCore/studio.h`: skip `<sys/wait.h>` and `<pwd.h>` | Both are included unconditionally in the POSIX branch and neither exists in wasi-libc, so **every** translation unit failed at `studio.h` |
| `0002-magickwand-studio-no-process-headers` | same, in `MagickWand/studio.h` | MagickWand has its own copy |
| `0003-utility-private-no-popen` | `popen_utf8()` returns `NULL` | `static inline` in a header everything includes, so its body must typecheck even though no caller is compiled; wasi-libc has no `popen` (it compiled as implicit `int`, returned as `FILE *`). `NULL` is the failure callers already handle |
| `0004-delegate-no-system` | `delegate.c`: add `__wasi__` to the existing `#define system(s) ((s)==NULL ? 0 : -1)` stub | Reuses ImageMagick's own iOS/Android "cannot run external programs" path. `ExternalDelegateCommand()` then collapses to a call that returns −1, so `InvokeDelegate()` raises an ordinary `DelegateError` exception |
| `0005-jpeg-setjmp-inside-delegate-guard` | `coders/jpeg.c`: move `#include <setjmp.h>` inside `#if defined(MAGICKCORE_JPEG_DELEGATE)` | wasm clang rejects `<setjmp.h>` without `-mllvm -wasm-enable-sjlj`; the include sat one line *above* the delegate guard, so even the delegate-free stub (just `RegisterJPEGImage`/`UnregisterJPEGImage`) would not build |
| `0006-utility-no-getpwnam` | `utility.c`: skip `~user/` expansion | Uses `getpwnam()`/`struct passwd`; wasi has no passwd database and no home directories, so leaving `~user/...` untouched is the correct behaviour |

**No coder was removed from the static coder list.** All 146 `coders/*.c`
compile; the ones whose delegate is absent reduce to their
`Register*`/`Unregister*` pair, which is upstream's design.

## What the module can and cannot do

`MagickQueryFormats("*")` reports **237** formats. The ones that actually work
are the delegate-free built-ins. Verified present:
**BMP**, BMP2, BMP3, **PNM**, **PAM**, PGM, PPM, PBM, **RGBA**, RGB, BGRA,
GRAY, GRAYA, **TXT**, MIFF, TGA, QOI, FARBFELD, plus the synthetic ones
(CANVAS, XC, GRADIENT, PATTERN, …). BMP is exercised end-to-end (encode to
blob, decode back, same dimensions) by `smoke.mjs`.

Formats whose coder registers *nothing* without its delegate do not appear in
the list at all — verified absent: **PNG, JPEG, WEBP, TIFF, JXL, HEIC, JP2,
ZIP/GZ**. Reading such a blob raises `NoDecodeDelegateForThisImageFormat`.
Others (SVG, PDF, PS, DNG, …) are listed but fail the same way when used,
because their work is done by an external program we cannot run.

All of that is intentional, per `ARCHITECTURE.md`: the browser decodes and
encodes PNG/JPEG, wasm only moves pixels.

Also not available, by design: threads/OpenMP, `setjmp`/`longjmp`, exceptions,
`mmap`, sockets and the distributed pixel cache, `system()`/`popen()`/`fork()`,
dynamic coder modules, X11, fonts/text rendering (no FreeType), colour
management (no LCMS).

### Resource limits

Defaults reported by `MagickGetResourceLimit` inside the module:

| Resource | Default |
|---|---|
| Area | 8 GiB |
| Memory | 2 GiB |
| Map | 4 GiB |
| Disk | **unlimited** |
| Width / Height | 33 554 431 |
| File | 64 |

`Disk` being unlimited matters: if an image ever exceeded the memory limit,
ImageMagick would spill its pixel cache to the WASI filesystem (i.e. into the
JS shim's MemFS). Callers that want to guarantee everything stays in linear
memory should call `MagickSetResourceLimit(DiskResource, 0)` and
`MagickSetResourceLimit(MapResource, 0)` right after `MagickWandGenesis()`
(`ResourceType`: Area 1, Disk 2, File 3, Height 4, Map 5, Memory 6, Thread 7,
Throttle 8, Time 9, Width 10, ListLength 11). `MagickSetResourceLimit` takes a
`MagickSizeType`, i.e. an **i64 — pass a BigInt from JS**.

## Where the enums actually live

`ARCHITECTURE.md` §3 lists the headers for `src/wasm/enums.ts`. One of them is
wrong, so for the record — these are the files in `wasm/ImageMagick/` that this
build was compiled from:

| Enum | Header | Notes |
|---|---|---|
| `StorageType` | `MagickCore/pixel.h:156` | contiguous from 0; `CharPixel = 1` |
| `FilterType` | `MagickCore/resample.h:34` | contiguous from 0; `LanczosFilter = 22` |
| `CompositeOperator` | `MagickCore/composite.h:27` | contiguous from 0; `OverCompositeOp = 54` |
| `AlphaChannelOption` | **`MagickCore/channel.h:28`** — *not* `image.h` | contiguous from 0; `Activate 1 … OffIfOpaque 16` |
| `ResourceType` | `MagickCore/resource_.h:27` | contiguous from 0; `Area 1 … ListLength 11` |
| `ExceptionType` | `MagickCore/exception.h` | **explicitly numbered, not contiguous** — `Warning 300`, `Error 400`, `MissingDelegateError 420`, `CorruptImageError 425`, `FatalError 700`, … Copy the literals |
| `GravityType` | `MagickCore/geometry.h:81` | `Forget/Undefined 0`, `NorthWest 1` … `SouthEast 9` |

The three ranges marked "contiguous" were checked line-by-line to contain
nothing but members (no gaps, comments or explicit values), and the values were
then confirmed at runtime by `smoke.mjs`.

## Performance envelope

Measured by `smoke.mjs` under Node 22 (`node:wasi`), 2000×1500 RGBA in, Q8:

| Step | Time |
|---|---|
| `MagickConstituteImage` 2000×1500 RGBA | 31 ms |
| `MagickResizeImage` → 1000×750, Lanczos | 460 ms |
| `MagickBlurImage(0, 10)` | 665 ms |
| `MagickExportImagePixels` 1000×750 RGBA | 5 ms |
| **total** | **≈ 1.17 s** |

Linear memory never grew past the initial 64 MiB for that pipeline. Blur and
Lanczos resize dominate; single-threaded wasm is roughly 3–5× slower than
native here.

## Smoke test

`node wasm/smoke.mjs` loads the artifact through **`node:wasi`** (deliberately
not through `src/wasm/wasi.ts`, so it tests the module independently of the
bindings layer) and checks the full lifecycle: genesis, wand/pixel-wand
creation, `MagickNewImage` + `MagickExportImagePixels` pixel values,
`MagickConstituteImage`, Lanczos resize, blur, `Over` composite, BMP blob
round-trip, exception text on a garbage blob, `MagickQueryFormats`, the version
string, resource limits, and the timing above.

It also captures WASI fd 1 and fd 2 into files and asserts both are **empty** —
the module produces no stdout/stderr noise during a normal run (no complaints
about missing `delegates.xml` / `policy.xml` / `configure.xml`, because
zero-configuration mode links those defaults in).

Node prints `ExperimentalWarning: WASI is an experimental feature`; that is the
only output on the host's own stderr and is expected.
