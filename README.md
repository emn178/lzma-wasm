# lzma-wasm

[![npm version](https://img.shields.io/npm/v/lzma-wasm.svg)](https://www.npmjs.com/package/lzma-wasm)
[![License](https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-blue.svg)](#license)

A high-performance, universal WebAssembly binding for the [`lzma-rust2`](https://github.com/hasenbanck/lzma-rust2) crate. It brings near-native LZMA, XZ, and LZIP compression and decompression to Node.js, modern browsers, and bundlers.

## Features

* **Near-Native Performance:** Powered by Rust and WebAssembly, heavily optimized for execution in V8/modern JS engines.
* **Universal & Zero-Config:** The Wasm binary is base64-inlined. **No `wasm-loader`, no static asset serving, and no Webpack/Vite configuration required.** Just import and use it anywhere.
* **Multi-Format Support:** Seamlessly supports `.xz` (modern, recommended), `.lzma` (legacy), and `.lz` (lzip) formats.
* **Zero-Allocation Decompression:** Expert APIs available to bypass JavaScript Garbage Collection (GC) overhead by decompressing directly into pre-allocated memory.
* **Safe & Robust:** Built-in memory limits to protect your runtime from Out-Of-Memory (OOM) crashes and malicious zip bombs.

## 📦 Installation

```bash
npm install lzma-wasm
# or
yarn add lzma-wasm
pnpm add lzma-wasm
```

## Import Methods

This library ships with ES Modules, CommonJS, and IIFE builds, making it compatible with any environment.

**1. ES Modules (Vite, Rollup, Deno, Node.js ESM)**
```javascript
import { initWasm, compress, decompress } from 'lzma-wasm';
```

**2. CommonJS (Node.js)**
```javascript
const { initWasm, compress, decompress } = require('lzma-wasm');
```

**3. Browser / CDN (Raw HTML)**
```html
<script src="https://cdn.jsdelivr.net/npm/lzma-wasm/dist/iife/index.js"></script>
<script>
  // Exposed globally as `LzmaWasm`
  const { initWasm, compress, decompress } = window.LzmaWasm;
</script>
```

## 🚀 Quick Start

**⚠️ Important:** You must call and await `initWasm()` once before using any compression or decompression methods.

```javascript
import { initWasm, compress, decompress } from 'lzma-wasm';

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

## ⚡ Advanced: Zero-Allocation Decompression

For extreme performance scenarios (e.g., high-frequency decompression, large files), you can avoid dynamic memory allocation and GC pressure by providing the `expectedSize`. The Wasm module will write directly into a pre-allocated buffer.

```javascript
// If you know the exact size of the uncompressed data beforehand:
const uncompressedSize = 2400; 

const result = decompress(compressed, { 
    expectedSize: uncompressedSize 
});
// 'result' will be a Uint8Array containing exactly 2400 bytes, 
// achieved with 0 internal reallocations.
```

## 📊 Performance Benchmarks

Using a non-rigorous test, we briefly evaluated the compression and decompression performance of various algorithms and compression levels within our test environment. *(Note: The observed speeds may appear extraordinarily high because highly repetitive JSON text data was used as the test sample, rather than dense binary executables.)*


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

## 📄 License

This project is dual-licensed under either the [MIT License](LICENSE-MIT) or the [Apache License, Version 2.0](LICENSE-APACHE), at your option. 

The underlying Rust compression logic is powered by [lzma-rust2](https://github.com/hasenbanck/lzma-rust2) (Apache-2.0).
