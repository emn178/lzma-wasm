import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import esbuild from "esbuild";

const root = process.cwd();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

console.log("🚀 [1/5] Compiling Rust to WebAssembly...");
execSync("wasm-pack build --target web --release", { stdio: "inherit" });

console.log("📦 [2/5] Converting Wasm into an inline Base64 module...");
const wasmBuffer = fs.readFileSync("./pkg/lzma_wasm_bg.wasm");
const base64Str = wasmBuffer.toString("base64");
fs.writeFileSync(
  "./lib/wasm-b64.ts",
  `export const WASM_BASE64: string = "${base64Str}";\n`,
);

const wasmOutDir = "./dist/wasm";
ensureDir(wasmOutDir);
fs.copyFileSync("./pkg/lzma_wasm_bg.wasm", path.join(wasmOutDir, "lzma_wasm_bg.wasm"));

console.log("🗜️  [3/5] Bundling ESM/CJS/IIFE and external entries...");

const shared = {
  bundle: true,
  minify: true,
  target: ["es2020"],
};

esbuild.buildSync({
  ...shared,
  entryPoints: ["./lib/index.ts"],
  format: "esm",
  outfile: "./dist/esm/index.js",
  external: ["node:buffer"],
});

esbuild.buildSync({
  ...shared,
  entryPoints: ["./lib/index.ts"],
  format: "cjs",
  outfile: "./dist/cjs/index.cjs",
  logOverride: { "empty-import-meta": "silent" },
});

esbuild.buildSync({
  ...shared,
  entryPoints: ["./lib/index.ts"],
  format: "iife",
  globalName: "lzma_wasm",
  outfile: "./dist/iife/index.js",
  logOverride: { "empty-import-meta": "silent" },
  footer: { js: "window.LzmaWasm = lzma_wasm;" },
});

// Browser-safe external (default / browser condition) — no node: imports.
esbuild.buildSync({
  ...shared,
  entryPoints: ["./lib/external.ts"],
  format: "esm",
  outfile: "./dist/esm/external.js",
});

const cjsImportMetaBanner =
  "const import_meta_url = require('node:url').pathToFileURL(__filename).href;";

// Node ESM external — may import node:fs/promises and node:url.
esbuild.buildSync({
  ...shared,
  entryPoints: ["./lib/external-node.ts"],
  format: "esm",
  outfile: "./dist/esm/external-node.js",
  platform: "node",
  external: ["node:fs/promises", "node:url"],
});

// Node CJS external.
esbuild.buildSync({
  ...shared,
  entryPoints: ["./lib/external-node.ts"],
  format: "cjs",
  outfile: "./dist/cjs/external-node.cjs",
  platform: "node",
  banner: { js: cjsImportMetaBanner },
  define: { "import.meta.url": "import_meta_url" },
  external: ["node:fs/promises", "node:url"],
});

console.log("📝 [4/5] Generating TypeScript declaration files (.d.ts)...");
execSync("pnpm run tsc", { stdio: "inherit", cwd: root });

console.log("🧹 [5/5] Cleaning up non-public declarations and verifying package types...");
for (const file of ["./dist/wasm-b64.d.ts"]) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

const publicDts = [
  "./dist/index.d.ts",
  "./dist/external.d.ts",
  "./dist/external-node.d.ts",
  "./dist/external-shared.d.ts",
  "./dist/runtime.d.ts",
  "./dist/public-types.d.ts",
];
for (const file of publicDts) {
  if (!fs.existsSync(file)) {
    throw new Error(`missing declaration file: ${file}`);
  }
  const text = fs.readFileSync(file, "utf8");
  if (/(from|import)\s+['"][^'"]*pkg\/lzma_wasm/.test(text) || /from\s+['"]\.\.\/pkg\//.test(text)) {
    throw new Error(`${file} still references unpublished pkg/ types`);
  }
}

const browserExternal = fs.readFileSync("./dist/esm/external.js", "utf8");
if (browserExternal.includes("node:fs") || browserExternal.includes("node:url")) {
  throw new Error("browser external bundle must not reference node: builtins");
}

console.log("✅ Build complete! Outputs saved to the /dist directory.");
