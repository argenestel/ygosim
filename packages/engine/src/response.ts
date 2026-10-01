import { OcgResponseType, type OcgResponse } from "ocgcore-wasm";

/**
 * Adapt responses for the installed ocgcore-wasm serializer.
 *
 * Its SORT_CARD encoder writes `order.length` before the permutation, while
 * ygopro-core's SortCard validator expects the permutation bytes themselves.
 * The counter encoder writes little-endian int16 values and therefore gives
 * us a typed path to emit those raw bytes: two signed rank bytes per counter
 * word.  The core validates the bytes based on the pending message and does
 * not inspect the response type tag.
 */
export function adaptResponse(response: OcgResponse): OcgResponse {
  if (response.type !== OcgResponseType.SORT_CARD || response.order === null) return response;
  const order = response.order;
  if (order.some((rank) => !Number.isInteger(rank) || rank < 0 || rank > 127)) {
    throw new Error("sort order ranks must be signed int8 values");
  }
  const counters: number[] = [];
  for (let i = 0; i < order.length; i += 2) {
    counters.push(order[i]! | ((order[i + 1] ?? 0) << 8));
  }
  return { type: OcgResponseType.SELECT_COUNTER, counters };
}
