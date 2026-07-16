import {
  compress_lzip,
  compress_lzma,
  compress_xz,
  decompress_dynamic,
  decompress_to_buffer,
  XzStreamDecoder as WasmXzStreamDecoder,
  XzStreamEncoder as WasmXzStreamEncoder,
} from "../pkg/lzma_wasm.js";
import type { InitOutput } from "./public-types.js";

const DEFAULT_LZMA_MEMORY_LIMIT = 1024 * 1024 * 256; // 256 MiB decoder memory for LZMA-Alone only
const MAX_U32 = 0xffff_ffff;

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

export interface XzStreamOptions {
  /** Maximum allowed decompressed output bytes across the complete stream. */
  maxOutputSize?: number;
}

export interface XzEncoderOptions {
  /** Compression preset level, integer from 0 through 9. @default 6 */
  level?: number;
}

export interface XzStreamEncoder {
  /** Supply the next uncompressed input chunk and return newly encoded bytes. */
  write(input: Uint8Array): Uint8Array;
  /** Finalize the XZ stream and return its remaining index and footer bytes. */
  finish(): Uint8Array;
  /** Release the underlying WASM encoder without finishing the stream. */
  close(): void;
}

export interface XzStreamDecoder {
  /** Supply the next compressed input chunk and return newly decoded bytes. */
  write(input: Uint8Array): Uint8Array;
  /** Mark the input complete, validate the XZ footer, and return remaining bytes. */
  finish(): Uint8Array;
  /** Release the underlying WASM decoder without finishing the stream. */
  close(): void;
}

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

  function createXzDecoder(options?: XzStreamOptions): XzStreamDecoder {
    assertReady(status);
    const maxOutputSize = validateNonNegSafeInt(
      "maxOutputSize",
      options?.maxOutputSize,
      { allowUndefined: true },
    );
    const decoder = new WasmXzStreamDecoder(maxOutputSize);
    let closed = false;

    function assertOpen(): void {
      if (closed) throw new Error("XZ stream decoder is already closed");
    }

    return {
      write(input: Uint8Array): Uint8Array {
        assertOpen();
        if (!(input instanceof Uint8Array)) {
          throw new TypeError("XZ stream input must be a Uint8Array");
        }
        try {
          return decoder.write(input);
        } catch (error) {
          closed = true;
          decoder.free();
          throw error;
        }
      },
      finish(): Uint8Array {
        assertOpen();
        closed = true;
        try {
          return decoder.finish();
        } finally {
          decoder.free();
        }
      },
      close(): void {
        if (closed) return;
        closed = true;
        decoder.free();
      },
    };
  }

  function createXzEncoder(options?: XzEncoderOptions): XzStreamEncoder {
    assertReady(status);
    const level = validateLevel(options?.level);
    const encoder = new WasmXzStreamEncoder(level);
    let closed = false;

    function assertOpen(): void {
      if (closed) throw new Error("XZ stream encoder is already closed");
    }

    return {
      write(input: Uint8Array): Uint8Array {
        assertOpen();
        if (!(input instanceof Uint8Array)) {
          throw new TypeError("XZ stream input must be a Uint8Array");
        }
        try {
          return encoder.write(input);
        } catch (error) {
          closed = true;
          encoder.free();
          throw error;
        }
      },
      finish(): Uint8Array {
        assertOpen();
        closed = true;
        try {
          return encoder.finish();
        } finally {
          encoder.free();
        }
      },
      close(): void {
        if (closed) return;
        closed = true;
        encoder.free();
      },
    };
  }

  return { compress, decompress, decompressToBuffer, createXzDecoder, createXzEncoder };
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
