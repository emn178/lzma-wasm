import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compress, createXzDecoder, decompress, initWasm } from "../lib/index.ts";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function checkSystemCommand(cmd: string): boolean {
  const res = spawnSync(cmd, ["--version"]);
  return res.status === 0;
}

function nativeCompress(
  data: Uint8Array,
  format: "xz" | "lzma" | "lzip",
  level: number,
): Uint8Array {
  let cmd = "";
  let args: string[] = [];

  if (format === "xz") {
    cmd = "xz";
    args = ["-z", "-c", `--format=xz`, `-${level}`];
  } else if (format === "lzma") {
    cmd = "xz";
    args = ["-z", "-c", `--format=lzma`, `-${level}`];
  } else {
    cmd = "lzip";
    args = ["-c", `-${level}`];
  }

  const result = spawnSync(cmd, args, {
    input: data,
    maxBuffer: 1024 * 1024 * 512,
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} compress failed: ${result.stderr?.toString()}`);
  }
  return result.stdout;
}

function nativeDecompress(
  data: Uint8Array,
  format: "xz" | "lzma" | "lzip",
): Uint8Array {
  let cmd = "";
  let args: string[] = [];

  if (format === "xz" || format === "lzma") {
    cmd = "xz";
    args = ["-d", "-c"];
  } else {
    cmd = "lzip";
    args = ["-d", "-c"];
  }

  const result = spawnSync(cmd, args, {
    input: data,
    maxBuffer: 1024 * 1024 * 512,
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} decompress failed: ${result.stderr?.toString()}`);
  }
  return result.stdout;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function seededBytes(seed: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let block = createHash("sha256").update(seed).digest();
  let offset = 0;
  while (offset < length) {
    const take = Math.min(block.length, length - offset);
    out.set(block.subarray(0, take), offset);
    offset += take;
    block = createHash("sha256").update(block).digest();
  }
  return out;
}

describe("Native interoperability", () => {
  const hasXz = checkSystemCommand("xz");
  const hasLzip = checkSystemCommand("lzip");

  beforeAll(async () => {
    await initWasm();
    if (!hasXz) console.warn("xz CLI missing; native XZ/LZMA tests will skip");
    if (!hasLzip) console.warn("lzip CLI missing; native LZIP tests will skip");
  });

  it.skipIf(!hasXz)("incrementally decodes native XZ streams", () => {
    const data = seededBytes("native-xz-stream", 512 * 1024);
    const compressed = nativeCompress(data, "xz", 6);

    for (const chunkSize of [31, 4093, 65536]) {
      const decoder = createXzDecoder();
      const output: Buffer[] = [];
      let emittedBeforeFinish = false;
      for (let offset = 0; offset < compressed.byteLength; offset += chunkSize) {
        const chunk = decoder.write(compressed.subarray(offset, offset + chunkSize));
        if (chunk.byteLength) emittedBeforeFinish = true;
        output.push(Buffer.from(chunk));
      }
      output.push(Buffer.from(decoder.finish()));
      expect(Buffer.concat(output)).toEqual(Buffer.from(data));
      expect(emittedBeforeFinish).toBe(true);
    }
  }, 120_000);

  it("loads committed native fixtures", () => {
    const metaPath = path.join(fixturesDir, "manifest.json");
    expect(existsSync(metaPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(metaPath, "utf8")) as Array<{
      file: string;
      format: string;
      preset: number;
      sourceSha256: string;
      compressedSha256: string;
    }>;

    for (const entry of manifest) {
      const compressed = readFileSync(path.join(fixturesDir, entry.file));
      expect(sha256(compressed)).toBe(entry.compressedSha256);
      const out = decompress(compressed);
      expect(sha256(out)).toBe(entry.sourceSha256);
    }
  });

  const payloads = [
    { name: "tiny", data: seededBytes("interop-tiny", 32) },
    { name: "textish", data: new TextEncoder().encode("interop ".repeat(200)) },
    { name: "binary-8k", data: seededBytes("interop-8k", 8 * 1024) },
    { name: "zeros-64k", data: new Uint8Array(64 * 1024) },
  ];

  for (const format of ["xz", "lzma", "lzip"] as const) {
    describe(format, () => {
      const shouldSkip =
        (format === "lzip" && !hasLzip) || (format !== "lzip" && !hasXz);

      for (const level of [0, 6, 9] as const) {
        for (const { name, data } of payloads) {
          it.skipIf(shouldSkip)(
            `native->wasm ${name} level ${level}`,
            () => {
              const nativeCompressed = nativeCompress(data, format, level);
              const out = decompress(nativeCompressed);
              expect(Buffer.from(out)).toEqual(Buffer.from(data));
            },
          );

          it.skipIf(shouldSkip)(
            `wasm->native ${name} level ${level}`,
            () => {
              const wasmCompressed = compress(data, { format, level });
              const out = nativeDecompress(wasmCompressed, format);
              expect(Buffer.from(out)).toEqual(Buffer.from(data));
            },
          );
        }
      }

      it(`wasm roundtrip ${format}`, () => {
        const data = seededBytes(`round-${format}`, 1024);
        const out = decompress(compress(data, { format, level: 3 }));
        expect(Buffer.from(out)).toEqual(Buffer.from(data));
      });
    });
  }
});
