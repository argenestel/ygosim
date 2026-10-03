#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
pnpm test:reference
pnpm test:stress
pnpm test:audit
pnpm test:fuzz --duels 20 --seed 20261002 --decision-cap 4000
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
const read = name => JSON.parse(readFileSync(`packages/engine/data/reports/${name}.json`, 'utf8'));
const audit = read('script-audit');
if (audit.missingScripts.length || audit.loadErrors.length) throw new Error('Script audit has missing scripts or initialization errors; inspect the archived report');
const fuzz = read('fuzz');
if (fuzz.totalDuelsRun !== 20 || fuzz.completedDuels !== 20) throw new Error('Fuzz run has errors or inconclusive outcomes; inspect the archived report');
JS
