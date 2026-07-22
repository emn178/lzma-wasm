import {
  compress_lzip,
  compress_lzma,
  compress_xz,
  decompress_dynamic,
  decompress_to_buffer,
  LzipStreamEncoder as WasmLzipStreamEncoder,
  LzmaStreamEncoder as WasmLzmaStreamEncoder,
  XzStreamDecoder as WasmXzStreamDecoder,
  XzStreamEncoder as WasmXzStreamEncoder,
} from "../pkg/lzma_wasm.js";
import type { InitOutput } from "./public-types.js";

const DEFAULT_LZMA_MEMORY_LIMIT = 1024 * 1024 * 256; // 256 MiB decoder memory for LZMA-Alone only
const MAX_U32 = 0xffff_ffff;
const DEFAULT_XZ_DICTIONARY_SIZE = 1024 * 1024;
const DEFAULT_XZ_BLOCK_SIZE = 4 * 1024 * 1024;

export type CompressFormat = "lzma" | "xz" | "lzip";

export interface DecompressOptions {
  /**
   * Destination buffer capacity in bytes (not a requirement that the decoded
   * output be exactly this long). May be larger than the actual output.
   * Must fail when smaller than the actual output.
   */
  expectedSize?: number;
  /**
   * Maximum allowed decompressed output bytes. Enforced for XZ, LZIP, and
   * LZMA-Alone. Does not limit WASM heap or decoder dictionary memory.
   */
  maxOutputSize?: number;
  /**
   * LZMA-Alone decoder memory limit in bytes. Does not apply to XZ or LZIP.
   * @default 268435456 (256 MiB)
   */
  lzmaMemoryLimit?: number;
  /**
   * @deprecated Use `lzmaMemoryLimit`. Applies only to LZMA-Alone.
   */
  memLimit?: number;
}

export interface DecompressToBufferOptions {
  /**
   * LZMA-Alone decoder memory limit in bytes. Does not apply to XZ or LZIP.
   * @default 268435456 (256 MiB)
   */
  lzmaMemoryLimit?: number;
  /**
   * @deprecated Use `lzmaMemoryLimit`. Applies only to LZMA-Alone.
   */
  memLimit?: number;
}

export interface CompressOptions {
  /**
   * Target compression format.
   * - `'xz'`: modern container with integrity checks (default when omitted)
   * - `'lzip'`: long-term archiving format
   * - `'lzma'`: legacy LZMA Alone
   * @default "xz"
   */
  format?: CompressFormat;
  /**
   * Compression preset level, integer from 0 through 9.
   * @default 6
   */
  level?: number;
}

/** Formats accepted by `createEncoder()`. */
export type StreamEncoderFormat = "xz" | "lzip" | "lzma";

/**
 * Formats accepted by `createDecoder()`.
 * LZIP/LZMA-Alone streaming decode is gated on a resumable upstream LZMA1 API.
 */
export type StreamDecoderFormat = "xz";

/** Backward-compatible umbrella alias for encoder formats. */
export type StreamFormat = StreamEncoderFormat;

export interface DecoderOptions {
  /** Streaming container format. @default "xz" */
  format?: StreamDecoderFormat;
  /** Maximum allowed decompressed output bytes across the complete stream. */
  maxOutputSize?: number;
}

export interface EncoderOptions {
  /** Streaming container format. @default "xz" */
  format?: StreamEncoderFormat;
  /** Compression preset level, integer from 0 through 9. @default 6 */
  level?: number;
  /**
   * XZ/LZMA2 dictionary size in bytes. Must be at least 4096.
   * XZ only; rejected for LZIP and LZMA-Alone in this release.
   * @default 1048576 (1 MiB)
   */
  dictionarySize?: number;
  /**
   * Maximum uncompressed bytes per XZ block. Must be at least the effective
   * dictionary size. When omitted, defaults to 4 MiB or the dictionary size,
   * whichever is larger. XZ only; rejected for LZIP and LZMA-Alone.
   * @default 4194304 (4 MiB)
   */
  blockSize?: number;
}

export interface StreamEncoder {
  /** Supply the next uncompressed input chunk and return newly encoded bytes. */
  write(input: Uint8Array): Uint8Array;
  /** Finalize the stream and return remaining encoded bytes. */
  finish(): Uint8Array;
  /** Release the underlying WASM encoder without finishing the stream. */
  close(): void;
}

export interface StreamDecoder {
  /** Supply the next compressed input chunk and return newly decoded bytes. */
  write(input: Uint8Array): Uint8Array;
  /** Mark the input complete, validate the stream trailer, and return remaining bytes. */
  finish(): Uint8Array;
  /** Release the underlying WASM decoder without finishing the stream. */
  close(): void;
}

type WasmStreamHandle = {
  write(input: Uint8Array): Uint8Array;
  finish(): Uint8Array;
  free(): void;
};

export type InitStatus = {
  isReady: boolean;
  wasm: InitOutput | undefined;
  initPromise: Promise<InitOutput> | null;
};

export function createInitStatus(): InitStatus {
  return { isReady: false, wasm: undefined, initPromise: null };
}

function assertReady(status: InitStatus): void {
  if (!status.isReady) {
    throw new Error(
      "Please call `initWasm()` and wait for initialization to complete first",
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateNonNegSafeInt(
  name: string,
  value: unknown,
  { allowUndefined = false }: { allowUndefined?: boolean } = {},
): number | undefined {
  if (value === undefined) {
    if (allowUndefined) return undefined;
    throw new TypeError(`${name} is required`);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `${name} must be a non-negative safe integer (got ${String(value)})`,
    );
  }
  if (value > MAX_U32) {
    throw new RangeError(`${name} exceeds the range accepted by the WASM codec`);
  }
  return value;
}

function resolveLzmaMemoryLimit(
  lzmaMemoryLimit: unknown,
  memLimit: unknown,
): number {
  const hasNew = lzmaMemoryLimit !== undefined;
  const hasOld = memLimit !== undefined;
  if (hasNew && hasOld) {
    const a = validateNonNegSafeInt("lzmaMemoryLimit", lzmaMemoryLimit);
    const b = validateNonNegSafeInt("memLimit", memLimit);
    if (a !== b) {
      throw new Error(
        "lzmaMemoryLimit and memLimit were both provided with different values",
      );
    }
    return a!;
  }
  if (hasNew) {
    return validateNonNegSafeInt("lzmaMemoryLimit", lzmaMemoryLimit)!;
  }
  if (hasOld) {
    return validateNonNegSafeInt("memLimit", memLimit)!;
  }
  return DEFAULT_LZMA_MEMORY_LIMIT;
}

function validateLevel(level: unknown): number {
  if (level === undefined) return 6;
  if (typeof level !== "number" || !Number.isInteger(level) || level < 0 || level > 9) {
    throw new RangeError(
      `level must be an integer from 0 through 9 (got ${String(level)})`,
    );
  }
  return level;
}

function validateFormat(format: unknown): CompressFormat {
  if (format === undefined) return "xz";
  if (format === "xz" || format === "lzma" || format === "lzip") {
    return format;
  }
  throw new TypeError(
    `format must be "xz", "lzma", or "lzip" (got ${String(format)})`,
  );
}

function validateStreamEncoderFormat(format: unknown): StreamEncoderFormat {
  if (format === undefined) return "xz";
  if (format === "xz" || format === "lzma" || format === "lzip") {
    return format;
  }
  throw new TypeError(
    `streaming encoder format must be "xz", "lzma", or "lzip" (got ${String(format)})`,
  );
}

function validateStreamDecoderFormat(format: unknown): StreamDecoderFormat {
  if (format === undefined || format === "xz") return "xz";
  throw new TypeError(
    `streaming decoder format "${String(format)}" is not available`,
  );
}

function validateOptionalSize(
  name: string,
  value: unknown,
  minimum: number,
): number | undefined {
  const size = validateNonNegSafeInt(name, value, { allowUndefined: true });
  if (size !== undefined && size < minimum) {
    throw new RangeError(`${name} must be at least ${minimum} bytes`);
  }
  return size;
}

function wrapStreamCodec(
  label: string,
  handle: WasmStreamHandle,
): StreamEncoder | StreamDecoder {
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new Error(`${label} is already closed`);
  }

  return {
    write(input: Uint8Array): Uint8Array {
      assertOpen();
      if (!(input instanceof Uint8Array)) {
        throw new TypeError(`${label} input must be a Uint8Array`);
      }
      try {
        return handle.write(input);
      } catch (error) {
        closed = true;
        try {
          handle.free();
        } catch {
          // Preserve the codec error if wasm-bindgen still considers the
          // Rust value borrowed while unwinding the failed call.
        }
        throw error;
      }
    },
    finish(): Uint8Array {
      assertOpen();
      closed = true;
      let output: Uint8Array;
      try {
        output = handle.finish();
      } catch (error) {
        try {
          handle.free();
        } catch {
          // Preserve the finalization error.
        }
        throw error;
      }
      handle.free();
      return output;
    },
    close(): void {
      if (closed) return;
      closed = true;
      handle.free();
    },
  };
}

export function createCodecApi(status: InitStatus) {
  function compress(
    data: Uint8Array,
    options?: CompressOptions,
  ): Uint8Array {
    assertReady(status);
    const format = validateFormat(options?.format);
    const level = validateLevel(options?.level);

    try {
      switch (format) {
        case "xz":
          return compress_xz(data, level);
        case "lzip":
          return compress_lzip(data, level);
        case "lzma":
          return compress_lzma(data, level);
      }
    } catch (err) {
      throw new Error(`[LZMA-Wasm] Compression failed (${format}): ${err}`);
    }
  }

  function decompress(
    compressed: Uint8Array,
    options?: DecompressOptions,
  ): Uint8Array {
    assertReady(status);

    const expectedSize = validateNonNegSafeInt("expectedSize", options?.expectedSize, {
      allowUndefined: true,
    });
    const maxOutputSize = validateNonNegSafeInt("maxOutputSize", options?.maxOutputSize, {
      allowUndefined: true,
    });
    const lzmaMemoryLimit = resolveLzmaMemoryLimit(
      options?.lzmaMemoryLimit,
      options?.memLimit,
    );

    if (expectedSize !== undefined && maxOutputSize !== undefined) {
      if (expectedSize > maxOutputSize) {
        throw new RangeError(
          "expectedSize must be <= maxOutputSize when both are provided",
        );
      }
    }

    if (expectedSize !== undefined) {
      const outBuffer = new Uint8Array(expectedSize);
      const bytesWritten = decompress_to_buffer(
        compressed,
        outBuffer,
        lzmaMemoryLimit,
      );
      if (maxOutputSize !== undefined && bytesWritten > maxOutputSize) {
        throw new Error("Decompressed output exceeds maxOutputSize");
      }
      return outBuffer.subarray(0, bytesWritten);
    }

    return decompress_dynamic(compressed, lzmaMemoryLimit, maxOutputSize);
  }

  function decompressToBuffer(
    compressed: Uint8Array,
    outBuffer: Uint8Array,
    options?: DecompressToBufferOptions | number,
  ): number {
    assertReady(status);

    let lzmaMemoryLimit: number;
    if (typeof options === "number") {
      lzmaMemoryLimit = validateNonNegSafeInt("lzmaMemoryLimit", options)!;
    } else if (options === undefined) {
      lzmaMemoryLimit = DEFAULT_LZMA_MEMORY_LIMIT;
    } else if (isPlainObject(options)) {
      lzmaMemoryLimit = resolveLzmaMemoryLimit(
        options.lzmaMemoryLimit,
        options.memLimit,
      );
    } else {
      throw new TypeError(
        "decompressToBuffer options must be a number or options object",
      );
    }

    return decompress_to_buffer(compressed, outBuffer, lzmaMemoryLimit);
  }

  function createDecoder(options?: DecoderOptions): StreamDecoder {
    assertReady(status);
    validateStreamDecoderFormat(options?.format);
    const maxOutputSize = validateNonNegSafeInt(
      "maxOutputSize",
      options?.maxOutputSize,
      { allowUndefined: true },
    );
    const decoder = new WasmXzStreamDecoder(maxOutputSize);
    return wrapStreamCodec("XZ stream decoder", decoder) as StreamDecoder;
  }

  function createEncoder(options?: EncoderOptions): StreamEncoder {
    assertReady(status);
    const format = validateStreamEncoderFormat(options?.format);
    const level = validateLevel(options?.level);

    if (format !== "xz") {
      if (options?.dictionarySize !== undefined) {
        throw new TypeError(
          `dictionarySize is only supported for XZ streaming (got format "${format}")`,
        );
      }
      if (options?.blockSize !== undefined) {
        throw new TypeError(
          `blockSize is only supported for XZ streaming (got format "${format}")`,
        );
      }
    }

    let encoder: WasmStreamHandle;
    switch (format) {
      case "xz": {
        const dictionarySize =
          validateOptionalSize(
            "dictionarySize",
            options?.dictionarySize,
            4096,
          ) ?? DEFAULT_XZ_DICTIONARY_SIZE;
        const blockSize =
          validateOptionalSize(
            "blockSize",
            options?.blockSize,
            dictionarySize,
          ) ?? Math.max(DEFAULT_XZ_BLOCK_SIZE, dictionarySize);
        encoder = new WasmXzStreamEncoder(level, dictionarySize, blockSize);
        break;
      }
      case "lzip":
        encoder = new WasmLzipStreamEncoder(level);
        break;
      case "lzma":
        encoder = new WasmLzmaStreamEncoder(level);
        break;
    }

    const label =
      format === "xz"
        ? "XZ stream encoder"
        : format === "lzip"
          ? "LZIP stream encoder"
          : "LZMA stream encoder";
    return wrapStreamCodec(label, encoder) as StreamEncoder;
  }

  return { compress, decompress, decompressToBuffer, createDecoder, createEncoder };
}

export function beginAsyncInit(
  status: InitStatus,
  run: () => Promise<InitOutput>,
): Promise<InitOutput> {
  if (status.isReady && status.wasm) {
    return Promise.resolve(status.wasm);
  }
  if (status.initPromise) {
    return status.initPromise;
  }

  const pending = run()
    .then((wasm) => {
      status.wasm = wasm;
      status.isReady = true;
      status.initPromise = null;
      return wasm;
    })
    .catch((err) => {
      status.initPromise = null;
      status.isReady = false;
      status.wasm = undefined;
      throw err;
    });

  status.initPromise = pending;
  return pending;
}

export function beginSyncInit(
  status: InitStatus,
  run: () => InitOutput,
): InitOutput {
  if (status.isReady && status.wasm) {
    return status.wasm;
  }
  if (status.initPromise) {
    throw new Error(
      "Asynchronous initialization is already in progress; await the existing initWasm() promise instead of calling initWasmSync()",
    );
  }

  try {
    const wasm = run();
    status.wasm = wasm;
    status.isReady = true;
    return wasm;
  } catch (err) {
    status.isReady = false;
    status.wasm = undefined;
    throw err;
  }
}

export { DEFAULT_LZMA_MEMORY_LIMIT };
