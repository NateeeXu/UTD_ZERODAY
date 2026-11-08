// Real-geography simulator entry point.
// Usage (from sim/):
//   node real/main.ts tx [--households 20000] [--backtest-households 15000]
//   node real/main.ts ca [--households 30000] [--backtest-households 15000]
// Writes data/real/<region>/{live,backtest-1..N}.json (Texas: 8 backtests, Bay Area: 5) and sim-meta.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventBundle } from '../../shared/types.ts';
import { REGIONS } from './regions.ts';
import type { RegionDef } from './regions.ts';
import { loadRegion } from './load.ts';
import type { RegionData } from './load.ts';
import { buildBaseWorld } from './world.ts';
import { CA_SCENARIOS, TX_SCENARIOS } from './scenarios.ts';
import type { Scenario } from './scenarios.ts';
import { simulate } from './simulate.ts';
import { dataSources, serialize } from './bundle-io.ts';
import { ACS_YEAR, LODES_YEAR, OUT_DIR } from './sources.ts';

const DEFAULTS: Record<RegionDef['id'], { live: number; backtest: number }> = {
  'tx-corpus-christi': { live: 20000, backtest: 15000 },
  'ca-bay-area': { live: 30000, backtest: 15000 },
};

function parseArgs(argv: string[]): { region: RegionDef['id']; live?: number; backtest?: number; only?: string } {
  const alias: Record<string, RegionDef['id']> = { tx: 'tx-corpus-christi', ca: 'ca-bay-area', 'tx-corpus-christi': 'tx-corpus-christi', 'ca-bay-area': 'ca-bay-area' };
  const region = alias[argv[0] ?? ''];
  if (!region) throw new Error('usage: node real/main.ts <tx|ca> [--households N] [--backtest-households N] [--only live|backtest-1|...]');
  const get = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  return { region, live: num(get('--households')), backtest: num(get('--backtest-households')), only: get('--only') };
}

const args = parseArgs(process.argv.slice(2));
const region = REGIONS[args.region];
const t0 = Date.now();
const data = loadRegion(region);
const base = buildBaseWorld(data);
console.log(`[${region.id}] ${base.cells.length} cells, ${base.facilities.length} facilities, ${base.masts.length} masts (${Date.now() - t0} ms)`);
for (const f of data.fallbacks) console.log(`  FALLBACK: ${f}`);
const outDir = join(OUT_DIR, region.id);
mkdirSync(outDir, { recursive: true });
const scenarios: Scenario[] = region.hazardType === 'hurricane' ? TX_SCENARIOS : CA_SCENARIOS;
const sources = dataSources(data);
const metas: ReturnType<typeof simulate>['meta'][] = [];
for (const sc of scenarios) {
  if (args.only && args.only !== sc.eventId) continue;
  const t1 = Date.now();
  const isLive = sc.eventId === 'live';
  const n = isLive ? (args.live ?? DEFAULTS[region.id].live) : (args.backtest ?? DEFAULTS[region.id].backtest);
  const { bundle, meta } = simulate(base, data, sc, { regionPrefix: region.id.slice(0, 2), households: n, fieldReports: !isLive, dataSources: sources });
  const text = serialize(bundle);
  JSON.parse(text);
  const path = join(outDir, `${sc.eventId}.json`);
  writeFileSync(path, text);
  metas.push(meta);
  console.log(`  ${sc.eventId.padEnd(11)} ${n} households, ${bundle.events.length} events, ${(text.length / 1e6).toFixed(2)} MB (${Date.now() - t1} ms)`);
}
// With --only, merge the regenerated world(s) into the existing sim-meta.json instead of replacing it.
const metaPath = join(outDir, 'sim-meta.json');
let worlds: unknown[] = metas;
if (args.only && existsSync(metaPath)) {
  const prev = JSON.parse(readFileSync(metaPath, 'utf8')) as { worlds: Array<{ eventId: string }> };
  const order = scenarios.map((s) => s.eventId);
  worlds = [...prev.worlds.filter((w) => !metas.some((m) => m.eventId === w.eventId)), ...metas]
    .sort((a, b) => order.indexOf((a as { eventId: string }).eventId) - order.indexOf((b as { eventId: string }).eventId));
}
writeFileSync(metaPath, JSON.stringify({
  note: 'Simulator diagnostics for demo scripting. Not part of the contract; the engine must not train on this.',
  region: region.id, studyArea: base.notes, fallbacks: data.fallbacks, worlds,
}, null, 2) + '\n');
console.log(`[${region.id}] done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
