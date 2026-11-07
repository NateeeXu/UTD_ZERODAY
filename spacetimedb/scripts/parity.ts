// Parity check: Spacetime per-cell recompute vs. the engine's whole-world estimateAll.
// Resets the demo, jumps to t (default 1440), then compares every household_estimate and hex_stats
// row with engine/src (copied in src/fusion/engine) run offline on data/live.json + data/model.json.
//
//   node scripts/parity.ts [--t 1440] [--reports 20]
// --reports N: an adjuster files N truthful field reports (top inspectScore households) at t, and the
// offline run gets the same events, which exercises the local + neighbour update path.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventBundle, ModelParams, SimEvent } from '../../shared/types.ts';
import { DEFAULT_CONFIG } from '../src/fusion/engine/config.ts';
import { estimateAll } from '../src/fusion/engine/infer.ts';
import { connect, errText, ownerToken, STAFF_PASSCODE, subscribe } from './lib.ts';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const T = args.includes('--t') ? Number(args[args.indexOf('--t') + 1]) : 1440;
const REPORTS = args.includes('--reports') ? Number(args[args.indexOf('--reports') + 1]) : 0;

async function main() {
  const bundle = JSON.parse(readFileSync(resolve(here, '../../data/live.json'), 'utf8')) as EventBundle;
  const params = JSON.parse(readFileSync(resolve(here, '../../data/model.json'), 'utf8')) as ModelParams;
  const { conn } = await connect(ownerToken());
  await conn.reducers.resetDemo({});
  await conn.reducers.jumpTo({ minutes: T });
  await subscribe(conn, ['SELECT * FROM household_estimate', 'SELECT * FROM hex_stats', 'SELECT * FROM metrics']);
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
    await new Promise(r => setTimeout(r, 300));
  }
  const offline = estimateAll(bundle.world, [...bundle.events, ...extra], T, params, DEFAULT_CONFIG, params.sourceTrust);

  const live = new Map([...conn.db.householdEstimate.iter()].map(e => [e.householdId, e]));
  let maxSev = 0;
  let maxHelp = 0;
  let maxUnc = 0;
  let missing = 0;
  for (const e of offline.households) {
    const l = live.get(e.householdId);
    if (!l) {
      missing++;
      continue;
    }
    maxSev = Math.max(maxSev, Math.abs(l.pSevere - e.pSevere));
    maxHelp = Math.max(maxHelp, Math.abs(l.pNeedsHelp - e.pNeedsHelp));
    maxUnc = Math.max(maxUnc, Math.abs(l.uncertainty - e.uncertainty));
  }
  const stats = new Map([...conn.db.hexStats.iter()].map(s => [s.hex, s]));
  let prioMismatch = 0;
  let verMismatch = 0;
  let maxSilence = 0;
  let maxConf = 0;
  for (const h of offline.hexes) {
    const s = stats.get(h.hex);
    if (!s) continue;
    if (s.priority !== h.priority) prioMismatch++;
    if (s.verification !== h.verification) verMismatch++;
    maxSilence = Math.max(maxSilence, Math.abs(s.silence - h.silence));
    maxConf = Math.max(maxConf, Math.abs(s.confidence - h.confidence));
  }
  // Rows are rewritten only when an output moves by >= 5e-4 (WRITE_EPS in src/fusion/index.ts).
  const TOL = 1e-3;
  const ok = engineName === 'engine' && missing === 0 && maxSev < TOL && maxHelp < TOL && maxUnc < TOL && prioMismatch === 0 && verMismatch === 0;
  console.log({
    t: T,
    fieldReports: extra.length,
    estimator: engineName,
    households: offline.households.length,
    missing,
    maxAbsDiff: { pSevere: maxSev, pNeedsHelp: maxHelp, uncertainty: maxUnc, silence: maxSilence, confidence: maxConf },
    cells: offline.hexes.length,
    priorityMismatches: prioMismatch,
    verificationMismatches: verMismatch,
  });
  console.log(ok ? 'PARITY OK' : 'PARITY MISMATCH');
  conn.disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch(e => {
  console.error(errText(e));
  process.exit(1);
});
