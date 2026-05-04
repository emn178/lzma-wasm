import fs from 'node:fs';
import path from 'node:path';

// 定义要读取的环境文件列表
const environments = ['esm', 'cjs', 'import', 'cdn'];
const fullTable = [];

environments.forEach(env => {
  const filePath = path.resolve(`./bench_result/${env}.json`);

  if (fs.existsSync(filePath)) {
    const rawData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    const cleanData = rawData.map(row => {
      // 解析 "XZ (快速 Lvl 1)" 提取格式和级别
      const match = row['测试场景'].match(/([A-Z]+).*Lvl\s(\d)/);
      const format = match ? match[1] : 'Unknown';
      const level = match ? parseInt(match[2], 10) : -1;

      return {
        "Env": env.toUpperCase(),    // 'CDN', 'CJS', 'ESM', 'IMPORT'
        "Platform": ["CDN", "IMPORT"].includes(env.toUpperCase()) ? "Browser" : "Nodejs",
        "Format": format,               // 'XZ', 'LZMA', 'LZIP'
        "Level": level,                // 1, 6, 9
        // 清洗字符串为纯数字，方便后续图表绘制
        "RawSizeKB": parseFloat(row['原始体积']),
        "CompressRate": parseFloat(row['压缩率']),
        "EncMBps": parseFloat((parseFloat(row['原始体积']) / parseFloat(row['压缩耗时 (ms)'])).toFixed(3)),
        "DecMBps": parseFloat((parseFloat(row['原始体积']) / parseFloat(row['解压耗时(动态) (ms)'])).toFixed(3)),
        "DecToBufMBps": parseFloat((parseFloat(row['原始体积']) / parseFloat(row['解压耗时(零分配) (ms)'])).toFixed(3)),
      };
    });

    fullTable.push(...cleanData);
  } else {
    console.warn(`⚠️ 未找到文件: ${filePath}`);
  }
});

// 输出扁平化的全表数据
fs.writeFileSync('./bench_result/full_benchmark.json', JSON.stringify(fullTable, null, 2));
console.table(fullTable);

console.log(`✅ 整合完毕！共生成 ${fullTable.length} 条有效数据记录。`);
