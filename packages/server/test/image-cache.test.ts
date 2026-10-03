import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}), readFile: vi.fn(async () => { throw new Error("cache miss"); }) }));
import { writeFile } from "node:fs/promises";
import { abortImageDownloads, getImageBuffer, getImageUrl } from "../src/image-cache.js";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("production card-art proxy", () => {
  it("uses the actual full and small CDN paths without a duplicated cards directory", async () => {
    expect(await getImageUrl(89631139)).toBe("https://images.ygoprodeck.com/images/cards/89631139.jpg");
    expect(await getImageUrl(89631139, "small")).toBe("https://images.ygoprodeck.com/images/cards_small/89631139.jpg");
  });

  it("deduplicates concurrent downloads and imposes a timeout", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([255, 216, 255, 217]), { headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetch);
    const images = await Promise.all([getImageBuffer(89631139), getImageBuffer(89631139)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://images.ygoprodeck.com/images/cards/89631139.jpg", { signal: expect.any(AbortSignal) });
    expect(images[0]).toEqual(Buffer.from([255, 216, 255, 217]));
    expect(images[1]).toEqual(images[0]);
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it("does not poison the cache after a temporary download failure", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("private upstream detail"))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetch);
    try {
      expect(await getImageBuffer(89631139)).toBeNull();
      expect(await getImageBuffer(89631139)).toEqual(Buffer.from([1, 2, 3]));
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|89631139/);
    } finally { log.mockRestore(); }
  });

  it("queues bursts instead of failing legitimate requests beyond sixteen active downloads", async () => {
    const releases: ((response: Response) => void)[] = [];
    const fetch = vi.fn(() => new Promise<Response>(resolve => releases.push(resolve)));
    vi.stubGlobal("fetch", fetch);
    const images = Array.from({ length: 17 }, (_, index) => getImageBuffer(1000 + index));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(16);
    releases[0]!(new Response(new Uint8Array([1])));
    await images[0];
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(17);
    for (const release of releases.slice(1)) release(new Response(new Uint8Array([1])));
    expect((await Promise.all(images)).every(buffer => buffer?.length === 1)).toBe(true);
  });

  it("rejects oversized or empty image bodies without writing cache files", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(new Uint8Array(3 * 1024 * 1024 + 1)))
      .mockResolvedValueOnce(new Response(new Uint8Array())));
    expect(await getImageBuffer(89631139)).toBeNull();
    expect(await getImageBuffer(89631139)).toBeNull();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("cancels active and queued upstream requests during shutdown", async () => {
    const fetch = vi.fn((_url: string, options: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetch);
    try {
      const images = Array.from({ length: 17 }, (_, index) => getImageBuffer(2000 + index));
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(fetch).toHaveBeenCalledTimes(16);
      abortImageDownloads();
      expect(await Promise.all(images)).toEqual(Array(17).fill(null));
      expect(fetch).toHaveBeenCalledTimes(16);
      expect(writeFile).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
