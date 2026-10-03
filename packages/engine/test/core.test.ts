import { describe, expect, it } from "vitest";
import { normalizeCoreMessageBuffer, preserveCoreMessageMetadata } from "../src/core.js";
import { OcgMessageType as M, OcgLocation as L, type OcgMessage } from "ocgcore-wasm";

function frame(payload: number[]): number[] {
  return [payload.length & 0xff, (payload.length >>> 8) & 0xff, (payload.length >>> 16) & 0xff, (payload.length >>> 24) & 0xff, ...payload];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function info(code: number, controller: number, location: number, sequence: number, position: number, amount: number): number[] {
  return [...u32(code), controller, location, ...u32(sequence), ...u32(position), ...u32(amount)];
}

function location(controller: number, zone: number, sequence: number, position: number): number[] {
  return [controller, zone, ...u32(sequence), ...u32(position)];
}

describe("ocgcore message compatibility", () => {
  it("preserves MOVE reason without altering the wire or decoded locations", () => {
    const message: OcgMessage = { type: M.MOVE, card: 123,
      from: { controller: 0, location: L.HAND, sequence: 2, position: 1 },
      to: { controller: 0, location: L.MZONE, sequence: 3, position: 1 } };
    const raw = new Uint8Array(frame([M.MOVE, ...u32(123), ...location(0, L.HAND, 2, 1), ...location(0, L.MZONE, 3, 1), ...u32(0x100800)]));
    const before = raw.slice();
    expect(preserveCoreMessageMetadata(raw, [message])).toEqual([{ ...message, reason: 0x100800 }]);
    expect(raw).toEqual(before);
    expect(message).not.toHaveProperty("reason");
    expect(preserveCoreMessageMetadata(raw.subarray(0, raw.length - 1), [message])).toEqual([message]);
    expect(preserveCoreMessageMetadata(raw, [{ type: M.SPSUMMONED }])).toEqual([{ type: M.SPSUMMONED }]);
  });
  it("widens the SHUFFLE_SET_CARD count without changing card locations", () => {
    const from = [location(0, 8, 1, 8), location(1, 8, 4, 2)];
    const to = [location(0, 0, 0, 0), location(0, 0, 0, 0)];
    const payload = [36, 8, 2, ...from.flat(), ...to.flat()];
    const normalized = normalizeCoreMessageBuffer(new Uint8Array(frame(payload)));
    expect([...normalized.slice(0, 8)]).toEqual([46, 0, 0, 0, 36, 8, 2, 0]);
    expect([...normalized.slice(10)]).toEqual([...from[0]!, ...to[0]!, ...from[1]!, ...to[1]!]);
  });

  it("reorders SELECT_SUM lists and removes only the position field", () => {
    const payload = [
      23, 1, 0, ...u32(500), ...u32(0), ...u32(0), ...u32(1),
      ...info(100, 0, 4, 2, 8, 4),
      ...u32(1),
      ...info(200, 1, 16, 3, 1, 8),
    ];
    const normalized = normalizeCoreMessageBuffer(new Uint8Array(frame(payload)));
    const expectedPayload = [
      23, 1, 0, ...u32(500), ...u32(0), ...u32(0), ...u32(1),
      ...u32(200), 1, 16, ...u32(3), ...u32(8),
      ...u32(1),
      ...u32(100), 0, 4, ...u32(2), ...u32(4),
    ];
    expect([...normalized]).toEqual(frame(expectedPayload));
  });

  it("passes through unrelated and unsupported framed messages", () => {
    const raw = new Uint8Array([...frame([1]), ...frame([190, 1, 2, 3])]);
    expect(normalizeCoreMessageBuffer(raw)).toEqual(raw);
  });
});
