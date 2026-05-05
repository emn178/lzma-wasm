import { initWasmSync, compress, decompress, decompressToBuffer } from 'lzma-wasm';

import pkg from './core.js';

initWasmSync();
await pkg.run("ESM", () => { }, compress, decompress);

const result = await pkg.bench("ESM", () => { }, compress, decompress, decompressToBuffer);

console.log("最终结果:", JSON.stringify(result, null, 2));