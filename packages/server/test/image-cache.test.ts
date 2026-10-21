import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}), readFile: vi.fn(async () => { throw new Error("cache miss"); }) }));
import { readFile, writeFile } from "node:fs/promises";
import { abortImageDownloads, getImageBuffer, getImageUrl } from "../src/image-cache.js";
import { buildApi } from "../src/server.js";
import { Lobby } from "../src/lobby.js";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("production card-art proxy", () => {
  it("uses the actual full, small and cropped CDN paths without a duplicated cards directory", async () => {
    expect(await getImageUrl(89631139)).toBe("https://images.ygoprodeck.com/images/cards/89631139.jpg");
    expect(await getImageUrl(89631139, "small")).toBe("https://images.ygoprodeck.com/images/cards_small/89631139.jpg");
    expect(await getImageUrl(89631139, "crop")).toBe("https://images.ygoprodeck.com/images/cards_cropped/89631139.jpg");
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

describe("card-art routes", () => {
  const app = buildApi(new Lobby(async () => { throw new Error("unused"); }), () => null, () => null, async () => null);

  it("routes cropped, small and full art separately with immutable JPEG headers", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([255, 216, 255, 217])));
    vi.stubGlobal("fetch", fetch);
    for (const [prefix, directory, cachePath] of [["crop/", "cards_cropped", "/crop/"], ["small/", "cards_small", "/small/"], ["", "cards", "/img/"]]) {
      const response = await app.request(`/api/img/${prefix}89631139`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([255, 216, 255, 217]));
      expect(fetch).toHaveBeenLastCalledWith(`https://images.ygoprodeck.com/images/${directory}/89631139.jpg`, { signal: expect.any(AbortSignal) });
      expect(readFile).toHaveBeenLastCalledWith(expect.stringContaining(`${cachePath}89631139.jpg`));
      expect(writeFile).toHaveBeenLastCalledWith(expect.stringContaining(`${cachePath}89631139.jpg`), Buffer.from([255, 216, 255, 217]));
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid cropped codes before fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const code of ["0", "-1", "1.5", "abc", "Infinity"]) {
      const response = await app.request(`/api/img/crop/${code}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid code" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 404 when cropped art is unavailable upstream", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const response = await app.request("/api/img/crop/89631139");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "image not found" });
    expect(fetch).toHaveBeenCalledWith("https://images.ygoprodeck.com/images/cards_cropped/89631139.jpg", { signal: expect.any(AbortSignal) });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("does not swallow crop-like paths in the full-image route", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await app.request("/api/img/crop")).status).toBe(400);
    expect((await app.request("/api/img/crop/89631139/extra")).status).toBe(404);
    expect((await app.request("/api/img/cropped/89631139")).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
