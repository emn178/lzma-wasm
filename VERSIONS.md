# Versions and change notes

Recorded while preparing correctness / packaging improvements (2026-07-15).

## Baseline

- Repository: https://github.com/Wu-Yijun/lzma-wasm
- Baseline release tag: **`v1.0.7`** /
  commit **`caefa23824cce248c18876e1ca0bce34e984dd77`**

## Codec / toolchain

| Component | Version |
|-----------|---------|
| `lzma-rust2` | `0.16.5` (baseline fixes first on `0.16.2`, then upgraded for empty-XZ fix in `0.16.4` and hardening in `0.16.5`) |
| `wasm-bindgen` | `0.2.120` |
| npm package | `1.0.7` |
| Rust crate | `0.1.0` |

## Behavior / packaging changes in this work

1. Destination-too-small detection for `decompress_to_buffer` / `expectedSize`.
2. `maxOutputSize` enforced while streaming decoder output in chunks.
3. Accurate `lzmaMemoryLimit` / deprecated `memLimit` docs and validation.
4. Strict compression `format` / `level` validation.
5. Format detection order without a global six-byte reject gate.
6. LZIP member-boundary scan (trailer `member_size`) rejecting trailing malformed data.
7. External WASM entry with browser-safe and Node-specific builds via export conditions.
8. Concurrent `initWasm` sharing and `initWasmSync` conflict throw.
9. Published `.d.ts` files no longer reference unpublished `pkg/`.
10. `InitOutput` keeps the full wasm-bindgen export surface for compatibility.

## Known limitations

- Streaming decode is XZ-only until `lzma-rust2` exposes a resumable LZMA1 decoder (see
  `jobs/DECODER_FEASIBILITY_BLOCKER.md`).
- Git checkouts do not ship built `dist/`; consume a published package or build locally / use a packed `.tgz`.

## 2026-07-21 streaming encoder / memory-limit work

- Fork package: `@emn178/lzma-wasm@1.1.0` (`https://github.com/emn178/lzma-wasm`).
- Added streaming LZIP and LZMA-Alone encoders via `createEncoder({ format: "lzip" | "lzma" })`.
- Split public types into `StreamEncoderFormat` / `StreamDecoderFormat` (decoder remains `"xz"`).
- Fixed one-shot `lzmaMemoryLimit` bytes→KiB conversion at the Rust/`lzma-rust2` boundary.
- Documented decoder feasibility blocker for true LZIP/LZMA streaming decode.
