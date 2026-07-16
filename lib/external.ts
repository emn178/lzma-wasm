/**
 * Browser / bundler-safe external entry.
 * Contains no Node built-in imports so Vite/esbuild can bundle it.
 */
import { createExternalInit, defaultWasmUrl } from "./external-shared.js";

export type {
  CompressFormat,
  CompressOptions,
  DecompressOptions,
  DecompressToBufferOptions,
} from "./runtime.js";
export type { InitInput, InitOutput, SyncInitInput } from "./public-types.js";
export { defaultWasmUrl };

const api = createExternalInit(() => defaultWasmUrl());

/**
 * Initializes from an external WASM asset (no Base64 payload).
 * Zero-arg uses the shipped `.wasm` URL next to this module (browser/Worker).
 * Pass an explicit URL/Request/Response/bytes/module when needed.
 */
export const initWasm = api.initWasm;
export const initWasmSync = api.initWasmSync;
export const compress = api.compress;
export const decompress = api.decompress;
export const decompressToBuffer = api.decompressToBuffer;
