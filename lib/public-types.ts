/**
 * Public init types for packaged declarations.
 * Kept free of unpublished wasm-bindgen glue imports so published `.d.ts`
 * files resolve without build artifacts.
 */

export type InitInput =
  | RequestInfo
  | URL
  | Response
  | BufferSource
  | WebAssembly.Module;

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Return type of `initWasm` / `initWasmSync`.
 * Matches the wasm-bindgen `InitOutput` surface (memory + generated exports).
 */
export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly compress_lzip: (
    a: number,
    b: number,
    c: number,
  ) => [number, number, number, number];
  readonly compress_lzma: (
    a: number,
    b: number,
    c: number,
  ) => [number, number, number, number];
  readonly compress_xz: (
    a: number,
    b: number,
    c: number,
  ) => [number, number, number, number];
  readonly decompress_dynamic: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => [number, number, number, number];
  readonly decompress_to_buffer: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: any,
    f: number,
  ) => [number, number, number];
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}
