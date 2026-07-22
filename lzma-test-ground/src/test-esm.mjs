import { initWasm, compress, decompress, decompressToBuffer } from '@emn178/lzma-wasm';

import pkg from './core.js';

await pkg.run("ESM", initWasm, compress, decompress);

const result = await pkg.bench("ESM", initWasm, compress, decompress, decompressToBuffer);
 
console.log("最终结果:", JSON.stringify(result, null, 2));
