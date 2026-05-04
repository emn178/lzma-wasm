async function run(testName, initWasm, compress, decompress) {
  try {
    await initWasm();

    const text = `Hello Wasm from ${testName}! `.repeat(50);
    const data = new TextEncoder().encode(text);

    // 压缩
    const compressed = compress(data, { format: 'xz', level: 6 });
    console.log(`[${testName}] 压缩前: ${data.length}, 压缩后: ${compressed.length}`);

    // 解压
    const decompressed = decompress(compressed);
    const resultText = new TextDecoder().decode(decompressed);

    if (resultText === text) console.log(`✅ [${testName}] 测试通过！`);
    else console.error(`❌ [${testName}] 数据不匹配`);
    return resultText === text;
  } catch (err) {
    console.error(`❌ [${testName}] 测试失败:`, err);
    return false;
  }
}

/**
 * 高仿真测试数据生成器：生成约 4MB 的混合特征数据 (JSON字符串)
 */
function generateRealisticData() {
  console.log("🛠️ 正在生成约 9MB 的高仿真测试数据...");
  const data = [];
  const loremIpsum = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(10);

  for (let i = 0; i < 5000; i++) {
    data.push({
      id: i,
      uuid: `user-${Math.random().toString(36).substring(2, 10)}`,
      role: i % 5 === 0 ? "admin" : "user",
      timestamp: Date.now() - i * 1000,
      profile: loremIpsum,
      profile2: loremIpsum.slice(Math.floor(Math.random() * loremIpsum.length / 2), Math.floor(Math.random() * loremIpsum.length)),
      isActive: i % 2 === 0
    });
  }
  return new TextEncoder().encode(JSON.stringify(data));
}

/**
 * 通用耗时测量器
 */
async function measureBlock(name, fn, iterations = 3) {
  // 1. JIT Warm-up (预热运行 1 次，不计入成绩)
  await fn();

  // 2. 正式运行 N 次
  let totalTime = 0;
  for (let i = 0; i < iterations; i++) {
    const start = globalThis.performance.now();
    await fn();
    totalTime += (globalThis.performance.now() - start);
  }

  return totalTime / iterations;
}

/**
 * 核心 Benchmark 执行函数
 */
async function bench(tagName, initWasm, compress, decompress, decompressToBuffer) {
  console.log(`\n🚀 开始执行 Benchmark: [${tagName}]`);

  // 初始化 Wasm
  await initWasm();

  // 生成测试数据
  const rawData = generateRealisticData();
  const rawSizeKB = (rawData.length / 1024).toFixed(2);
  console.log(`✅ 数据准备完毕，原始大小: ${rawSizeKB} KB\n`);

  const results = [];
  // 预先分配好 Zero-Allocation 测试所需的 Buffer
  const preAllocatedBuffer = new Uint8Array(rawData.length);

  // 定义要测试的配置矩阵
  const configs = [
    { format: 'xz', level: 1, name: "XZ (快速 Lvl 1)" },
    { format: 'xz', level: 6, name: "XZ (平衡 Lvl 6)" },
    { format: 'xz', level: 9, name: "XZ (体积 Lvl 9)" },
    { format: 'lzma', level: 1, name: "LZMA (快速 Lvl 1)" },
    { format: 'lzma', level: 6, name: "LZMA (平衡 Lvl 6)" },
    { format: 'lzma', level: 9, name: "LZMA (体积 Lvl 9)" },
    { format: 'lzip', level: 1, name: "LZIP (快速 Lvl 1)" },
    { format: 'lzip', level: 6, name: "LZIP (平衡 Lvl 6)" },
    { format: 'lzip', level: 9, name: "LZIP (体积 Lvl 9)" },
  ];

  for (let i = 0; i < configs.length; i++) {
    const conf = configs[i];
    // ========== 测试 1: 压缩 ==========
    let compressedData;
    const compressTime = await measureBlock(`Compress ${conf.name}`, async () => {
      console.log(`🔧 测试配置: ${conf.name} (格式: ${conf.format}, 级别: ${conf.level})`);
      compressedData = compress(rawData, { format: conf.format, level: conf.level });
    }, 5); // 压缩较慢，迭代 5 次即可

    const compSizeKB = (compressedData.length / 1024).toFixed(2);
    const ratio = ((compressedData.length / rawData.length) * 100).toFixed(4) + "%";

    // ========== 测试 2: 动态内存解压 ==========
    const decompressDynamicTime = await measureBlock(`Decompress Dynamic ${conf.name}`, async () => {
      decompress(compressedData);
    }, 20); // 解压快，迭代 20 次

    // ========== 测试 3: Zero-Allocation 解压 ==========
    const decompressZeroAllocTime = await measureBlock(`Decompress Zero-Alloc ${conf.name}`, async () => {
      decompressToBuffer(compressedData, preAllocatedBuffer);
    }, 20);

    // 收集这一轮的成绩
    results.push({
      "测试场景": conf.name,
      "原始体积": `${rawSizeKB} KB`,
      "压缩后体积": `${compSizeKB} KB`,
      "压缩率": ratio,
      "压缩耗时 (ms)": compressTime.toFixed(2),
      "解压耗时(动态) (ms)": decompressDynamicTime.toFixed(2),
      "解压耗时(零分配) (ms)": decompressZeroAllocTime.toFixed(2),
      "零分配提速": `${decompressDynamicTime > decompressZeroAllocTime ? "+" : ""}${(((decompressDynamicTime - decompressZeroAllocTime) / decompressDynamicTime) * 100).toFixed(1)}%`
    });
  }

  // 漂亮地打印表格
  console.table(results);
  return results;
}

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(); // CJS
  } else {
    root.myLib = factory(); // Browser global
  }
}(typeof self !== 'undefined' ? self : this, function () {
  return { run, bench };
}));