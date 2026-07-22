import { default as init, initSync } from "../pkg/lzma_wasm.js";
import type { InitInput, InitOutput, SyncInitInput } from "./public-types.js";
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

/**
 * Resolve the shipped WASM asset next to this module.
 * In browsers this is an HTTP(S) URL; bundlers rewrite `import.meta.url` accordingly.
 */
export function defaultWasmUrl(): URL {
  return new URL("../wasm/lzma_wasm_bg.wasm", import.meta.url);
}

async function resolveDefaultInitInput(
  loadDefault: () => Promise<InitInput> | InitInput,
): Promise<InitInput> {
  return await loadDefault();
}

export function createExternalInit(loadDefault: () => Promise<InitInput> | InitInput) {
  function initWasm(input?: InitInput): Promise<InitOutput> {
    return beginAsyncInit(status, async () => {
      const moduleOrPath =
        input ?? (await resolveDefaultInitInput(loadDefault));
      return init({ module_or_path: moduleOrPath }) as Promise<InitOutput>;
    });
  }

  function initWasmSync(module: SyncInitInput): InitOutput {
    return beginSyncInit(status, () => initSync({ module }) as InitOutput);
  }

  return {
    initWasm,
    initWasmSync,
    compress: api.compress,
    decompress: api.decompress,
    decompressToBuffer: api.decompressToBuffer,
    createDecoder: api.createDecoder,
    createEncoder: api.createEncoder,
  };
}
