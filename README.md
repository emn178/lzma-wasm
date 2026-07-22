# @emn178/lzma-wasm

[![npm version](https://img.shields.io/npm/v/@emn178/lzma-wasm.svg)](https://www.npmjs.com/package/@emn178/lzma-wasm)
[![License](https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-blue.svg)](#license)

**[View on GitHub](https://github.com/emn178/lzma-wasm)** | **[View on npm](https://www.npmjs.com/package/@emn178/lzma-wasm)**

This package is maintained as a fork of the original [`lzma-wasm`](https://github.com/Wu-Yijun/lzma-wasm) project.

A high-performance, universal WebAssembly binding for the [`lzma-rust2`](https://github.com/hasenbanck/lzma-rust2) crate (currently **0.16.5**). It brings near-native LZMA, XZ, and LZIP compression and decompression to Node.js, modern browsers, and bundlers.

## Features

* **Near-Native Performance:** Powered by Rust and WebAssembly, heavily optimized for execution in V8/modern JS engines.
* **Universal & Zero-Config:** The Wasm binary is base64-inlined. **No `wasm-loader`, no static asset serving, and no Webpack/Vite configuration required.** Just import and use it anywhere.
* **External Wasm Support:** An optional external-Wasm entry is available for Workers and bundlers that prefer a separately cached `.wasm` asset.
* **Multi-Format Support:** Seamlessly supports `.xz` (modern, recommended), `.lzma` (legacy), and `.lz` (lzip) formats.
* **Streaming codec API:** Incremental XZ encode/decode; incremental LZIP and LZMA-Alone encode.
* **Zero-Allocation Decompression:** Expert APIs are available to decompress directly into pre-allocated memory and reduce JavaScript Garbage Collection (GC) overhead.
* **Safe & Robust:** Output-size limits help protect applications from unexpectedly large decompressed data. LZMA-Alone also supports a separate decoder-memory limit.

Streaming support matrix:

| Format | Streaming encode | Streaming decode |
|--------|------------------|------------------|
| XZ | yes | yes |
| LZIP | yes | not yet (upstream resumable LZMA1 required) |
| LZMA-Alone | yes | not yet (upstream resumable LZMA1 required) |

One-shot compress/decompress remains available for all three formats.

## 📦 Installation

```bash
npm install @emn178/lzma-wasm
# or
yarn add @emn178/lzma-wasm
pnpm add @emn178/lzma-wasm
```

Git checkouts do **not** include built `dist/` or Wasm files because they are build outputs. Use a published npm package, or run `pnpm run build` and consume a packed `.tgz` after building.

## Import Methods

This library ships with ES Modules, CommonJS, and IIFE builds, making it compatible with any environment.

**1. ES Modules (Vite, Rollup, Deno, Node.js ESM)**
```javascript
import { initWasm, compress, decompress } from '@emn178/lzma-wasm';
```

**2. CommonJS (Node.js)**
```javascript
const { initWasm, compress, decompress } = require('@emn178/lzma-wasm');
```

**3. Browser / CDN (Raw HTML)**
```html
<script src="https://cdn.jsdelivr.net/npm/@emn178/lzma-wasm/dist/iife/index.js"></script>
<script>
  // Exposed globally as `lzma_wasm`
  const { initWasm, compress, decompress } = window.lzma_wasm;
</script>
```

## 🚀 Quick Start

**⚠️ Important:** You must call and await `initWasm()` once before using any compression or decompression methods.

The asynchronous `initWasm` can be replaced by the synchronous function `initWasmSync`.

```javascript
import { initWasm, compress, decompress } from '@emn178/lzma-wasm';

async function run() {
    // 1. Initialize the Wasm module
    await initWasm();

    const text = "WebAssembly is awesome! ".repeat(100);
    const rawData = new TextEncoder().encode(text);

    // 2. Compress (Default is 'xz' format, level 6)
    const compressed = compress(rawData, { format: 'xz', level: 6 });
    console.log(`Compressed size: ${compressed.length} bytes`);

    // 3. Decompress
    const decompressed = decompress(compressed);
    const decodedText = new TextDecoder().decode(decompressed);

    console.log(decodedText.substring(0, 23)); // "WebAssembly is awesome!"
}

run();
```

## Embedded Wasm Entry (Default)

WASM bytes are Base64-inlined. No asset serving is required.

```js
import { initWasm, compress, decompress } from "@emn178/lzma-wasm";

await initWasm();
const compressed = compress(data, { format: "xz", level: 6 });
const out = decompress(compressed);
```

`initWasm()` shares an in-flight Promise across concurrent callers. After a failure, a later
call can retry. `initWasmSync()` throws if asynchronous initialization is already in progress.

## External Wasm Entry

```js
import { initWasm, compress, decompress } from "@emn178/lzma-wasm/external";

// Browser/Worker: zero-arg uses the shipped `.wasm` URL next to this module.
await initWasm();

// Explicit URL for a custom asset layout:
// await initWasm(new URL("/assets/lzma_wasm_bg.wasm", location.href));
```

Package paths:

- JS: `@emn178/lzma-wasm/external`
- WASM: `@emn178/lzma-wasm/lzma_wasm_bg.wasm` → `dist/wasm/lzma_wasm_bg.wasm`

The external JS bundle does **not** embed a Base64 copy of the WASM.

Export conditions for `@emn178/lzma-wasm/external`:

| Condition | Entry | Notes |
|-----------|-------|-------|
| `browser` / default `import` | `dist/esm/external.js` | No `node:` imports — safe for Vite/esbuild |
| `node` `import` | `dist/esm/external-node.js` | Zero-arg reads `.wasm` from disk |
| `node` / default `require` | `dist/cjs/external-node.cjs` | Same for CommonJS |

Sync init still requires bytes or a `WebAssembly.Module` (it cannot fetch a URL).

## ⚡ Advanced: Zero-Allocation Decompression

For extreme performance scenarios (e.g., high-frequency decompression, large files), you can avoid dynamic memory allocation and GC pressure by providing `expectedSize`. The Wasm module writes into a pre-allocated buffer with that capacity.

```javascript
// If you know the maximum size of the uncompressed data beforehand:
const uncompressedCapacity = 2400;

const result = decompress(compressed, {
    expectedSize: uncompressedCapacity
});
// 'result' is a Uint8Array view containing the bytes actually written.
// Decompression fails if the output is larger than the supplied capacity.
```

You can also call `decompressToBuffer` to decompress data directly into a pre-allocated JavaScript `Uint8Array`.

```javascript
// You must ensure enough space in your buffer:
const buffer = new Uint8Array(2400);

// The data will be written directly into the buffer you provided.
const length = decompressToBuffer(compressed, buffer);
```

## Decompression Options

```ts
interface DecompressOptions {
  /** Destination capacity. May be larger than the actual output. */
  expectedSize?: number;
  /** Max decompressed output bytes (all formats). */
  maxOutputSize?: number;
  /** LZMA-Alone decoder memory limit only. @default 256 MiB */
  lzmaMemoryLimit?: number;
  /** @deprecated Use lzmaMemoryLimit. */
  memLimit?: number;
}
```

Rules:

- if both `expectedSize` and `maxOutputSize` are set, require `expectedSize <= maxOutputSize`
  or throw before allocating;
- `maxOutputSize` is **not** a WASM-heap / dictionary-memory limit;
- `lzmaMemoryLimit` does **not** protect XZ or LZIP;
- `lzmaMemoryLimit` / `memLimit` are expressed in **bytes**. The value is converted to KiB once
  at the `lzma-rust2` boundary (`floor(bytes / 1024)`). This is a correctness fix: earlier
  builds accidentally treated the byte value as KiB, so the documented 256 MiB default behaved
  like 256 GiB.

```ts
decompressToBuffer(
  compressed,
  outBuffer,
  options?: { lzmaMemoryLimit?: number; memLimit?: number } | number,
): number;
```

`outBuffer.byteLength` is the hard output ceiling. Undersized buffers throw.

## Incremental XZ Decompression

```js
import { createDecoder, initWasm } from "@emn178/lzma-wasm/external";

await initWasm();
const decoder = createDecoder({
  format: "xz",
  maxOutputSize: 512 * 1024 * 1024,
});

for await (const inputChunk of compressedInput) {
  const outputChunk = decoder.write(inputChunk);
  if (outputChunk.byteLength) consume(outputChunk);
}

const finalChunk = decoder.finish();
if (finalChunk.byteLength) consume(finalChunk);
```

`write()` accepts arbitrary input boundaries and may return an empty chunk while an XZ or LZMA2
structure is incomplete. `finish()` validates the complete stream, including block checksums,
Index and footer; truncated input throws. Concatenated XZ streams are supported. Call `close()`
to release the decoder early after cancellation.

## Incremental Compression

```js
import { createEncoder, initWasm } from "@emn178/lzma-wasm/external";

await initWasm();
const encoder = createEncoder({
  format: "xz", // or "lzip" / "lzma"
  level: 6,
  // XZ-only optional tuning; defaults to 1 MiB / 4 MiB:
  // dictionarySize: 1024 * 1024,
  // blockSize: 4 * 1024 * 1024,
});

for await (const inputChunk of uncompressedInput) {
  const outputChunk = encoder.write(inputChunk);
  if (outputChunk.byteLength) consume(outputChunk);
}

const finalChunk = encoder.finish();
if (finalChunk.byteLength) consume(finalChunk);
```

All `write()` calls share one encoder instance and codec state. A call may return an empty
chunk while the encoder buffers data. `finish()` emits the remaining compressed bytes and
format trailer. Call `close()` to release the encoder without finalizing it after cancellation.

For XZ, `dictionarySize` defaults to 1 MiB. A smaller dictionary reduces memory use and
match-search work at the cost of compression ratio. `blockSize` creates multiple independently
compressed blocks inside one XZ stream and must be at least as large as the effective
dictionary. It defaults to 4 MiB, or the dictionary size when a larger custom dictionary is
selected. Both values are expressed in bytes and are rejected for LZIP/LZMA-Alone streaming.

Streaming LZMA-Alone uses an unknown-size `.lzma` header plus an end marker because the total
input length is not known when the encoder is constructed. Byte-for-byte output may therefore
differ from one-shot `compress(..., { format: "lzma" })`, which writes the known uncompressed
size.

## Compression Options

```ts
compress(data, { format?: "xz" | "lzma" | "lzip"; level?: 0..9 });
```

Unknown `format` values throw. Non-integer / out-of-range `level` values throw.
Default when omitted: `format: "xz"`, `level: 6`.

## Formats

| Format | Compress | Decompress detection |
|--------|----------|----------------------|
| XZ | yes | 6-byte magic `FD 37 7A 58 5A 00` |
| LZIP | yes | 4-byte magic `LZIP` (version + dictionary bytes validated) |
| LZMA-Alone | yes | fallback when neither magic matches |

## 📊 Performance Benchmarks

Using a non-rigorous test, we briefly evaluated the compression and decompression performance of various algorithms and compression levels within our test environment. *(Note: The observed speeds may appear extraordinarily high because highly repetitive JSON text data was used as the test sample, rather than dense binary executables.)*

The following table is retained from the original project README at commit `dbe085ddcc58863bc87025520f7467cd8dc8a364`. It has not yet been rerun against the current release, so treat it as historical reference data rather than a current performance guarantee.

| (index) | Env      | Platform  | Format | Level | RawSize KB | Compression Rate | Enc MB/s | Dec MB/s  | DecToBuf MB/s |
| :---:   |  :---:   |  :---:    |  :---: | :---: |  ---:     |  ---:        |  ---:   |  ---:    |  ---:         |
| 0       | 'ESM'    | 'Nodejs'  | 'XZ'   | 1     | 8426.02   | 1.1273       | 140.598 | 358.707  | 368.754       |
| 1       | 'ESM'    | 'Nodejs'  | 'XZ'   | 6     | 8426.02   | 1.1247       | 13.753  | 353.292  | 372.668       |
| 2       | 'ESM'    | 'Nodejs'  | 'XZ'   | 9     | 8426.02   | 1.1247       | 13.177  | 300.286  | 322.342       |
| 3       | 'ESM'    | 'Nodejs'  | 'LZMA' | 1     | 8426.02   | 1.1262       | 206.875 | 1343.863 | 1501.964      |
| 4       | 'ESM'    | 'Nodejs'  | 'LZMA' | 6     | 8426.02   | 1.1236       | 14.485  | 1224.712 | 1445.286      |
| 5       | 'ESM'    | 'Nodejs'  | 'LZMA' | 9     | 8426.02   | 1.1236       | 13.545  | 1242.776 | 1409.033      |
| 6       | 'ESM'    | 'Nodejs'  | 'LZIP' | 1     | 8426.02   | 1.1265       | 156.559 | 379.209  | 394.477       |
| 7       | 'ESM'    | 'Nodejs'  | 'LZIP' | 6     | 8426.02   | 1.1238       | 13.907  | 366.508  | 390.274       |
| 8       | 'ESM'    | 'Nodejs'  | 'LZIP' | 9     | 8426.02   | 1.1238       | 13.127  | 318.203  | 339.759       |
| 9       | 'CJS'    | 'Nodejs'  | 'XZ'   | 1     | 8392.24   | 1.1305       | 149.621 | 360.957  | 374.654       |
| 10      | 'CJS'    | 'Nodejs'  | 'XZ'   | 6     | 8392.24   | 1.1219       | 13.839  | 355.453  | 370.518       |
| 11      | 'CJS'    | 'Nodejs'  | 'XZ'   | 9     | 8392.24   | 1.1219       | 13.242  | 304.177  | 316.927       |
| 12      | 'CJS'    | 'Nodejs'  | 'LZMA' | 1     | 8392.24   | 1.1294       | 205.239 | 1344.910 | 1554.119      |
| 13      | 'CJS'    | 'Nodejs'  | 'LZMA' | 6     | 8392.24   | 1.1208       | 14.569  | 1277.358 | 1482.728      |
| 14      | 'CJS'    | 'Nodejs'  | 'LZMA' | 9     | 8392.24   | 1.1208       | 13.633  | 1299.108 | 1487.986      |
| 15      | 'CJS'    | 'Nodejs'  | 'LZIP' | 1     | 8392.24   | 1.1296       | 152.282 | 393.079  | 405.422       |
| 16      | 'CJS'    | 'Nodejs'  | 'LZIP' | 6     | 8392.24   | 1.1211       | 14.054  | 374.654  | 379.739       |
| 17      | 'CJS'    | 'Nodejs'  | 'LZIP' | 9     | 8392.24   | 1.1211       | 13.405  | 328.078  | 345.076       |
| 18      | 'IMPORT' | 'Browser' | 'XZ'   | 1     | 8387.91   | 1.1413       | 96.992  | 340.972  | 302.922       |
| 19      | 'IMPORT' | 'Browser' | 'XZ'   | 6     | 8387.91   | 1.1228       | 5.685   | 330.233  | 230.627       |
| 20      | 'IMPORT' | 'Browser' | 'XZ'   | 9     | 8387.91   | 1.1228       | 5.939   | 295.349  | 315.691       |
| 21      | 'IMPORT' | 'Browser' | 'LZMA' | 1     | 8387.91   | 1.1402       | 117.117 | 933.027  | 1011.811      |
| 22      | 'IMPORT' | 'Browser' | 'LZMA' | 6     | 8387.91   | 1.1217       | 5.341   | 788.337  | 1009.375      |
| 23      | 'IMPORT' | 'Browser' | 'LZMA' | 9     | 8387.91   | 1.1217       | 5.784   | 878.315  | 1011.811      |
| 24      | 'IMPORT' | 'Browser' | 'LZIP' | 1     | 8387.91   | 1.1405       | 96.479  | 322.736  | 344.049       |
| 25      | 'IMPORT' | 'Browser' | 'LZIP' | 6     | 8387.91   | 1.1219       | 5.785   | 321.007  | 338.495       |
| 26      | 'IMPORT' | 'Browser' | 'LZIP' | 9     | 8387.91   | 1.1219       | 5.670   | 280.814  | 289.738       |
| 27      | 'CDN'    | 'Browser' | 'XZ'   | 1     | 8417.64   | 1.1330       | 94.136  | 290.464  | 349.425       |
| 28      | 'CDN'    | 'Browser' | 'XZ'   | 6     | 8417.64   | 1.1302       | 6.052   | 283.422  | 345.836       |
| 29      | 'CDN'    | 'Browser' | 'XZ'   | 9     | 8417.64   | 1.1302       | 5.882   | 255.312  | 307.438       |
| 30      | 'CDN'    | 'Browser' | 'LZMA' | 1     | 8417.64   | 1.1319       | 115.563 | 953.300  | 1017.852      |
| 31      | 'CDN'    | 'Browser' | 'LZMA' | 6     | 8417.64   | 1.1291       | 5.996   | 911.000  | 1008.101      |
| 32      | 'CDN'    | 'Browser' | 'LZMA' | 9     | 8417.64   | 1.1291       | 5.843   | 926.033  | 1029.051      |
| 33      | 'CDN'    | 'Browser' | 'LZIP' | 1     | 8417.64   | 1.1322       | 99.288  | 318.007  | 340.933       |
| 34      | 'CDN'    | 'Browser' | 'LZIP' | 6     | 8417.64   | 1.1293       | 5.939   | 329.716  | 340.519       |
| 35      | 'CDN'    | 'Browser' | 'LZIP' | 9     | 8417.64   | 1.1293       | 5.706   | 282.756  | 290.263       |

> **Takeaway:** LZMA provides blisteringly fast decompression speeds, while XZ provides a robust modern container format. Using the Zero-Allocation strategy (`DecToBuf`) consistently boosts decompression throughput by eliminating internal memory reallocations.

## Build / Test

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
cargo test
pnpm pack --dry-run
```

Native interop tests require `xz` (`xz-utils`) and `lzip`. Browser tests require Playwright Chromium.

## 📄 License

This project is dual-licensed under either the [MIT License](LICENSE-MIT) or the [Apache License, Version 2.0](LICENSE-APACHE), at your option.

The underlying Rust compression logic is powered by [lzma-rust2](https://github.com/hasenbanck/lzma-rust2) (Apache-2.0 / MIT).
