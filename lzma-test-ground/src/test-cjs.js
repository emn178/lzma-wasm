const { initWasm, compress, decompress, decompressToBuffer } = require('lzma-wasm');

const pkg = require('./core.js');

pkg.run("CJS", initWasm, compress, decompress).then(() => {
  console.log("初始化完成，开始基准测试...");
  return pkg.bench("CJS", initWasm, compress, decompress, decompressToBuffer)
}).then(result => {
  console.log("最终结果:", JSON.stringify(result, null, 2));
});
