import { OcgMessageType, type OcgCoreSync, type OcgDuelHandle } from "ocgcore-wasm";
import createCore from "../vendor/ocgcore/index.mjs";

/** The Emscripten object captured by ocgcore-wasm's runtime callback. */
interface NativeModule {
  HEAP8: Int8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _ocgapiDuelGetMessage(handle: number, length: number): number;
  getValue(pointer: number, type: "i32"): number;
}

const U32 = 4;
const INFO_LOCATION = 10;
const SUM_ENTRY = 18;
const PARSED_SUM_ENTRY = 14;

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

/**
 * Rewrite the two message records whose wire layout in core 11.0 differs
 * from the decoder shipped in ocgcore-wasm 0.1.2.
 *
 * The function keeps every other framed record byte-for-byte identical. An
 * invalid or unknown record is returned unchanged so the dependency retains
 * its existing handling (including warnings for unsupported messages).
 */
export function normalizeCoreMessageBuffer(raw: Uint8Array): Uint8Array {
  const frames: Uint8Array[] = [];
  let offset = 0;
  let changed = false;

  while (offset < raw.byteLength) {
    if (offset + U32 > raw.byteLength) return raw;
    const length = readU32(raw, offset);
    const start = offset + U32;
    const end = start + length;
    if (length < 1 || end > raw.byteLength) return raw;
    const frame = raw.slice(start, end);
    const normalized = normalizeFrame(frame);
    frames.push(normalized);
    changed ||= normalized !== frame;
    offset = end;
  }
  if (!changed) return raw;

  const total = frames.reduce((sum, frame) => sum + U32 + frame.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  offset = 0;
  for (const frame of frames) {
    view.setUint32(offset, frame.byteLength, true);
    offset += U32;
    out.set(frame, offset);
    offset += frame.byteLength;
  }
  return out;
}

function normalizeFrame(frame: Uint8Array): Uint8Array {
  if (frame[0] === OcgMessageType.SHUFFLE_SET_CARD) return normalizeShuffleSetCard(frame);
  if (frame[0] === OcgMessageType.SELECT_SUM) return normalizeSelectSum(frame);
  return frame;
}

/** Core writes the shuffle count as uint8; ocgcore-wasm reads it as uint32. */
function normalizeShuffleSetCard(frame: Uint8Array): Uint8Array {
  if (frame.byteLength < 3) return frame;
  const count = frame[2]!;
  if (frame.byteLength !== 3 + count * INFO_LOCATION * 2) return frame;
  const out = new Uint8Array(frame.byteLength + 3);
  out[0] = frame[0]!;
  out[1] = frame[1]!;
  writeU32(out, 2, count);
  // Core emits all source locations followed by all destination locations;
  // the dependency decoder consumes a source/destination pair per card.
  const fromStart = 3;
  const toStart = fromStart + count * INFO_LOCATION;
  for (let i = 0; i < count; i++) {
    const destination = 6 + i * INFO_LOCATION * 2;
    out.set(frame.subarray(fromStart + i * INFO_LOCATION, fromStart + (i + 1) * INFO_LOCATION), destination);
    out.set(frame.subarray(toStart + i * INFO_LOCATION, toStart + (i + 1) * INFO_LOCATION), destination + INFO_LOCATION);
  }
  return out;
}

/**
 * Core 11.0 emits SELECT_SUM as:
 *
 *   player, mode, amount, min, max, mandatory-count, mandatory[], optional-count, optional[]
 *
 * Each card has a full info-location (including the uint32 position) followed
 * by its sum parameter. The 0.1.2 decoder expects the same player/mode prefix,
 * optional first,
 * and drops the position field. Convert that one record to its expected form.
 */
function normalizeSelectSum(frame: Uint8Array): Uint8Array {
  const header = 1 + 2 + U32 * 5;
  if (frame.byteLength < header) return frame;
  const mandatoryCount = readU32(frame, 1 + 2 + U32 * 3);
  const optionalCountOffset = 1 + 2 + U32 * 4 + mandatoryCount * SUM_ENTRY;
  if (optionalCountOffset + U32 > frame.byteLength) return frame;
  const optionalCount = readU32(frame, optionalCountOffset);
  const entries = mandatoryCount + optionalCount;
  if (!Number.isSafeInteger(entries) || frame.byteLength !== header + entries * SUM_ENTRY) return frame;

  const out = new Uint8Array(header + entries * PARSED_SUM_ENTRY);
  out[0] = frame[0]!;
  out[1] = frame[1]!; // player
  out[2] = frame[2]!; // select_max/mode
  out.set(frame.subarray(3, 1 + 2 + U32 * 3), 3);

  // The dependency's parser consumes the optional list first.
  const parsedOptionalCountOffset = 1 + 2 + U32 * 3;
  writeU32(out, parsedOptionalCountOffset, optionalCount);

  let destination = parsedOptionalCountOffset + U32;
  const copyEntries = (source: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const entry = source + i * SUM_ENTRY;
      // code + controller + location + sequence
      out.set(frame.subarray(entry, entry + 10), destination);
      // Skip the four-byte position and retain the four-byte sum parameter.
      out.set(frame.subarray(entry + 14, entry + SUM_ENTRY), destination + 10);
      destination += PARSED_SUM_ENTRY;
    }
  };
  const mandatoryStart = 1 + 2 + U32 * 4;
  const optionalStart = optionalCountOffset + U32;
  copyEntries(optionalStart, optionalCount);
  writeU32(out, destination, mandatoryCount);
  destination += U32;
  copyEntries(mandatoryStart, mandatoryCount);
  return out;
}

function nativeHandle(handle: OcgDuelHandle): number {
  const symbol = Object.getOwnPropertySymbols(handle)[0];
  if (!symbol) throw new Error("ocgcore duel handle has no native handle symbol");
  const value = (handle as unknown as Record<symbol, unknown>)[symbol];
  if (typeof value !== "number") throw new Error("ocgcore duel handle is not numeric");
  return value;
}

function captureRaw(module: NativeModule, getter: NativeModule["_ocgapiDuelGetMessage"], handle: OcgDuelHandle): Uint8Array {
  const lengthPointer = module._malloc(U32);
  try {
    const pointer = getter(nativeHandle(handle), lengthPointer);
    const length = module.getValue(lengthPointer, "i32");
    if (length < 0) throw new Error("ocgcore returned a negative message length");
    return new Uint8Array(module.HEAP8.buffer, pointer, length).slice();
  } finally {
    module._free(lengthPointer);
  }
}

/**
 * Initialize the vendored synchronous core with a local compatibility shim
 * for the retained message decoder from ocgcore-wasm 0.1.2.
 */
export async function createCompatibleCore(options: Record<string, unknown> = {}): Promise<OcgCoreSync> {
  let module: NativeModule | undefined;
  const suppliedCallback = options.onRuntimeInitialized;
  const core = await createCore({
    ...options,
    sync: true,
    onRuntimeInitialized(this: NativeModule) {
      module = this;
      if (typeof suppliedCallback === "function") suppliedCallback.call(this);
    },
  } as never) as unknown as OcgCoreSync;
  // Test doubles and alternate builds may intentionally hide the Emscripten
  // module. Preserve the dependency's normal core in that case; the shim is
  // only needed when the native message buffer is available.
  if (!module) return core;

  const nativeGetter = module._ocgapiDuelGetMessage;
  const decoder = core.duelGetMessage.bind(core);
  core.duelGetMessage = (handle: OcgDuelHandle) => {
    const normalized = normalizeCoreMessageBuffer(captureRaw(module!, nativeGetter, handle));
    if (normalized.byteLength === 0) return decoder(handle);

    const pointer = module!._malloc(normalized.byteLength);
    module!.HEAP8.set(normalized, pointer);
    const originalGetter = module!._ocgapiDuelGetMessage;
    module!._ocgapiDuelGetMessage = (_handle, lengthPointer) => {
      module!.getValue(lengthPointer, "i32");
      new DataView(module!.HEAP8.buffer).setInt32(lengthPointer, normalized.byteLength, true);
      return pointer;
    };
    try {
      return decoder(handle);
    } finally {
      module!._ocgapiDuelGetMessage = originalGetter;
      module!._free(pointer);
    }
  };
  return core;
}
