import { describe, expect, it } from "vitest";
import {
  beginAsyncInit,
  beginSyncInit,
  createInitStatus,
} from "../lib/runtime.ts";
import type { InitOutput } from "../pkg/lzma_wasm.js";

describe("init state machine", () => {
  it("shares one in-flight async promise", async () => {
    const status = createInitStatus();
    let starts = 0;
    const run = () => {
      starts += 1;
      return new Promise<InitOutput>((resolve) => {
        setTimeout(() => resolve({} as InitOutput), 20);
      });
    };

    const p1 = beginAsyncInit(status, run);
    const p2 = beginAsyncInit(status, run);
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    expect(starts).toBe(1);
    expect(status.isReady).toBe(true);
  });

  it("clears in-flight state after async failure so retry works", async () => {
    const status = createInitStatus();
    let attempt = 0;
    const run = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return {} as InitOutput;
    };

    await expect(beginAsyncInit(status, run)).rejects.toThrow("boom");
    expect(status.initPromise).toBeNull();
    expect(status.isReady).toBe(false);

    await expect(beginAsyncInit(status, run)).resolves.toBeTruthy();
    expect(status.isReady).toBe(true);
  });

  it("throws from sync init while async is in flight", async () => {
    const status = createInitStatus();
    let release!: (value: InitOutput) => void;
    const pending = new Promise<InitOutput>((resolve) => {
      release = resolve;
    });

    const asyncPromise = beginAsyncInit(status, () => pending);
    expect(() => beginSyncInit(status, () => ({} as InitOutput))).toThrow(
      /Asynchronous initialization is already in progress/,
    );

    release({} as InitOutput);
    await asyncPromise;
    expect(beginSyncInit(status, () => ({} as InitOutput))).toBeTruthy();
  });

  it("allows sync retry after async failure", async () => {
    const status = createInitStatus();
    await expect(
      beginAsyncInit(status, async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    const wasm = beginSyncInit(status, () => ({ ok: true }) as unknown as InitOutput);
    expect(wasm).toEqual({ ok: true });
    expect(status.isReady).toBe(true);
  });
});
