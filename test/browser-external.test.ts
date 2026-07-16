import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(root, "../dist");
const smokeHtml = path.join(root, "fixtures/browser-smoke.html");

function contentType(filePath: string): string {
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

async function startStaticServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (urlPath === "/smoke.html") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(smokeHtml).pipe(res);
      return;
    }
    const filePath = path.join(dist, urlPath.replace(/^\//, ""));
    if (!filePath.startsWith(dist) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind static server");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("browser external entry", () => {
  let closeServer: (() => Promise<void>) | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    const server = await startStaticServer();
    closeServer = server.close;
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (closeServer) await closeServer();
  });

  it(
    "loads wasm over HTTP, shares concurrent init as one request, worker and retry work",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const wasmRequests: string[] = [];
        page.on("request", (req) => {
          if (req.url().includes("lzma_wasm_bg.wasm")) wasmRequests.push(req.url());
        });

        await page.goto(`${baseUrl}/smoke.html?mode=main`, {
          waitUntil: "networkidle",
        });
        await page.waitForFunction(() => (window as any).__LZMA_TEST__);
        const main = await page.evaluate(() => (window as any).__LZMA_TEST__);
        expect(main).toEqual({ ok: true });
        // Concurrent Promise.all(initWasm, initWasm) must issue exactly one WASM fetch.
        expect(wasmRequests.length).toBe(1);

        const workerPage = await browser.newPage();
        await workerPage.goto(`${baseUrl}/smoke.html?mode=worker`, {
          waitUntil: "networkidle",
        });
        await workerPage.waitForFunction(() => (window as any).__LZMA_TEST__);
        const worker = await workerPage.evaluate(() => (window as any).__LZMA_TEST__);
        expect(worker).toEqual({ ok: true });
        await workerPage.close();

        const retryPage = await browser.newPage();
        await retryPage.goto(`${baseUrl}/smoke.html?mode=retry`, {
          waitUntil: "networkidle",
        });
        await retryPage.waitForFunction(() => (window as any).__LZMA_TEST__);
        const retry = await retryPage.evaluate(() => (window as any).__LZMA_TEST__);
        expect(retry.ok).toBe(true);
        expect(String(retry.firstError).length).toBeGreaterThan(0);
        await retryPage.close();
      } finally {
        await browser.close();
      }
    },
    120_000,
  );
});
