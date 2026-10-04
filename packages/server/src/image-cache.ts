import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const IMG_DIR = process.env.VERCEL === "1" ? join(tmpdir(), "ygosim-img") : join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "img");
const YGOPRODECK_CDN = "https://images.ygoprodeck.com/images";
const pending = new Map<string, Promise<Buffer | null>>();
let activeDownloads = 0;
const waiting: (() => void)[] = [];
const controllers = new Set<AbortController>();
let generation = 0;

export function abortImageDownloads(): void {
  generation++;
  for (const controller of controllers) controller.abort();
}

export interface CacheEntry {
  url: string;
  size: "full" | "small";
  code: number;
}

export async function ensureImgDir() {
  try {
    await mkdir(IMG_DIR, { recursive: true });
  } catch {
    /* directory may already exist */
  }
}

function getImagePath(code: number, size: "full" | "small" = "full"): string {
  const dir = size === "small" ? join(IMG_DIR, "small") : IMG_DIR;
  const fileName = `${code}.jpg`;
  return join(dir, fileName);
}

export async function getImageUrl(code: number, size: "full" | "small" = "full"): Promise<string> {
  const sizeDir = size === "small" ? "cards_small" : "cards";
  return `${YGOPRODECK_CDN}/${sizeDir}/${code}.jpg`;
}

export async function getImageBuffer(code: number, size: "full" | "small" = "full"): Promise<Buffer | null> {
  const path = getImagePath(code, size);
  const version = generation;
  try {
    return await readFile(path);
  } catch {
    if (version !== generation) return null;
    const existing = pending.get(path);
    if (existing) return existing;
    if (pending.size >= 128) return null;
    const controller = new AbortController();
    controllers.add(controller);
    const download = (async () => {
      if (activeDownloads >= 16) await new Promise<void>(resolve => waiting.push(resolve));
      else activeDownloads++;
      try {
        if (controller.signal.aborted) return null;
        const res = await fetch(await getImageUrl(code, size), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!res.ok || !res.body) { await res.body?.cancel(); return null; }
        const reader = res.body.getReader();
        const chunks: Buffer[] = [];
        let length = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 3 * 1024 * 1024) { await reader.cancel(); return null; }
          chunks.push(Buffer.from(value));
        }
        if (!length) return null;
        const buffer = Buffer.concat(chunks, length);
        try { await mkdir(dirname(path), { recursive: true }); await writeFile(path, buffer); }
        catch { console.warn("[image-cache] could not persist card art"); }
        return buffer;
      } catch {
        console.warn("[image-cache] card-art download unavailable");
        return null;
      } finally {
        controllers.delete(controller);
        const resume = waiting.shift();
        if (resume) resume();
        else activeDownloads--;
      }
    })();
    pending.set(path, download);
    try { return await download; }
    finally { pending.delete(path); }
  }
}
