/*
  magick-baseconfig.h — wasm32-wasip1 build of ImageMagick 7.1.2-31.

  This file is HAND-AUTHORED and owned by wasm/config/.  It wraps the pristine
  autoconf output (magick-baseconfig-configure.h, produced once by ./configure
  --host=wasm32-wasi with CC=wasi-sdk clang; see wasm/README.md for the exact
  invocation) and then corrects the handful of results that are wrong or
  undesirable for a bare wasm32-wasip1 reactor module.

  Rationale for each override is inline.  Nothing here changes ImageMagick
  sources; build.sh copies both headers over MagickCore/ before compiling, so
  the build is reproducible without re-running configure.
*/
/* NB: a distinct guard — the included file owns _MAGICKCORE_MAGICK_BASECONFIG_H. */
#ifndef _MAGICKCORE_MAGICK_BASECONFIG_WASI_H
#define _MAGICKCORE_MAGICK_BASECONFIG_WASI_H

/* The unmodified ./configure result. */
#include "MagickCore/magick-baseconfig-configure.h"

#if defined(__wasi__)

/*
  1. No mmap.  wasi-libc only offers mmap via -lwasi-emulated-mman, which is a
     malloc+pread emulation with no shared/writeback semantics.  ImageMagick
     uses mmap for the memory-mapped disk pixel cache; with the emulation the
     cache would silently not write back.  Force the portable read/write path.
*/
#undef MAGICKCORE_HAVE_MMAP
#undef MAGICKCORE_HAVE_MUNMAP
#undef MAGICKCORE_HAVE_SYS_MMAN_H
#undef MAGICKCORE_HAVE_MMAP_FILEIO

/*
  2. No sockets.  wasi-preview1 has no socket(); the distributed pixel cache
     (MagickCore/distribute-cache.c) and its client half must compile out.
*/
#undef MAGICKCORE_DPC_SUPPORT
#undef MAGICKCORE_HAVE_SOCKET
#undef MAGICKCORE_HAVE_SYS_SOCKET_H
#undef MAGICKCORE_HAVE_NETINET_IN_H
#undef MAGICKCORE_HAVE_NETDB_H
#undef MAGICKCORE_HAVE_ARPA_INET_H
#undef MAGICKCORE_HAVE_SELECT
#undef MAGICKCORE_HAVE_POLL

/*
  3. No processes.  No fork/exec/waitpid/popen/system under wasi; delegate.c
     and utility.c must take their "cannot run external program" paths.
*/
#undef MAGICKCORE_HAVE_POPEN
#undef MAGICKCORE_HAVE_SYSTEM
#undef MAGICKCORE_HAVE_FORK
#undef MAGICKCORE_HAVE_VFORK
#undef MAGICKCORE_HAVE_EXECVP
#undef MAGICKCORE_HAVE_WAITPID
#undef MAGICKCORE_HAVE_SPAWNVP
#undef MAGICKCORE_HAVE_SYS_WAIT_H
#undef MAGICKCORE_HAVE_PROCESS_H

/*
  4. No threads of any kind (no pthreads, no OpenMP, no thread-local atomics
     beyond the single-threaded fallbacks).
*/
#undef MAGICKCORE_THREAD_SUPPORT
#undef MAGICKCORE_HAVE_PTHREAD
#undef MAGICKCORE_HAVE_PTHREAD_H
#undef MAGICKCORE_OPENMP_SUPPORT
#undef MAGICKCORE_HAVE_OPENMP

/*
  5. No dynamic loading (static coders only, MAGICKCORE_BUILD_MODULES off).
*/
#undef MAGICKCORE_BUILD_MODULES
#undef MAGICKCORE_HAVE_DLFCN_H
#undef MAGICKCORE_HAVE_DLOPEN

/*
  6. Process/resource introspection wasi-libc stubs out or omits.
*/
#undef MAGICKCORE_HAVE_GETRUSAGE
#undef MAGICKCORE_HAVE_SYS_RESOURCE_H
#undef MAGICKCORE_HAVE_TIMES
#undef MAGICKCORE_HAVE_SYS_TIMES_H
#undef MAGICKCORE_HAVE_GETPWUID
#undef MAGICKCORE_HAVE_PWD_H
#undef MAGICKCORE_HAVE_SYSCONF
#undef MAGICKCORE_HAVE_GETPAGESIZE

/*
  7. No user/environment mutation and no symlink/realpath games: wasi's
     capability-based FS rejects absolute realpath() and symlinks anyway.
*/
#undef MAGICKCORE_HAVE_PUTENV
#undef MAGICKCORE_HAVE_SETENV
#undef MAGICKCORE_HAVE_REALPATH
#undef MAGICKCORE_HAVE_SYMLINK
#undef MAGICKCORE_HAVE_READLINK
#undef MAGICKCORE_HAVE_LSTAT
#undef MAGICKCORE_HAVE_UTIME
#undef MAGICKCORE_HAVE_UTIME_H

/*
  8. The install-path strings autoconf produced are garbage on this box
     (MSYS mangled "C:\Program Files..." into "C:\\Programusr\\local\\...").
     Zero-configuration mode never reads them, but they end up in
     MagickGetVersion()/configure-list output, so make them harmless.
*/
#undef MAGICKCORE_CONFIGURE_PATH
#define MAGICKCORE_CONFIGURE_PATH ""
#undef MAGICKCORE_DOCUMENTATION_PATH
#define MAGICKCORE_DOCUMENTATION_PATH ""
#undef MAGICKCORE_EXECUTABLE_PATH
#define MAGICKCORE_EXECUTABLE_PATH ""
#undef MAGICKCORE_INCLUDE_PATH
#define MAGICKCORE_INCLUDE_PATH ""
#undef MAGICKCORE_INCLUDEARCH_PATH
#define MAGICKCORE_INCLUDEARCH_PATH ""
#undef MAGICKCORE_LIBRARY_ABSOLUTE_PATH
#define MAGICKCORE_LIBRARY_ABSOLUTE_PATH ""
#undef MAGICKCORE_SHARE_PATH
#define MAGICKCORE_SHARE_PATH ""
#undef MAGICKCORE_X11_CONFIGURE_PATH
#define MAGICKCORE_X11_CONFIGURE_PATH ""
#undef MAGICKCORE_FILTER_PATH
#define MAGICKCORE_FILTER_PATH ""
#undef MAGICKCORE_CODER_PATH
#define MAGICKCORE_CODER_PATH ""

/*
  9. Quantum/HDRI are normally injected by the Makefile's CPPFLAGS
     (-DMAGICKCORE_QUANTUM_DEPTH=8 -DMAGICKCORE_HDRI_ENABLE=0
      -DMAGICKCORE_CHANNEL_MASK_DEPTH=32).  build.sh passes them too, but pin
     them here so a stray compile can never pick a different ABI.
*/
#ifndef MAGICKCORE_QUANTUM_DEPTH
#define MAGICKCORE_QUANTUM_DEPTH 8
#endif
#ifndef MAGICKCORE_HDRI_ENABLE
#define MAGICKCORE_HDRI_ENABLE 0
#endif
#ifndef MAGICKCORE_CHANNEL_MASK_DEPTH
#define MAGICKCORE_CHANNEL_MASK_DEPTH 32
#endif
#ifndef MAGICKCORE_ZERO_CONFIGURATION_SUPPORT
#define MAGICKCORE_ZERO_CONFIGURATION_SUPPORT 1
#endif

#endif /* __wasi__ */

#endif /* _MAGICKCORE_MAGICK_BASECONFIG_WASI_H */
