// Generates data/live.json, data/backtest/backtest-{1..10}.json and data/sim-meta.json.
// Usage: node src/main.ts   (from sim/)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventBundle } from '../../shared/types.ts';
import { BACKTEST_EVENTS, LIVE_EVENT } from './config.ts';
import type { EventConfig } from './config.ts';
import { generateBundle } from './generate.ts';
import type { WorldMeta } from './generate.ts';
import { silentSevereCells } from './stats.ts';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

/** Compact but diffable JSON: one array element per line. */
function serialize(b: EventBundle): string {
  const arr = (items: unknown[]) => '[\n' + items.map((i) => '    ' + JSON.stringify(i)).join(',\n') + '\n  ]';
  const { hexes, households, ...worldHead } = b.world;
  const head = JSON.stringify(worldHead).slice(1, -1);
  return '{\n'
    + `  "world": {${head},\n  "hexes": ${arr(hexes)},\n  "households": ${arr(households)}},\n`
    + `  "events": ${arr(b.events)},\n`
    + `  "truth": ${arr(b.truth)}\n`
    + '}\n';
}

function run(cfg: EventConfig, path: string): WorldMeta & { silentSevereHexes: string[] } {
  const { bundle, meta } = generateBundle(cfg);
  mkdirSync(dirname(path), { recursive: true });
  const text = serialize(bundle);
  JSON.parse(text); // sanity: must be valid JSON
  writeFileSync(path, text);
  const silent = silentSevereCells(bundle)
    .sort((a, b) => b.severeOrNeedsHelp - a.severeOrNeedsHelp)
    .map((s) => s.hex);
  console.log(`${cfg.eventId.padEnd(11)} -> ${path.replace(DATA_DIR, 'data')} (${(text.length / 1e6).toFixed(2)} MB, ${bundle.events.length} events, ${silent.length} silent-severe cells)`);
  return { ...meta, silentSevereHexes: silent };
}

const metas = [run(LIVE_EVENT, join(DATA_DIR, 'live.json'))];
for (const cfg of BACKTEST_EVENTS) metas.push(run(cfg, join(DATA_DIR, 'backtest', `${cfg.eventId}.json`)));
writeFileSync(
  join(DATA_DIR, 'sim-meta.json'),
  JSON.stringify({ note: 'Simulator diagnostics for demo scripting and debugging. Not part of the contract; the engine must not train on this.', worlds: metas }, null, 2) + '\n',
);
console.log('wrote data/sim-meta.json');
