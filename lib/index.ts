import { default as init, initSync } from "../pkg/lzma_wasm.js";
import { WASM_BASE64 } from "./wasm-b64.js";
import type { InitOutput } from "./public-types.js";
import {
  beginAsyncInit,
  beginSyncInit,
  createCodecApi,
  createInitStatus,
} from "./runtime.js";

export type {
  CompressFormat,
  CompressOptions,
  DecompressOptions,
  DecompressToBufferOptions,
  DecoderOptions,
  EncoderOptions,
  StreamDecoder,
  StreamDecoderFormat,
  StreamEncoder,
  StreamEncoderFormat,
  StreamFormat,
} from "./runtime.js";
export type { InitInput, InitOutput, SyncInitInput } from "./public-types.js";

const status = createInitStatus();
const api = createCodecApi(status);

function getWasmBytes(): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(WASM_BASE64, "base64");
  }
  const str = atob(WASM_BASE64);
  const wasmBytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    wasmBytes[i] = str.charCodeAt(i);
  }
  return wasmBytes;
}

/**
 * Initializes the embedded WebAssembly module.
 * Concurrent calls share an in-flight Promise. After failure, a later call may retry.
 */
export function initWasm(): Promise<InitOutput> {
  return beginAsyncInit(status, async () => {
    const wasmBytes = getWasmBytes();
    return init({ module_or_path: wasmBytes }) as Promise<InitOutput>;
  });
}

/**
 * Synchronously initializes the embedded WebAssembly module from inlined bytes.
 * Throws if asynchronous initialization is already in progress.
 */
export function initWasmSync(): InitOutput {
  return beginSyncInit(status, () => {
    const wasmBytes = getWasmBytes();
    return initSync({ module: wasmBytes }) as InitOutput;
  });
}

export const compress = api.compress;
export const decompress = api.decompress;
export const decompressToBuffer = api.decompressToBuffer;
export const createDecoder = api.createDecoder;
export const createEncoder = api.createEncoder;
