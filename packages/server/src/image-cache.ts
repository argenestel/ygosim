import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const IMG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "img");
const YGOPRODECK_CDN = "https://images.ygoprodeck.com/images/cards";

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

  try {
    // Try to read from cache
    return await readFile(path);
  } catch {
    // Cache miss, download from CDN
    try {
      const url = await getImageUrl(code, size);
      const res = await fetch(url);
      if (!res.ok) return null;

      const buffer = Buffer.from(await res.arrayBuffer());

      // Save to cache asynchronously (don't await)
      const dirPath = dirname(path);
      mkdir(dirPath, { recursive: true })
        .then(() => writeFile(path, buffer))
        .catch((e) => console.warn(`[image-cache] failed to save ${path}:`, e));

      return buffer;
    } catch (e) {
      console.warn(`[image-cache] failed to download ${code}:`, e);
      return null;
    }
  }
}
