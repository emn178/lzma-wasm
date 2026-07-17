import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("package contents", () => {
  it("ships browser-safe and node external entries without base64 payload", () => {
    expect(existsSync("dist/esm/external.js")).toBe(true);
    expect(existsSync("dist/esm/external-node.js")).toBe(true);
    expect(existsSync("dist/cjs/external-node.cjs")).toBe(true);
    expect(existsSync("dist/external.d.ts")).toBe(true);
    expect(existsSync("dist/wasm/lzma_wasm_bg.wasm")).toBe(true);

    const browserJs = readFileSync("dist/esm/external.js", "utf8");
    expect(browserJs).not.toMatch(/WASM_BASE64/);
    expect(browserJs).not.toMatch(/node:fs/);
    expect(browserJs).not.toMatch(/node:url/);
    expect(browserJs).not.toMatch(/[A-Za-z0-9+/]{2000,}={0,2}/);

    const pack = execSync("pnpm pack --dry-run --json", {
      encoding: "utf8",
    });
    const files = JSON.parse(pack) as Array<{ name?: string; files?: Array<{ path: string }> }>;
    const entry = Array.isArray(files) ? files[0] : files;
    const paths = (entry.files ?? []).map((f) => f.path);
    expect(paths.some((p) => p.includes("esm/external.js"))).toBe(true);
    expect(paths.some((p) => p.includes("esm/external-node.js"))).toBe(true);
    expect(paths.some((p) => p.includes("wasm/lzma_wasm_bg.wasm"))).toBe(true);
    expect(paths.some((p) => p.startsWith("pkg/"))).toBe(false);
  });

  it("browser external bundle resolves under esbuild browser platform", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "lzma-ext-bundle-"));
    try {
      const outfile = path.join(tmp, "out.js");
      esbuild.buildSync({
        entryPoints: [path.join(root, "dist/esm/external.js")],
        bundle: true,
        outfile,
        platform: "browser",
        format: "esm",
        logLevel: "silent",
      });
      const out = readFileSync(outfile, "utf8");
      expect(out).not.toMatch(/node:fs/);
      expect(out).not.toMatch(/node:url/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps relative wasm path reachable from external ESM", () => {
    const fromExternal = path.resolve("dist/esm", "../wasm/lzma_wasm_bg.wasm");
    expect(existsSync(fromExternal)).toBe(true);
  });

  it("publishes self-contained TypeScript declarations", () => {
    for (const file of [
      "dist/index.d.ts",
      "dist/external.d.ts",
      "dist/external-node.d.ts",
      "dist/runtime.d.ts",
      "dist/public-types.d.ts",
    ]) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/from ['"]\.\.\/pkg\//);
      expect(text).not.toMatch(/from ['"][^'"]*pkg\/lzma_wasm/);
    }
  });

  it(
    "consumer TypeScript compiles against an unpacked package tarball",
    () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), "lzma-wasm-pack-"));
      try {
        const tgz = execSync("pnpm pack", {
          encoding: "utf8",
          cwd: root,
        })
          .trim()
          .split(/\s+/)
          .pop()!;
        const tgzPath = path.resolve(root, tgz);
        execSync(`tar -xzf "${tgzPath}" -C "${tmp}"`);
        const pkgRoot = path.join(tmp, "package");

        const consumerDir = path.join(tmp, "consumer");
        mkdirSync(consumerDir);
        writeFileSync(
          path.join(consumerDir, "tsconfig.json"),
          JSON.stringify(
            {
              compilerOptions: {
                module: "nodenext",
                moduleResolution: "nodenext",
                strict: true,
                noEmit: true,
                types: [],
              },
              include: ["main.ts"],
            },
            null,
            2,
          ),
        );
        writeFileSync(
          path.join(consumerDir, "package.json"),
          JSON.stringify(
            {
              type: "module",
              dependencies: {
                "lzma-wasm": `file:${pkgRoot}`,
              },
            },
            null,
            2,
          ),
        );
        writeFileSync(
          path.join(consumerDir, "main.ts"),
          `
import {
  initWasm,
  compress,
  createDecoder,
  createEncoder,
  decompress,
  type DecompressOptions,
  type InitOutput,
} from "lzma-wasm";
import {
  initWasm as initExternal,
  type SyncInitInput,
} from "lzma-wasm/external";

declare function assert(x: InitOutput): void;
declare function assertOpts(x: DecompressOptions): void;
declare function assertSync(x: SyncInitInput): void;

export async function run(): Promise<Uint8Array> {
  const ready = await initWasm();
  assert(ready);
  // Compatibility: raw export still typed.
  void ready.compress_xz;
  const opts: DecompressOptions = { maxOutputSize: 1024 };
  assertOpts(opts);
  const bytes = compress(new Uint8Array([1, 2, 3]), { format: "xz", level: 1 });
  const encoder = createEncoder({
    format: "xz",
    level: 1,
    dictionarySize: 256 * 1024,
    blockSize: 1024 * 1024,
  });
  encoder.write(new Uint8Array([1, 2]));
  encoder.finish();
  const stream = createDecoder({ format: "xz", maxOutputSize: 1024 });
  stream.write(bytes);
  stream.finish();
  await initExternal(new URL("lzma-wasm/lzma_wasm_bg.wasm", import.meta.url));
  assertSync(bytes);
  return decompress(bytes, opts);
}
`,
        );

        execSync("pnpm install", { cwd: consumerDir, stdio: "pipe" });
        execSync("pnpm exec tsc -p tsconfig.json", {
          cwd: consumerDir,
          stdio: "pipe",
          env: {
            ...process.env,
            PATH: `${path.join(root, "node_modules/.bin")}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        const packed = path.join(root, "lzma-wasm-1.0.7.tgz");
        if (existsSync(packed)) rmSync(packed);
      }
    },
    120_000,
  );

  it("external zero-arg init works in Node ESM and CJS", async () => {
    const esm = await import(
      pathToFileURL(path.join(root, "dist/esm/external-node.js")).href
    );
    await esm.initWasm();
    const out = esm.decompress(
      esm.compress(new Uint8Array([7, 8, 9]), { format: "xz", level: 0 }),
    );
    expect(Array.from(out)).toEqual([7, 8, 9]);

    const require = createRequire(import.meta.url);
    const cjs = require(path.join(root, "dist/cjs/external-node.cjs"));
    await cjs.initWasm();
    const out2 = cjs.decompress(
      cjs.compress(new Uint8Array([7, 8, 9]), { format: "xz", level: 0 }),
    );
    expect(Array.from(out2)).toEqual([7, 8, 9]);
  });
});
