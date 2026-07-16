# lzma-wasm

[![npm version](https://img.shields.io/npm/v/lzma-wasm.svg)](https://www.npmjs.com/package/lzma-wasm)
[![License](https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-blue.svg)](#license)

**[View on GitHub](https://github.com/Wu-Yijun/lzma-wasm)** | **[View on npm](https://www.npmjs.com/package/lzma-wasm)**

A high-performance WebAssembly binding for [`lzma-rust2`](https://github.com/hasenbanck/lzma-rust2)
(currently **0.16.5**) providing LZMA-Alone, XZ, and LZIP compression and decompression for
Node.js, browsers, and bundlers.

## Features

- Near-native performance via Rust / WebAssembly
- Embedded WASM (Base64-inlined) for zero-config installs
- Optional **external WASM** entry for Workers / bundlers that prefer a single `.wasm` asset
- Correct destination-buffer and output-limit handling
- Accurate option semantics for LZMA-Alone memory limits vs decompressed output caps

There is **no public streaming API** in this release. Applications that need streaming should
buffer input explicitly.

## Install

```bash
npm install lzma-wasm
# or
yarn add lzma-wasm
pnpm add lzma-wasm
```

Git checkouts do **not** include built `dist/` or WASM (those are build outputs). Use a published
npm package, or run `pnpm run build` / consume a packed `.tgz` after building.

## Embedded entry (default)

WASM bytes are Base64-inlined. No asset serving is required.

```js
import { initWasm, compress, decompress } from "lzma-wasm";

await initWasm();
const compressed = compress(data, { format: "xz", level: 6 });
const out = decompress(compressed);
```

`initWasm()` shares an in-flight Promise across concurrent callers. After a failure, a later
call can retry. `initWasmSync()` throws if asynchronous initialization is already in progress.

## External WASM entry

```js
import { initWasm, compress, decompress } from "lzma-wasm/external";

// Browser/Worker: zero-arg uses the shipped `.wasm` URL next to this module.
await initWasm();

// Explicit URL (recommended for Workers / custom asset layouts):
// await initWasm(new URL("lzma-wasm/lzma_wasm_bg.wasm", import.meta.url));
```

Package paths:

- JS: `lzma-wasm/external`
- WASM: `lzma-wasm/lzma_wasm_bg.wasm` → `dist/wasm/lzma_wasm_bg.wasm`

The external JS bundle does **not** embed a Base64 copy of the WASM.

Export conditions for `lzma-wasm/external`:

| Condition | Entry | Notes |
|-----------|-------|-------|
| `browser` / default `import` | `dist/esm/external.js` | No `node:` imports — safe for Vite/esbuild |
| `node` `import` | `dist/esm/external-node.js` | Zero-arg reads `.wasm` from disk |
| `node` / default `require` | `dist/cjs/external-node.cjs` | Same for CommonJS |

Sync init still requires bytes or a `WebAssembly.Module` (cannot fetch a URL).

## Decompression options

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
- `lzmaMemoryLimit` does **not** protect XZ or LZIP.

```ts
decompressToBuffer(
  compressed,
  outBuffer,
  options?: { lzmaMemoryLimit?: number; memLimit?: number } | number,
): number;
```

`outBuffer.byteLength` is the hard output ceiling. Undersized buffers throw.

## Compression options

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

## Build / test

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
cargo test
pnpm pack --dry-run
```

Native interop tests require `xz` (`xz-utils`) and `lzip`. Browser tests require Playwright Chromium.

## License

Dual-licensed under MIT or Apache-2.0. Underlying codec: [lzma-rust2](https://github.com/hasenbanck/lzma-rust2) (Apache-2.0 / MIT as upstream declares).
