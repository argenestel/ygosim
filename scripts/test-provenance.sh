#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
node --input-type=module - "${1:-artifacts/provenance.json}" <<'JS'
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
const git = path => execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const data = process.env.YGOSIM_DATA ?? 'data';
const files = directory => Object.fromEntries(readdirSync(directory).filter(n => /\.(ydk|cdb)$/.test(n)).map(n => [n, hash(join(directory, n))]));
const report = { commit: git('.'), worktreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  node: process.version, browserSeed: 42,
  playwright: JSON.parse(readFileSync('node_modules/@playwright/test/package.json', 'utf8')).version,
  chromiumBuild: basename(dirname(dirname(chromium.executablePath()))),
  chromiumInstalled: existsSync(chromium.executablePath()),
  core: JSON.parse(readFileSync('packages/engine/vendor/ocgcore/build.json', 'utf8')),
  wasm: hash('packages/engine/vendor/ocgcore/ocgcore.sync.wasm'),
  cardScripts: git(join(data, 'CardScripts')), databases: files(join(data, 'BabelCDB')),
  databaseRevision: git(join(data, 'BabelCDB')), strings: hash(join(data, 'strings.conf')),
  banlists: git(join(data, 'LFLists')), decks: files('packages/engine/decks'), lockfile: hash('pnpm-lock.yaml') };
mkdirSync(dirname(process.argv[2]), { recursive: true });
writeFileSync(process.argv[2], JSON.stringify(report, null, 2));
JS
