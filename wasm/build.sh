#!/usr/bin/env bash
#
# Build ImageMagick 7 (MagickCore + MagickWand + static coders) as a bare
# wasm32-wasip1 *reactor* module.  No Emscripten, no delegate libraries.
#
# Works from Git Bash on Windows and from bash on Linux CI.
#
#   ./build.sh                 incremental build (recompiles changed .c only)
#   ./build.sh --clean         wipe out/ first
#   ./build.sh --configure     re-run ./configure to regenerate wasm/config/*
#   ./build.sh --jobs 8        parallelism (default 16)
#
# Output: wasm/out/magick.wasm  ->  src/wasm/magick.wasm (+ src/wasm/exports.txt)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

IM_VERSION="${IM_VERSION:-7.1.2-31}"
IM_TARBALL="$HERE/ImageMagick-$IM_VERSION.tar.gz"
IM_URL="https://github.com/ImageMagick/ImageMagick/archive/refs/tags/$IM_VERSION.tar.gz"
SRC="$HERE/ImageMagick"
OUT="$HERE/out"
DEST="$ROOT/src/wasm"

JOBS=16
DO_CLEAN=0
DO_CONFIGURE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --clean)     DO_CLEAN=1 ;;
    --configure) DO_CONFIGURE=1 ;;
    --jobs)      JOBS="$2"; shift ;;
    --jobs=*)    JOBS="${1#--jobs=}" ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------- toolchain --
if [ -z "${WASI_SDK:-}" ]; then
  for candidate in \
      "C:/wasi-sdk-33.0-x86_64-windows" \
      "/c/wasi-sdk-33.0-x86_64-windows" \
      "/opt/wasi-sdk" \
      "$HOME/wasi-sdk"; do
    if [ -d "$candidate/bin" ]; then WASI_SDK="$candidate"; break; fi
  done
fi
: "${WASI_SDK:?set WASI_SDK to your wasi-sdk root (e.g. /opt/wasi-sdk)}"

EXE=""
[ -x "$WASI_SDK/bin/clang.exe" ] && EXE=".exe"
CC="$WASI_SDK/bin/clang$EXE"
STRIP="$WASI_SDK/bin/llvm-strip$EXE"
NM="$WASI_SDK/bin/llvm-nm$EXE"
TARGET="--target=wasm32-wasip1"

[ -x "$CC" ] || { echo "no clang at $CC" >&2; exit 1; }

echo "==> wasi-sdk : $WASI_SDK"
echo "==> clang    : $($CC --version | head -1)"

# ------------------------------------------------------------------ sources --
if [ ! -d "$SRC/MagickCore" ]; then
  if [ ! -f "$IM_TARBALL" ]; then
    echo "==> downloading $IM_URL"
    curl -fL --retry 3 -o "$IM_TARBALL" "$IM_URL"
  fi
  echo "==> extracting ImageMagick-$IM_VERSION"
  rm -rf "$SRC" "$HERE/ImageMagick-$IM_VERSION"
  tar -xzf "$IM_TARBALL" -C "$HERE"
  mv "$HERE/ImageMagick-$IM_VERSION" "$SRC"
fi

# ------------------------------------------------------------------ patches --
# Patches are idempotent: `patch` is run in dry-run first and skipped if the
# hunk is already applied.
shopt -s nullglob
for p in "$HERE"/patches/*.patch; do
  name="$(basename "$p")"
  if patch -p1 -d "$SRC" --dry-run --silent -N -i "$p" >/dev/null 2>&1; then
    echo "==> patch $name"
    patch -p1 -d "$SRC" --silent -N -i "$p"
  elif patch -p1 -d "$SRC" --dry-run --silent -R -i "$p" >/dev/null 2>&1; then
    echo "==> patch $name (already applied)"
  else
    echo "!!! patch $name does not apply:" >&2
    patch -p1 -d "$SRC" --dry-run -N -i "$p" >&2 || true
    exit 1
  fi
done
shopt -u nullglob

# ---------------------------------------------------------------- configure --
CONFIGURE_ARGS=(
  --host=wasm32-wasi
  --disable-shared --enable-static
  --disable-openmp --without-threads
  --disable-docs --without-magick-plus-plus --without-perl --without-utilities
  --enable-zero-configuration
  --with-quantum-depth=8 --disable-hdri
  --without-modules --disable-installed --disable-dependency-tracking
  --disable-assert --disable-cipher --disable-pipes --disable-largefile
  --with-security-policy=open
  --without-x --without-gdi32
  --without-zlib --without-bzlib --without-lzma --without-zstd --without-zip
  --without-png --without-jpeg --without-jxl --without-webp --without-tiff
  --without-openjp2 --without-heic --without-raw --without-uhdr
  --without-xml --without-fontconfig --without-freetype --without-raqm
  --without-pango --without-rsvg --without-lcms --without-openexr
  --without-djvu --without-fftw --without-flif --without-gslib --without-gvc
  --without-jbig --without-lqr --without-dps --without-wmf --without-dmr
  --without-fpx --without-autotrace
  --without-jemalloc --without-tcmalloc --without-umem
)
if [ "$DO_CONFIGURE" = 1 ]; then
  echo "==> running ./configure (slow: ~10 min under Git Bash)"
  ( cd "$SRC" && \
    CC="$CC $TARGET" \
    CFLAGS="-O2 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID" \
    ./configure "${CONFIGURE_ARGS[@]}" )
  cp "$SRC/MagickCore/magick-baseconfig.h" "$HERE/config/MagickCore/magick-baseconfig-configure.h"
  cp "$SRC/MagickCore/version.h"           "$HERE/config/MagickCore/version.h"
  echo "==> refreshed wasm/config/MagickCore/{magick-baseconfig-configure.h,version.h}"
  echo "    (wasm/config/MagickCore/magick-baseconfig.h is hand-authored; review it)"
fi

# --------------------------------------------------------- generated config --
# Copy our config headers over the source tree so the build reproduces without
# ever re-running configure.
cp "$HERE/config/MagickCore/magick-baseconfig-configure.h" "$SRC/MagickCore/"
cp "$HERE/config/MagickCore/magick-baseconfig.h"           "$SRC/MagickCore/"
cp "$HERE/config/MagickCore/version.h"                     "$SRC/MagickCore/"

# MagickCore/threshold-map.h is normally produced by a Makefile rule (we don't
# use the Makefile).  This is that rule verbatim: config/thresholds.xml turned
# into a C string literal, which threshold.c #includes in zero-configuration
# mode.
if [ ! -f "$SRC/MagickCore/threshold-map.h" ] || \
   [ "$SRC/config/thresholds.xml" -nt "$SRC/MagickCore/threshold-map.h" ]; then
  echo "==> generating MagickCore/threshold-map.h from config/thresholds.xml"
  {
    printf '%s\n  %s=\n' 'static const char *const' BuiltinMap
    sed -e 's/"/\\"/g; s/^.*$/    "&\\n"/; $s/$/;/' "$SRC/config/thresholds.xml"
  } > "$SRC/MagickCore/threshold-map.h"
fi

# ------------------------------------------------------------------- flags ---
CFLAGS=(
  "$TARGET"
  -O2
  -fno-strict-aliasing
  -fvisibility=default
  -std=gnu11
  # one section per symbol so the linker can --gc-sections away the ~200 coders
  # and MagickCore entry points nothing in the export list reaches.
  -ffunction-sections
  -fdata-sections
  -DHAVE_CONFIG_H
  -DMAGICKCORE_HDRI_ENABLE=0
  -DMAGICKCORE_QUANTUM_DEPTH=8
  -DMAGICKCORE_CHANNEL_MASK_DEPTH=32
  -D_WASI_EMULATED_SIGNAL
  -D_WASI_EMULATED_MMAN
  -D_WASI_EMULATED_PROCESS_CLOCKS
  -D_WASI_EMULATED_GETPID
  # Compiles run with cwd=$SRC (see compile_one) so that __FILE__ -- which
  # ImageMagick bakes into every exception site via GetMagickModule() -- is
  # "MagickCore/foo.c" rather than the absolute checkout path.  That keeps the
  # committed artifact byte-identical no matter where the repo lives.
  -I.
  -Wno-unused-command-line-argument
  -Wno-implicit-function-declaration
  -Wno-incompatible-pointer-types
)

LDLIBS=(
  -lwasi-emulated-signal
  -lwasi-emulated-mman
  -lwasi-emulated-process-clocks
  -lwasi-emulated-getpid
)

# ------------------------------------------------------------------ compile --
[ "$DO_CLEAN" = 1 ] && rm -rf "$OUT"
mkdir -p "$OUT" "$DEST"

list_sources() {
  # One path per line, relative to $SRC.  Object names are flattened with the
  # directory prefix because e.g. MagickCore/histogram.c and coders/histogram.c
  # would otherwise collide.
  ( cd "$SRC" && ls MagickCore/*.c MagickWand/*.c coders/*.c )
}

obj_for() { echo "$OUT/$(echo "$1" | tr '/' '_' | sed 's/\.c$/.o/')"; }

compile_one() {
  local rel="$1" obj
  obj="$(obj_for "$rel")"
  if [ -f "$obj" ] && [ "$obj" -nt "$SRC/$rel" ]; then
    return 0
  fi
  if ( cd "$SRC" && "$CC" "${CFLAGS[@]}" -c "$rel" -o "$obj" ) > "$obj.log" 2>&1; then
    rm -f "$obj.log"
  else
    echo "FAILED $rel" >&2
    return 1
  fi
}
export SRC OUT CC
export -f compile_one obj_for
export CFLAGS_STR="${CFLAGS[*]}"
# bash cannot export arrays; re-materialise inside the worker shell.
worker='CFLAGS=($CFLAGS_STR); compile_one "$1"'

SOURCES="$(list_sources)"
COUNT="$(echo "$SOURCES" | wc -l | tr -d ' ')"
echo "==> compiling $COUNT translation units with -P $JOBS"

set +e
echo "$SOURCES" | xargs -P "$JOBS" -I{} bash -c "$worker" _ {}
COMPILE_STATUS=$?
set -e

FAILED="$(ls "$OUT"/*.o.log 2>/dev/null || true)"
if [ -n "$FAILED" ]; then
  echo
  echo "!!! compile errors in $(echo "$FAILED" | wc -l | tr -d ' ') file(s):"
  for log in $FAILED; do
    echo "--- ${log##*/}"
    grep -E 'error:' "$log" | head -8
  done
  exit 1
fi
[ "$COMPILE_STATUS" -eq 0 ] || exit "$COMPILE_STATUS"

# --------------------------------------------------------------------- link --
EXPORT_FLAGS=()
while read -r sym; do
  sym="${sym%%#*}"
  sym="$(echo "$sym" | tr -d '[:space:]')"
  [ -n "$sym" ] && EXPORT_FLAGS+=("-Wl,--export=$sym")
done < "$HERE/exports.txt"

# 264 object paths overflow the command-line length limit, so hand them to clang
# through a @response file.  The names inside are RELATIVE and the link runs
# from $OUT: MSYS translates /c/... paths in argv but not inside a response
# file, and the native clang.exe would then not find them.
RSP="objects.rsp"
( cd "$OUT" && ls *.o > "$RSP" )

echo "==> linking ($(grep -c . "$OUT/$RSP") objects, ${#EXPORT_FLAGS[@]} forced exports)"
( cd "$OUT" && "$CC" "$TARGET" -O2 -mexec-model=reactor \
  -o magick.wasm \
  "@$RSP" \
  "${LDLIBS[@]}" \
  "${EXPORT_FLAGS[@]}" \
  -Wl,--gc-sections \
  -Wl,--initial-memory=67108864 \
  -Wl,--max-memory=2147483648 \
  -Wl,--stack-first \
  -Wl,-z,stack-size=1048576 )
# -z stack-size: wasi-sdk's default shadow stack is 64 KiB.  ReadPNMImage alone
# reserves two MagickPathExtent (4 KiB) buffers and then descends
# SetImageExtent -> SyncImagePixelCache -> OpenPixelCache, which overflows it and
# traps ("memory access out of bounds") on every PNM/PAM/PGM/PPM/TXT read.
# 1 MiB is what native builds get by default and costs nothing (it is never
# touched unless used).  --stack-first keeps overflow a trap, not corruption.

"$STRIP" --strip-debug "$OUT/magick.wasm"
cp "$OUT/magick.wasm" "$DEST/magick.wasm"

SIZE="$(wc -c < "$DEST/magick.wasm" | tr -d ' ')"
echo "==> $DEST/magick.wasm  ($SIZE bytes)"

# --------------------------------------------- record the ACTUAL export list --
node "$HERE/list-exports.mjs" "$DEST/magick.wasm" > "$DEST/exports.txt"
echo "==> $DEST/exports.txt  ($(grep -c . "$DEST/exports.txt") symbols)"

# --------------------------------------------------------- sanity: imports ---
node "$HERE/list-exports.mjs" --imports "$DEST/magick.wasm" | sort -u | while read -r ns; do
  [ "$ns" = "wasi_snapshot_preview1" ] || { echo "!!! unexpected import namespace: $ns" >&2; exit 1; }
done

echo "==> done"
