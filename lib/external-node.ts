/**
 * Node.js external entry.
 * Zero-arg init reads the shipped `.wasm` from disk (no fetch of file: URLs).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createExternalInit, defaultWasmUrl } from "./external-shared.js";

export type {
  CompressFormat,
  CompressOptions,
  DecompressOptions,
  DecompressToBufferOptions,
  XzStreamDecoder,
  XzStreamEncoder,
  XzEncoderOptions,
  XzStreamOptions,
} from "./runtime.js";
export type { InitInput, InitOutput, SyncInitInput } from "./public-types.js";
export { defaultWasmUrl };

async function loadDefaultWasmBytes(): Promise<Buffer> {
  return readFile(fileURLToPath(defaultWasmUrl()));
}

const api = createExternalInit(loadDefaultWasmBytes);

/**
 * Initializes from an external WASM asset (no Base64 payload).
 * Zero-arg reads `lzma_wasm_bg.wasm` from the package install path.
 * Pass bytes/module/URL explicitly when preferred.
 */
export const initWasm = api.initWasm;
export const initWasmSync = api.initWasmSync;
export const compress = api.compress;
export const decompress = api.decompress;
export const decompressToBuffer = api.decompressToBuffer;
export const createXzDecoder = api.createXzDecoder;
export const createXzEncoder = api.createXzEncoder;
