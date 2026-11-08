// Timings on a large world.
//   node scripts/bench.ts [--bundle data/real/ca-bay-area/live.json] [--model data/real/ca-bay-area/model.json] [--t 1440]
// Reports: snapshot build, whole-world estimateAll (median of 3), and single-cell recompute via
// localUpdate (apply one field report + re-estimate its cell + inspect scores), 30 samples.

import { join, resolve } from 'node:path';
import type { SimEvent } from '../../shared/types.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { buildSnapshot } from '../src/features.ts';
import { estimateAll, estimateCellHouseholds, classifyCell, cellContext } from '../src/infer.ts';
import { applyFieldReportToSnapshot, localUpdate, reestimateCell } from '../src/learning.ts';
import type { FieldReportEvent } from '../src/learning.ts';
import { recommendInspections } from '../src/active.ts';
import { DEFAULT_DATA_DIR, loadBundle, loadModel, parseArgs, truthMap } from './io.ts';

const cfg = DEFAULT_CONFIG;
const args = parseArgs(process.argv.slice(2));
const bundlePath = resolve(args.flags.get('bundle') ?? join(DEFAULT_DATA_DIR, 'real', 'ca-bay-area', 'live.json'));
const modelPath = resolve(args.flags.get('model') ?? join(bundlePath, '..', 'model.json'));
const t = Number(args.flags.get('t') ?? 1440);

const bundle = loadBundle(bundlePath);
const params = loadModel(modelPath);
const { world } = bundle;
const truth = truthMap(bundle.truth);
console.log(`${bundlePath}: ${world.hexes.length} cells, ${world.households.length} households, ${bundle.events.length} events; model ${params.features.length} features`);

const now = (): number => performance.now();
const stats = (xs: number[]): string => {
  const s = xs.slice().sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return `mean ${mean.toFixed(2)} ms, median ${s[Math.floor(s.length / 2)].toFixed(2)} ms, max ${s[s.length - 1].toFixed(2)} ms (n=${s.length})`;
};

// warm-up
estimateAll(world, bundle.events, t, params, cfg);

const snapTimes: number[] = [];
for (let i = 0; i < 3; i++) {
  const a = now();
  buildSnapshot(world, bundle.events, t, cfg);
  snapTimes.push(now() - a);
}
console.log(`buildSnapshot: ${stats(snapTimes)}`);

const allTimes: number[] = [];
let est = estimateAll(world, bundle.events, t, params, cfg);
for (let i = 0; i < 3; i++) {
  const a = now();
  est = estimateAll(world, bundle.events, t, params, cfg);
  allTimes.push(now() - a);
}
console.log(`estimateAll (whole world): ${stats(allTimes)}`);

// single-cell recompute, 30 different cells chosen by active inspection (one per cell)
const picks = recommendInspections(world, est.households, est.hexes, 30, cfg, { perCellCap: 1 });
let snapshot = est.snapshot;
let households = est.households;
let hexes = est.hexes;
const events: SimEvent[] = bundle.events.slice();
const applyTimes: number[] = [];
const reestTimes: number[] = [];
const localTimes: number[] = [];
const cellOnlyTimes: number[] = [];
let largestCell = 0;
for (const p of picks) {
  const tr = truth.get(p.householdId)!;
  const report: FieldReportEvent = { kind: 'field_report', t, householdId: p.householdId, adjusterId: 'bench', safety: tr.safety, damage: tr.damage };
  events.push(report);
  const a0 = now();
  const s2 = applyFieldReportToSnapshot(snapshot, report);
  const a1 = now();
  const re = reestimateCell(s2, p.hex, est.models, cfg, households, hexes);
  const a2 = now();
  applyTimes.push(a1 - a0);
  reestTimes.push(a2 - a1);
  // the same through the convenience wrapper
  const b0 = now();
  const lu = localUpdate(snapshot, report, est.models, cfg, households, hexes);
  localTimes.push(now() - b0);
  // pure per-cell estimation cost (what a Spacetime reducer does per cell)
  const members = s2.householdsByHex.get(p.hex)!;
  largestCell = Math.max(largestCell, members.length);
  const c0 = now();
  const ests = estimateCellHouseholds(members, s2, est.models, cfg);
  classifyCell(s2.cells.get(p.hex)!, ests, cfg, cellContext(s2, p.hex));
  cellOnlyTimes.push(now() - c0);
  snapshot = lu.snapshot;
  households = re.households;
  hexes = re.hexes;
}
console.log(`single-cell recompute, apply report to snapshot: ${stats(applyTimes)}`);
console.log(`single-cell recompute, re-estimate cell + inspect scores: ${stats(reestTimes)}`);
console.log(`single-cell recompute, localUpdate total: ${stats(localTimes)}`);
console.log(`per-cell estimate+classify only (largest sampled cell ${largestCell} households): ${stats(cellOnlyTimes)}`);
const biggest = world.hexes.map((c) => est.snapshot.householdsByHex.get(c.hex)!.length).sort((a, b) => b - a)[0];
console.log(`largest cell in the world: ${biggest} households`);
