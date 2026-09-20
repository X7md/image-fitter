// Print the export names (or, with --imports, the import module namespaces) of
// a .wasm file.  Used by build.sh to record src/wasm/exports.txt and to assert
// that the module only imports from wasi_snapshot_preview1.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const wantImports = args.includes('--imports');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: list-exports.mjs [--imports] <module.wasm>');
  process.exit(2);
}

const mod = new WebAssembly.Module(readFileSync(file));

if (wantImports) {
  for (const imp of WebAssembly.Module.imports(mod)) console.log(imp.module);
} else {
  // One symbol per line, as ARCHITECTURE.md section 1 requires.
  const names = WebAssembly.Module.exports(mod).map((e) => e.name);
  names.sort((a, b) => a.localeCompare(b));
  for (const n of names) console.log(n);
}
