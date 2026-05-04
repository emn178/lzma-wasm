// 引入 wasm-pack 生成的原始胶水代码 (打包时 esbuild 会把它的内容内联进来)
import {
  compress_lzip,
  compress_lzma,
  compress_xz,
  decompress_dynamic,
  decompress_to_buffer,
  default as init,
} from "../pkg/lzma_wasm.js";
// 引入由构建脚本动态生成的 base64 字符串
import { WASM_BASE64 } from "./wasm-b64.js";

let isReady = false;

const MEM_LIMIT = 1024 * 1024 * 256; // 默认 256MB 内存限制，防止恶意文件导致 OOM

/**
 * Initializes the WebAssembly environment.
 * * **CRITICAL:** This function must be awaited and resolved before calling any other
 * compression or decompression APIs. It safely handles cross-platform Wasm instantiation
 * for both Node.js and Browser environments.
 * * It is safe to call this multiple times; subsequent calls will immediately return
 * if the environment is already initialized.
 * 
 * @returns {Promise<void>} A promise that resolves when the Wasm module is ready to use.
 * @example
 * import { initWasm, compress } from 'lzma-wasm-universal';
 * await initWasm();
 * const compressed = compress(data);
 */
export async function initWasm(): Promise<void> {
  if (isReady) return;

  let wasmBytes: Uint8Array;

  // 跨环境 Base64 解码逻辑
  if (typeof Buffer !== "undefined") {
    // Node.js 环境：极速解码
    wasmBytes = Buffer.from(WASM_BASE64, "base64");
  } else {
    // 浏览器 / Deno 环境：原生 atob 解码
    const str = atob(WASM_BASE64);
    wasmBytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      wasmBytes[i] = str.charCodeAt(i);
    }
  }

  // 将字节流喂给 wasm-bindgen 的 init 函数
  await init({ module_or_path: wasmBytes });
  isReady = true;
}

/**
 * Configuration options for the decompression process.
 */
export interface DecompressOptions {
  /** * The exact expected size of the uncompressed data in bytes.
   * * **⚡ Performance Tip:** Providing this value enables the "Zero-Allocation" 
   * high-performance mode. The library will pre-allocate the exact required memory 
   * in JavaScript and instruct WebAssembly to write directly into it, avoiding 
   * internal Rust vector resizing and reducing cross-boundary memory copying.
   */
  expectedSize?: number;
  /** * The maximum amount of memory (in bytes) the Wasm decompressor is allowed to allocate.
   * * This acts as a crucial safeguard against malicious, highly-compressed files 
   * (e.g., Zip Bombs) that could cause Out-Of-Memory (OOM) crashes.
   * 
   * @default 268435456 (256 MB)
   */
  memLimit?: number;
}

/**
 * Decompresses LZMA, XZ, or LZIP binary data.
 * * The function automatically detects the compression format based on the magic headers
 * of the provided compressed data.
 * 
 * @param {Uint8Array} compressed - The compressed binary data.
 * @param {DecompressOptions} [options] - Optional configuration for decompression memory strategies.
 * @returns {Uint8Array} A new Uint8Array containing the uncompressed data.
 * @throws {Error} If the Wasm module is not initialized, the format is invalid, or memory limits are exceeded.
 */
export function decompress(
  compressed: Uint8Array,
  options?: DecompressOptions,
): Uint8Array {
  if (!isReady) throw new Error("请先调用并等待 initWasm() 完成初始化");

  if (options?.expectedSize) {
    // 走预分配内存的高性能路线
    const outBuffer = new Uint8Array(options.expectedSize);
    const bytesWritten = decompress_to_buffer(
      compressed,
      outBuffer,
      options.memLimit ?? MEM_LIMIT,
    );
    // 如果文件实际没那么大，截断未使用的部分
    return outBuffer.subarray(0, bytesWritten);
  } else {
    // 走 Rust 动态扩容路线
    const memLimit = options?.memLimit ?? MEM_LIMIT; // 默认 256MB 限制
    return decompress_dynamic(compressed, memLimit);
  }
}

/**
 * Expert-level Decompression API (Zero-Allocation).
 * * Decompresses data directly into a pre-allocated JavaScript `Uint8Array`.
 * 
 * dThis bypasses internal dynamic reallocation and minimizes GC (Garbage Collection) pressure, 
 * making it ideal for high-frequency or extreme-performance scenarios (e.g., game assets, video streaming).
 * 
 * @param {Uint8Array} compressed - The compressed binary data.
 * @param {Uint8Array} outBuffer - The pre-allocated destination buffer. It must be large enough to hold the uncompressed data.
 * @param {number} [memLimit] - Optional memory limit in bytes to prevent OOM. If not provided, it defaults to the size of `outBuffer`.
 * @returns {number} The actual number of bytes written to the `outBuffer`.
 * @throws {Error} If the uncompressed data exceeds the size of `outBuffer` or if decompression fails.
 */
export function decompressToBuffer(
  compressed: Uint8Array,
  outBuffer: Uint8Array,
  memLimit?: number,
): number {
  if (!isReady) throw new Error("请先调用并等待 initWasm() 完成初始化");
  return decompress_to_buffer(compressed, outBuffer, memLimit ?? outBuffer.length);
}

/**
 * Configuration options for the compression process.
 */
export interface CompressOptions {
  /** The target compression format.
   * - `'xz'`: (Recommended) Modern, highly efficient container format with integrity checks (CRC).
   * - `'lzip'`: Designed for long-term archiving and data recovery reliability.
   * - `'lzma'`: Legacy format (LZMA Alone), widely supported but lacks robust headers.
   * * @default "xz"
   */
  format?: "lzma" | "xz" | "lzip";
  /** The compression preset level, ranging from `0` to `9`.
   * - `0-2`: Fastest compression speed, lowest memory usage, lower compression ratio.
   * - `3-6`: Balanced performance. `6` is the standard default for most command-line tools.
   * - `7-9`: Maximum compression ratio, extremely slow, highest memory usage.
   * 
   * @default 6
   */
  level?: number;
}

/**
 * Compresses binary data into the specified LZMA-family format.
 * @param {Uint8Array} data - The raw, uncompressed binary data to be compressed.
 * @param {CompressOptions} [options] - Configuration for the output format and compression level.
 * @returns {Uint8Array} A new Uint8Array containing the compressed binary data.
 * @throws {Error} If the Wasm module is not initialized or if the compression process fails.
 */
export function compress(
  data: Uint8Array,
  options?: CompressOptions,
): Uint8Array {
  if (!isReady) throw new Error("请先调用并等待 initWasm() 完成初始化");
  // 默认行为：使用 xz 格式，级别 6（与 Linux 默认行为一致）
  const format = options?.format ?? "xz";
  const level = options?.level ?? 6;

  // 安全校验：防止用户乱填越界数字
  const safeLevel = Math.max(0, Math.min(9, Math.floor(level)));

  try {
    switch (format) {
      case "xz":
        return compress_xz(data, safeLevel);
      case "lzip":
        return compress_lzip(data, safeLevel);
      case "lzma":
      default:
        return compress_lzma(data, safeLevel);
    }
  } catch (err) {
    throw new Error(`[LZMA-Wasm] 压缩失败 (${format}): ${err}`);
  }
}
