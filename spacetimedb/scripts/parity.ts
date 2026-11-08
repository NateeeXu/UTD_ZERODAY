// Parity check: the database's per-cell recompute vs. the engine's whole-world estimateAll.
// Resets the demo, jumps to t, optionally files field reports and steps the replay clock, then
// compares every household_estimate, hex_stats and inspection_candidate row with engine/src
// (copied in src/fusion/engine) run offline on the same bundle + model + events.
//
//   node scripts/parity.ts [--db triage-loop-ca] [--file <bundle>] [--model <model.json>] [--t 1440] [--reports 20] [--step 60]
// --reports N: an adjuster files N truthful field reports (top inspectScore households) at t, and
//              the offline run gets the same events (exercises the local + neighbour update path).
// --step M:    afterwards advance the clock by M minutes with step_replay (the replay-tick code path)
//              and compare at t + M. Exact when the step triggers the full-recompute cadence.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventBundle, ModelParams, SimEvent } from '../../shared/types.ts';
import { DEFAULT_CONFIG } from '../src/fusion/engine/config.ts';
import { estimateAll } from '../src/fusion/engine/infer.ts';
import { recommendInspections } from '../src/fusion/engine/active.ts';
import { connect, DB, errText, ownerToken, STAFF_PASSCODE, subscribe } from './lib.ts';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const T = Number(arg('--t') ?? 1440);
const REPORTS = Number(arg('--reports') ?? 0);
const STEP = Number(arg('--step') ?? 0);
const bundlePath = resolve(arg('--file') ?? resolve(here, '../../data/live.json'));
const modelPath = resolve(arg('--model') ?? resolve(bundlePath, '..', 'model.json'));

async function main() {
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as EventBundle;
  const params = JSON.parse(readFileSync(modelPath, 'utf8')) as ModelParams;
  const { conn } = await connect(ownerToken());
  // The offline engine only sees the bundle + these reports, so simulated staff must be off.
  await conn.reducers.setStaffSim({ enabled: false, callsPerHour: 0, visitsPerHour: 0 });
  await conn.reducers.resetDemo({});
  await conn.reducers.jumpTo({ minutes: T });
  await subscribe(conn, [
    'SELECT * FROM household_estimate',
    'SELECT * FROM hex_stats',
    'SELECT * FROM inspection_candidate',
    'SELECT * FROM metrics',
  ]);
  const engineName = [...conn.db.metrics.iter()][0]?.engine;

  const extra: SimEvent[] = [];
  if (REPORTS > 0) {
    const adj = await connect();
    await adj.conn.reducers.joinAs({ role: 'adjuster', name: 'parity-adj', passcode: STAFF_PASSCODE });
    const truth = new Map(bundle.truth.map(r => [r.householdId, r]));
    const picks = [...conn.db.householdEstimate.iter()]
      .sort((a, b) => b.inspectScore - a.inspectScore || (a.householdId < b.householdId ? -1 : 1))
      .slice(0, REPORTS);
    for (const e of picks) {
      const tr = truth.get(e.householdId)!;
      await adj.conn.reducers.submitFieldReport({ householdId: e.householdId, safety: tr.safety, damage: tr.damage, note: 'parity' });
      extra.push({ kind: 'field_report', t: Math.floor(T), householdId: e.householdId, adjusterId: 'parity-adj', safety: tr.safety, damage: tr.damage });
    }
    await adj.conn.reducers.leave({});
    adj.conn.disconnect();
  }
  let tCompare = T;
  if (STEP > 0) {
    await conn.reducers.stepReplay({ minutes: STEP });
    tCompare = T + STEP;
  }
  await new Promise(r => setTimeout(r, 300));
  const offline = estimateAll(bundle.world, [...bundle.events, ...extra], tCompare, params, DEFAULT_CONFIG, params.sourceTrust);

  const live = new Map([...conn.db.householdEstimate.iter()].map(e => [e.householdId, e]));
  const d = { pSevere: 0, pNeedsHelp: 0, uncertainty: 0, inspectScore: 0, silence: 0, confidence: 0, hazard: 0 };
  let missing = 0;
  for (const e of offline.households) {
    const l = live.get(e.householdId);
    if (!l) {
      missing++;
      continue;
    }
    d.pSevere = Math.max(d.pSevere, Math.abs(l.pSevere - e.pSevere));
    d.pNeedsHelp = Math.max(d.pNeedsHelp, Math.abs(l.pNeedsHelp - e.pNeedsHelp));
    d.uncertainty = Math.max(d.uncertainty, Math.abs(l.uncertainty - e.uncertainty));
    d.inspectScore = Math.max(d.inspectScore, Math.abs(l.inspectScore - (e.inspectScore ?? 0)));
  }
  const stats = new Map([...conn.db.hexStats.iter()].map(s => [s.hex, s]));
  let prio = 0;
  let ver = 0;
  let reason = 0;
  let cause = 0;
  let firstReasonDiff: { hex: string; db: string; engine: string } | null = null;
  for (const h of offline.hexes) {
    const s = stats.get(h.hex);
    if (!s) continue;
    if (s.priority !== h.priority) prio++;
    if (s.verification !== h.verification) ver++;
    if (s.reason !== (h.reason ?? '')) {
      reason++;
      firstReasonDiff ??= { hex: h.hex, db: s.reason, engine: h.reason ?? '' };
    }
    if (s.silenceCause !== (h.silenceCause ?? '')) cause++;
    d.silence = Math.max(d.silence, Math.abs(s.silence - h.silence));
    d.confidence = Math.max(d.confidence, Math.abs(s.confidence - h.confidence));
    d.hazard = Math.max(d.hazard, Math.abs(s.hazard - (h.hazard ?? 0)));
  }

  // inspection_candidate vs. the engine's recommendInspections (per-cell cap, global ranking).
  const K = 50;
  const engineTop = recommendInspections(bundle.world, offline.households, offline.hexes, K, DEFAULT_CONFIG).map(c => c.householdId);
  const dbTop = [...conn.db.inspectionCandidate.iter()]
    .sort((a, b) => b.inspectScore - a.inspectScore || (a.householdId < b.householdId ? -1 : 1))
    .slice(0, K)
    .map(c => c.householdId);
  const overlap = engineTop.filter(id => dbTop.includes(id)).length;

  // Rows are rewritten only when an output moves by >= 5e-4 (WRITE_EPS in src/fusion/index.ts).
  const TOL = 1e-3;
  const ok =
    engineName === 'engine' &&
    missing === 0 &&
    Object.values(d).every(x => x < TOL) &&
    prio === 0 &&
    ver === 0 &&
    reason === 0 &&
    cause === 0;
  console.log({
    database: DB,
    t: tCompare,
    fieldReports: extra.length,
    estimator: engineName,
    households: offline.households.length,
    cells: offline.hexes.length,
    missing,
    maxAbsDiff: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Number(v.toExponential(1))])),
    mismatches: { priority: prio, verification: ver, reason, silenceCause: cause },
    inspectTop50Overlap: `${overlap}/${engineTop.length}`,
  });
  if (firstReasonDiff) console.log('first reason difference:', firstReasonDiff);
  console.log(ok ? 'PARITY OK' : 'PARITY MISMATCH');
  await conn.reducers.setStaffSim({ enabled: true, callsPerHour: 0, visitsPerHour: 0 });
  await conn.reducers.resetDemo({});
  conn.disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch(e => {
  console.error(errText(e));
  process.exit(1);
});
