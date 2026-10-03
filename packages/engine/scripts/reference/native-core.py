#!/usr/bin/env python3
"""JSON-lines bridge to unmodified upstream native libocgcore (test-only)."""
import ctypes as C
import json
import pathlib
import sys

lib = C.CDLL(sys.argv[1])
scripts = pathlib.Path(sys.argv[2])
records = json.loads(pathlib.Path(sys.argv[3]).read_text())

class Card(C.Structure):
    _fields_ = [('code', C.c_uint32), ('alias', C.c_uint32), ('setcodes', C.POINTER(C.c_uint16)),
                ('type', C.c_uint32), ('level', C.c_uint32), ('attribute', C.c_uint32), ('race', C.c_uint64),
                ('attack', C.c_int32), ('defense', C.c_int32), ('lscale', C.c_uint32), ('rscale', C.c_uint32), ('link_marker', C.c_uint32)]
class Player(C.Structure):
    _fields_ = [('startingLP', C.c_uint32), ('startingDrawCount', C.c_uint32), ('drawCountPerTurn', C.c_uint32)]
Reader = C.CFUNCTYPE(None, C.c_void_p, C.c_uint32, C.POINTER(Card))
Script = C.CFUNCTYPE(C.c_int, C.c_void_p, C.c_void_p, C.c_char_p)
Log = C.CFUNCTYPE(None, C.c_void_p, C.c_char_p, C.c_int)
Done = C.CFUNCTYPE(None, C.c_void_p, C.POINTER(Card))
class Options(C.Structure):
    _fields_ = [('seed', C.c_uint64 * 4), ('flags', C.c_uint64), ('team1', Player), ('team2', Player),
                ('cardReader', Reader), ('payload1', C.c_void_p), ('scriptReader', Script), ('payload2', C.c_void_p),
                ('logHandler', Log), ('payload3', C.c_void_p), ('cardReaderDone', Done), ('payload4', C.c_void_p),
                ('enableUnsafeLibraries', C.c_uint8)]
class NewCard(C.Structure):
    _fields_ = [('team', C.c_uint8), ('duelist', C.c_uint8), ('code', C.c_uint32), ('con', C.c_uint8),
                ('loc', C.c_uint32), ('seq', C.c_uint32), ('pos', C.c_uint32)]
class Query(C.Structure):
    _fields_ = [('flags', C.c_uint32), ('con', C.c_uint8), ('loc', C.c_uint32), ('seq', C.c_uint32), ('overlay_seq', C.c_uint32)]

signatures = {
 'OCG_CreateDuel': ([C.POINTER(C.c_void_p), C.POINTER(Options)], C.c_int),
 'OCG_DestroyDuel': ([C.c_void_p], None), 'OCG_DuelNewCard': ([C.c_void_p, C.POINTER(NewCard)], None),
 'OCG_StartDuel': ([C.c_void_p], None), 'OCG_DuelProcess': ([C.c_void_p], C.c_int),
 'OCG_DuelGetMessage': ([C.c_void_p, C.POINTER(C.c_uint32)], C.c_void_p),
 'OCG_DuelSetResponse': ([C.c_void_p, C.c_void_p, C.c_uint32], None),
 'OCG_LoadScript': ([C.c_void_p, C.c_char_p, C.c_uint32, C.c_char_p], C.c_int),
 'OCG_DuelQueryLocation': ([C.c_void_p, C.POINTER(C.c_uint32), C.POINTER(Query)], C.c_void_p),
 'OCG_DuelQuery': ([C.c_void_p, C.POINTER(C.c_uint32), C.POINTER(Query)], C.c_void_p),
}
for name, (args, result) in signatures.items():
    f = getattr(lib, name); f.argtypes = args; f.restype = result

cards = {}
arrays = []
for r in records:
    sc = (C.c_uint16 * (len(r['setcodes']) + 1))(*r['setcodes'], 0)
    arrays.append(sc)
    cards[r['code']] = Card(r['code'], r['alias'], sc, r['type'], r['level'], r['attribute'], int(r['race']),
                            r['attack'], r['defense'], r['lscale'], r['rscale'], r['link_marker'])
errors = []
script_cache = {}
@Reader
def card_reader(_payload, code, out):
    value = cards.get(code, Card())
    C.memmove(out, C.byref(value), C.sizeof(Card))
@Done
def card_done(_payload, _card):
    pass
@Log
def log(_payload, message, kind):
    if kind == 0: errors.append(message.decode(errors='replace'))
@Script
def script_reader(_payload, duel, raw_name):
    name = raw_name.decode().replace('\\', '/').split('/')[-1]
    if name not in script_cache:
        paths = [scripts / d / name for d in ['official', 'pre-release', 'pre-errata', 'unofficial', 'goat', 'skill', 'rush']] if name.startswith('c') and name[1:-4].isdigit() else [scripts / name]
        script_cache[name] = next((p.read_bytes() for p in paths if p.is_file()), None)
    content = script_cache[name]
    return lib.OCG_LoadScript(duel, content, len(content), raw_name) if content is not None else 0

handle = C.c_void_p()
def dispatch(m):
    global handle
    op = m['op']
    if op == 'init':
        opts = Options((C.c_uint64 * 4)(*[int(s) for s in m['seed']]), int(m['flags']), Player(**m['team1']), Player(**m['team2']),
                       card_reader, None, script_reader, None, log, None, card_done, None, 0)
        status = lib.OCG_CreateDuel(C.byref(handle), C.byref(opts))
        if status != 0: raise RuntimeError('OCG_CreateDuel failed: ' + str(status))
        for name in ['constant.lua', 'utility.lua']:
            if not script_reader(None, handle, name.encode()): raise RuntimeError('script load failed: ' + name)
        return {}
    if op == 'card':
        c = m['card']; info = NewCard(c['team'], c['duelist'], c['code'], c['controller'], c['location'], c['sequence'], c['position'])
        lib.OCG_DuelNewCard(handle, C.byref(info)); return {}
    if op == 'start': lib.OCG_StartDuel(handle); return {}
    if op == 'step':
        status = lib.OCG_DuelProcess(handle); length = C.c_uint32()
        ptr = lib.OCG_DuelGetMessage(handle, C.byref(length))
        return {'status': status, 'hex': C.string_at(ptr, length.value).hex()}
    if op == 'response':
        data = bytes.fromhex(m['hex']); buf = C.create_string_buffer(data)
        lib.OCG_DuelSetResponse(handle, buf, len(data)); return {}
    if op in ['query', 'query_location']:
        q = m['query']; info = Query(q['flags'], q['controller'], q['location'], q.get('sequence', 0), q.get('overlaySequence', 0))
        length = C.c_uint32(); f = lib.OCG_DuelQuery if op == 'query' else lib.OCG_DuelQueryLocation
        ptr = f(handle, C.byref(length), C.byref(info))
        return {'hex': C.string_at(ptr, length.value).hex()}
    if op == 'destroy': lib.OCG_DestroyDuel(handle); handle = C.c_void_p(); return {}
    raise RuntimeError('unknown op ' + op)

for line in sys.stdin:
    try:
        result = dispatch(json.loads(line))
        if errors: raise RuntimeError('; '.join(errors))
        print(json.dumps({'ok': True, **result}), flush=True)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}), flush=True)
        errors.clear()
