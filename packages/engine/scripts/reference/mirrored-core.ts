import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OcgCoreSync, OcgDuelHandle } from 'ocgcore-wasm';
import { loadCardDb, toOcgCard } from '../../src/carddb.js';
import { dataDir } from '../../src/data.js';

interface NativeModule {
  HEAP8: Int8Array;
  getValue(pointer: number, type: 'i32'): number;
  _ocgapiDuelGetMessage(handle: number, length: number): number;
  _ocgapiDuelSetResponse(handle: number, pointer: number, length: number): void;
  _ocgapiDuelQueryLocation(handle: number, length: number, query: number): number;
  _ocgapiDuelQuery(handle: number, length: number, query: number): number;
}
interface Pipe { _handle: { fd: number; setBlocking(on: boolean): void } }
interface Reply { ok: boolean; error?: string; status?: number; hex?: string }
export const referenceStats = { duels: 0, steps: 0, messageBytes: 0, queries: 0, responses: 0, mismatches: [] as string[] };
const json = (v: unknown) => JSON.stringify(v, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);

class NativeReference {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  constructor(library: string, database: string) {
    this.child = spawn('python3', [fileURLToPath(new URL('./native-core.py', import.meta.url)), library, resolve(dataDir(), 'CardScripts'), database]);
    (this.child.stdin as unknown as Pipe)._handle.setBlocking(true);
    (this.child.stdout as unknown as Pipe)._handle.setBlocking(true);
    this.child.stderr.on('data', bytes => process.stderr.write(bytes));
  }
  call(value: unknown): Reply {
    const line = Buffer.from(json(value) + '\n');
    let written = 0;
    while (written < line.length) written += writeSync((this.child.stdin as unknown as Pipe)._handle.fd, line, written, line.length - written);
    while (!this.buffer.includes('\n')) {
      const chunk = Buffer.alloc(65536);
      const n = readSync((this.child.stdout as unknown as Pipe)._handle.fd, chunk, 0, chunk.length, null);
      if (!n) throw new Error('native reference exited without a response');
      this.buffer += chunk.subarray(0, n).toString();
    }
    const end = this.buffer.indexOf('\n'), reply = JSON.parse(this.buffer.slice(0, end)) as Reply;
    this.buffer = this.buffer.slice(end + 1);
    if (!reply.ok) throw new Error('native reference: ' + reply.error);
    return reply;
  }
  close() { this.child.stdin.end(); this.child.kill(); }
}

/** Test-only lockstep: separate upstream native binary versus the application's WASM bridge. */
export async function createMirroredCore(
  factory: (options?: Record<string, unknown>) => Promise<OcgCoreSync>, options: Record<string, unknown> = {},
): Promise<OcgCoreSync> {
  const library = process.env.YGOSIM_NATIVE_REFERENCE;
  if (!library) throw new Error('Set YGOSIM_NATIVE_REFERENCE to a native upstream libocgcore.so');
  const reportDir = resolve('/tmp/ygosim-reference'); mkdirSync(reportDir, { recursive: true });
  const database = resolve(reportDir, 'cards.json');
  const db = await loadCardDb();
  writeFileSync(database, json([...db.raw.values()].map(toOcgCard)));
  const references = new Map<number, NativeReference>(), steps = new Map<number, Reply>();
  let module: NativeModule;
  const nativeId = (h: OcgDuelHandle) => (h as unknown as Record<symbol, number>)[Object.getOwnPropertySymbols(h)[0]];
  const match = (kind: string, actual: string, expected: string) => {
    if (actual === expected) return;
    const detail = `${kind}: WASM=${actual.slice(0, 300)} native=${expected.slice(0, 300)}`;
    referenceStats.mismatches.push(detail); throw new Error('native differential mismatch: ' + detail);
  };
  const bytes = (ptr: number, length: number) => Buffer.from(module.HEAP8.buffer, ptr, length).toString('hex');
  const previousCallback = options.onRuntimeInitialized;
  const core = await factory({ ...options, onRuntimeInitialized(this: NativeModule) {
    module = this;
    if (typeof previousCallback === 'function') previousCallback.call(this);
    const get = module._ocgapiDuelGetMessage.bind(module);
    module._ocgapiDuelGetMessage = (id, length) => {
      const ptr = get(id, length), n = module.getValue(length, 'i32');
      match('messages', bytes(ptr, n), steps.get(id)?.hex ?? '');
      referenceStats.messageBytes += n;
      return ptr;
    };
    const respond = module._ocgapiDuelSetResponse.bind(module);
    module._ocgapiDuelSetResponse = (id, ptr, length) => {
      references.get(id)!.call({ op: 'response', hex: bytes(ptr, length) });
      referenceStats.responses++; respond(id, ptr, length);
    };
    for (const [name, operation] of [['_ocgapiDuelQueryLocation', 'query_location'], ['_ocgapiDuelQuery', 'query']] as const) {
      const query = module[name].bind(module);
      module[name] = (id, length, info) => {
        const view = new DataView(module.HEAP8.buffer), q = { flags: view.getUint32(info, true), controller: view.getUint8(info + 4),
          location: view.getUint32(info + 8, true), sequence: view.getUint32(info + 12, true), overlaySequence: view.getUint32(info + 16, true) };
        const expected = references.get(id)!.call({ op: operation, query: q });
        const ptr = query(id, length, info);
        match(operation + ' ' + json(q), bytes(ptr, module.getValue(length, 'i32')), expected.hex!);
        referenceStats.queries++; return ptr;
      };
    }
  } });
  const create = core.createDuel.bind(core);
  core.createDuel = opts => {
    const h = create(opts); if (!h) return h;
    const ref = new NativeReference(library, database);
    try { ref.call({ op: 'init', seed: opts.seed, flags: opts.flags, team1: opts.team1, team2: opts.team2 }); }
    catch (e) { ref.close(); core.destroyDuel(h); throw e; }
    references.set(nativeId(h), ref); referenceStats.duels++; return h;
  };
  const add = core.duelNewCard.bind(core);
  core.duelNewCard = (h, card) => { references.get(nativeId(h))!.call({ op: 'card', card }); add(h, card); };
  const start = core.startDuel.bind(core);
  core.startDuel = h => { references.get(nativeId(h))!.call({ op: 'start' }); start(h); };
  const runProcess = core.duelProcess.bind(core);
  core.duelProcess = h => {
    const expected = references.get(nativeId(h))!.call({ op: 'step' }); steps.set(nativeId(h), expected);
    const actual = runProcess(h); referenceStats.steps++;
    match('process status', String(actual), String(expected.status)); return actual;
  };
  const destroy = core.destroyDuel.bind(core);
  core.destroyDuel = h => {
    const id = nativeId(h), ref = references.get(id);
    try { ref?.call({ op: 'destroy' }); }
    finally { ref?.close(); references.delete(id); steps.delete(id); destroy(h); }
  };
  return core;
}
