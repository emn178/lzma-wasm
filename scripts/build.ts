import { execSync } from 'node:child_process';
import fs from 'node:fs';
import esbuild from 'esbuild';

console.log("🚀 [1/4] 正在编译 Rust 为 WebAssembly...");
// 使用 release 模式编译，目标为 web
execSync('wasm-pack build --target web --release', { stdio: 'inherit' });

console.log("📦 [2/4] 正在将 Wasm 转换为 Base64 内联模块...");
const wasmBuffer = fs.readFileSync('./pkg/lzma_wasm_bg.wasm');
const base64Str = wasmBuffer.toString('base64');
// 生成一个虚拟的 JS 文件供 TS 引入
fs.writeFileSync('./lib/wasm-b64.ts', `export const WASM_BASE64: string = "${base64Str}";\n`);

console.log("🗜️  [3/4] 正在使用 esbuild 打包 CJS 和 ESM 产物...");
// 打包 ESM 版本
esbuild.buildSync({
    entryPoints: ['./lib/index.ts'],
    format: 'esm',
    outfile: './dist/esm/index.js',
    bundle: true,
    minify: true,
    // 忽略 node 内置模块的报错警告
    external: ['node:buffer'] 
});

// 打包 CJS 版本 (Node.js 专用)
esbuild.buildSync({
    entryPoints: ['./lib/index.ts'],
    format: 'cjs',
    outfile: './dist/cjs/index.cjs',
    bundle: true,
    minify: true,
    logOverride: { 'empty-import-meta': 'silent' }
});

// 打包 IIFE 版本 供老式 script 标签使用(提供最佳向下兼容性)
esbuild.buildSync({
    entryPoints: ['./lib/index.ts'],
    format: 'iife',
    globalName: 'lzma_wasm', // 暴露给 window.lzma_wasm
    outfile: './dist/iife/index.js',
    bundle: true,
    minify: true,
    logOverride: { 'empty-import-meta': 'silent' },
    footer: { js: 'window.LzmaWasm = lzma_wasm;' }
});

console.log("📝 [4/4] 正在生成 TypeScript 声明文件 (.d.ts)...");
// 调用 tsc 只生成类型文件
execSync('pnpm run tsc', { stdio: 'inherit' });

console.log("🧹 [5/5] 清理无用的内部类型声明...");
const internalDtsPath = './dist/wasm-b64.d.ts';
// 如果存在，直接删除
if (fs.existsSync(internalDtsPath)) {
    fs.unlinkSync(internalDtsPath);
}

console.log("✅ 构建完成！产物已存入 /dist 目录。");
