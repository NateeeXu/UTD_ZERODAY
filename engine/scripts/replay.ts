// Live replay.
//   node scripts/replay.ts [dataDir] [--model=<model.json>] [--times=120,360,720,1440]
//                          [--at=1440] [--reports=30] [--batch=10]
// 1. At each snapshot time: P0/P1/P2 and needs_verification counts, top 5 P0
//    cells, top 5 silent cells, holdout metrics, verified coverage.
// 2. At --at: simulate --reports field reports chosen by active inspection in
//    batches of --batch (report = truth for that household), apply the local
//    update and the trust loop, and show what changed. Truth is used ONLY to
//    create the simulated reports and to score holdout households.

import { join } from 'node:path';
import type { HexCell, HexEstimate, HouseholdEstimate, SimEvent, TruthRow } from '../../shared/types.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { estimateAll, resolveModels } from '../src/infer.ts';
import type { Estimates, SourceTrust } from '../src/infer.ts';
import { initLearningState, localUpdate, recordFieldReport } from '../src/learning.ts';
import type { FieldReportEvent, LearningState } from '../src/learning.ts';
import { recommendInspections } from '../src/active.ts';
import { brier, ece, verifiedCoverage } from '../src/metrics.ts';
import { fmt, heading, loadBundle, loadModel, minutesLabel, parseArgs, pct, resolveDataDir, table, truthMap } from './io.ts';

const cfg = DEFAULT_CONFIG;
const args = parseArgs(process.argv.slice(2));
const dataDir = resolveDataDir(args);
const modelPath = args.flags.get('model') ?? join(dataDir, 'model.json');
const times = (args.flags.get('times') ?? '120,360,720,1440').split(',').map(Number);
const atT = Number(args.flags.get('at') ?? 1440);
const nReports = Number(args.flags.get('reports') ?? 30);
const batch = Number(args.flags.get('batch') ?? 10);

const bundle = loadBundle(join(dataDir, 'live.json'));
const params = loadModel(modelPath);
const { world } = bundle;
const truth = truthMap(bundle.truth);
const cellById = new Map<string, HexCell>(world.hexes.map((c) => [c.hex, c]));
const householdHex = new Map(world.households.map((h) => [h.id, h.hex]));
const holdoutIds = new Set(world.households.filter((h) => h.holdout).map((h) => h.id));

console.log(`data: ${dataDir}   model: ${modelPath}`);
console.log(`world ${world.eventId} "${world.name}": ${world.hexes.length} cells, ${world.households.length} households, ${holdoutIds.size} holdout, ${bundle.events.length} events`);
console.log(`thresholds: ${JSON.stringify(cfg.thresholds)}`);

// ---------- helpers ----------
function tierCounts(hexes: readonly HexEstimate[]): { P0: number; P1: number; P2: number; needsVerification: number; p0NeedsVerification: number } {
  const c = { P0: 0, P1: 0, P2: 0, needsVerification: 0, p0NeedsVerification: 0 };
  for (const x of hexes) {
    c[x.priority]++;
    if (x.verification === 'needs_verification') {
      c.needsVerification++;
      if (x.priority === 'P0') c.p0NeedsVerification++;
    }
  }
  return c;
}

/** Truth-based severe share of a cell (evaluation display only). */
function truthSevereShare(hex: string): number {
  let n = 0;
  let s = 0;
  for (const h of world.households) {
    if (h.hex !== hex) continue;
    n++;
    const tr = truth.get(h.id)!;
    if (tr.damage >= 2) s++;
  }
  return n > 0 ? s / n : NaN;
}

function cellRow(x: HexEstimate): (string | number)[] {
  const c = cellById.get(x.hex)!;
  return [
    x.hex,
    x.priority,
    x.verification === 'verified' ? 'verified' : 'needs_ver',
    String(x.households),
    String(c.windMph),
    fmt(c.floodDepthFt, 1),
    String(c.towerOutagePct),
    String(c.analystZone),
    `${x.counts.smsReplies}/${x.counts.smsSent}`,
    String(x.counts.claims),
    String(x.counts.fieldReports),
    x.severity,
    x.confidence,
    x.silence,
    fmt(x.expectedSevere, 1),
    x.maxPNeedsHelp,
    pct(truthSevereShare(x.hex)),
  ];
}
const CELL_HEADERS = ['hex', 'tier', 'verif', 'hh', 'wind', 'flood', 'out%', 'zone', 'reply/sent', 'claims', 'field', 'severity', 'conf', 'silence', 'E[sev]', 'maxHelp', 'truth sev% (eval)'];

interface HoldoutMetrics {
  n: number;
  brierSevere: number;
  eceSevere: number;
  brierHelp: number;
}

/** Metrics on holdout households vs truth. `ids` fixes the evaluation set (default: all holdout). */
function holdoutMetrics(households: readonly HouseholdEstimate[], ids: ReadonlySet<string> = holdoutIds): HoldoutMetrics {
  const pS: number[] = [];
  const yS: number[] = [];
  const pH: number[] = [];
  const yH: number[] = [];
  for (const e of households) {
    if (!ids.has(e.householdId)) continue;
    const tr = truth.get(e.householdId)!;
    pS.push(e.pSevere);
    yS.push(tr.damage >= 2 ? 1 : 0);
    pH.push(e.pNeedsHelp);
    yH.push(tr.safety === 'needs_help' ? 1 : 0);
  }
  return { n: pS.length, brierSevere: brier(pS, yS), eceSevere: ece(pS, yS), brierHelp: brier(pH, yH) };
}

function top<T>(items: readonly T[], key: (x: T) => number, k: number): T[] {
  return items
    .slice()
    .sort((a, b) => key(b) - key(a))
    .slice(0, k);
}

function printSnapshot(est: Estimates): void {
  const c = tierCounts(est.hexes);
  console.log(heading(`t = ${minutesLabel(est.t)}`));
  console.log(
    `tiers: P0 ${c.P0}  P1 ${c.P1}  P2 ${c.P2}   needs_verification ${c.needsVerification} (of which P0 ${c.p0NeedsVerification})   refs: replyRate(low-outage) ${fmt(est.snapshot.refs.refReplyRate)}, claims/hazard ${fmt(est.snapshot.refs.claimRatePerHazard)}`,
  );
  const p0 = est.hexes.filter((x) => x.priority === 'P0');
  console.log(`\ntop 5 P0 cells by severity (${p0.length} P0 cells):`);
  console.log(table(CELL_HEADERS, top(p0, (x) => x.severity * 1000 + x.expectedSevere, 5).map(cellRow)));
  console.log('\ntop 5 silent cells:');
  console.log(table(CELL_HEADERS, top(est.hexes, (x) => x.silence, 5).map(cellRow)));
  const hm = holdoutMetrics(est.households);
  const vc = verifiedCoverage(est.hexes, est.households, householdHex);
  console.log(
    `\nholdout (n=${hm.n}): Brier severe ${fmt(hm.brierSevere)} (ECE ${fmt(hm.eceSevere)}), Brier needsHelp ${fmt(hm.brierHelp)}   verified coverage: P0 cells ${vc.p0CellsWithReport}/${vc.p0Cells} (${pct(vc.cellShare)}), suspected households ${vc.suspectedVerified}/${vc.suspectedHouseholds} (${pct(vc.householdShare)})`,
  );
}

// ---------- 1. snapshots ----------
for (const t of times) printSnapshot(estimateAll(world, bundle.events, t, params, cfg));

// ---------- 2. simulated field reports + learning loop ----------
console.log(heading(`simulating ${nReports} field reports at t = ${minutesLabel(atT)} (batches of ${batch}, chosen by active inspection; report = truth)`));
const before = estimateAll(world, bundle.events, atT, params, cfg);
const baselineTrust: SourceTrust = { ...params.sourceTrust };
let learning: LearningState = initLearningState(params);
let snapshot = before.snapshot;
let households = before.households;
let hexes = before.hexes;
const models = before.models; // baseline trust -> multipliers 1 (local path keeps the calibrated model)
const events: SimEvent[] = bundle.events.slice();
const reported = new Set<string>();
const log: (string | number)[][] = [];

let made = 0;
while (made < nReports) {
  const want = Math.min(batch, nReports - made);
  const picks = recommendInspections(world, households, hexes, want, cfg, { exclude: reported });
  if (picks.length === 0) break;
  for (const p of picks) {
    const tr: TruthRow = truth.get(p.householdId)!;
    const report: FieldReportEvent = { kind: 'field_report', t: atT, householdId: p.householdId, adjusterId: 'adj-sim', safety: tr.safety, damage: tr.damage };
    events.push(report);
    reported.add(p.householdId);
    const prevHex = hexes.find((x) => x.hex === p.hex)!;
    const lu = localUpdate(snapshot, report, models, cfg, households, hexes);
    snapshot = lu.snapshot;
    households = lu.households;
    hexes = lu.hexes;
    learning = recordFieldReport(learning, lu.observation, cfg);
    const newHex = hexes.find((x) => x.hex === p.hex)!;
    log.push([
      String(++made),
      p.householdId,
      p.hex,
      holdoutIds.has(p.householdId) ? 'holdout' : '',
      p.score,
      p.pSevere,
      p.uncertainty,
      p.cellSilence,
      `${tr.damage}/${tr.safety}`,
      `${prevHex.priority}/${prevHex.verification === 'verified' ? 'v' : 'nv'} -> ${newHex.priority}/${newHex.verification === 'verified' ? 'v' : 'nv'}`,
      p.reasons.join('; '),
    ]);
  }
}
console.log(table(['#', 'household', 'hex', 'hold', 'score', 'pSevere', 'unc', 'silence', 'truth', 'cell before -> after', 'why'], log));

// Self-check: the local-update path must equal a full recompute (same trust).
const fullSameTrust = estimateAll(world, events, atT, params, cfg, baselineTrust);
let maxDiff = 0;
for (let i = 0; i < households.length; i++) {
  const a = households[i];
  const b = fullSameTrust.households[i];
  if (a.householdId !== b.householdId) throw new Error('household order mismatch');
  maxDiff = Math.max(maxDiff, Math.abs(a.pSevere - b.pSevere), Math.abs(a.pNeedsHelp - b.pNeedsHelp), Math.abs(a.uncertainty - b.uncertainty));
}
for (let i = 0; i < hexes.length; i++) {
  const a = hexes[i];
  const b = fullSameTrust.hexes[i];
  if (a.priority !== b.priority || a.verification !== b.verification) throw new Error(`local update diverged from full recompute at ${a.hex}`);
  maxDiff = Math.max(maxDiff, Math.abs(a.severity - b.severity), Math.abs(a.confidence - b.confidence), Math.abs(a.silence - b.silence));
}
console.log(`\nself-check: local update vs full recompute, max abs diff = ${maxDiff.toExponential(2)} ${maxDiff < 1e-9 ? '(ok)' : '(MISMATCH)'}`);

// Default behaviour: trust is display-only, so "after" is the local-update result.
// Experimental variant: same events, learned trust applied to the weights.
const after = fullSameTrust;
const cfgTrustOn = { ...cfg, trust: { ...cfg.trust, applyToInference: true } };
const afterTrustOn = estimateAll(world, events, atT, params, cfgTrustOn, learning.trust);

console.log(heading('source trust (display; applyToInference=' + String(cfg.trust.applyToInference) + ')'));
console.log(
  table(
    ['', 'hazard', 'sms', 'claims'],
    [
      ['calibration (model.json)', baselineTrust.hazard, baselineTrust.sms, baselineTrust.claims],
      ['after reports', learning.trust.hazard, learning.trust.sms, learning.trust.claims],
      ['weight multipliers if applied', afterTrustOn.models.multipliers.hazard, afterTrustOn.models.multipliers.sms, afterTrustOn.models.multipliers.claims],
    ],
  ),
);
console.log(`reports: ${learning.nonHoldoutReports} non-holdout (used for trust), ${learning.holdoutReports} holdout (local update only), ${learning.pending.length} pending for next batch, ${learning.updates.length} trust update(s)`);
for (const u of learning.updates) {
  console.log(
    `  update after ${u.afterNonHoldoutReports} reports: batch scores hazard ${fmt(u.scores.hazard)} (n=${u.opinionCounts.hazard}), sms ${fmt(u.scores.sms)} (n=${u.opinionCounts.sms}), claims ${fmt(u.scores.claims)} (n=${u.opinionCounts.claims})  ->  trust ${fmt(u.after.hazard)}/${fmt(u.after.sms)}/${fmt(u.after.claims)}`,
  );
}

console.log(heading('before vs after the reports (same t; holdout metrics on the same fixed set)'));
const stillUnverified = new Set([...holdoutIds].filter((id) => !reported.has(id)));
const rows: (string | number)[][] = [];
for (const [label, est] of [
  ['before', before],
  ['after (local updates; default)', after],
  ['after + trust applied (experimental)', afterTrustOn],
] as const) {
  const c = tierCounts(est.hexes);
  const all = holdoutMetrics(est.households);
  const unv = holdoutMetrics(est.households, stillUnverified);
  const vc = verifiedCoverage(est.hexes, est.households, householdHex);
  rows.push([label, String(c.P0), String(c.P1), String(c.P2), String(c.needsVerification), String(c.p0NeedsVerification), all.brierSevere, all.brierHelp, unv.brierSevere, unv.brierHelp, pct(vc.cellShare), pct(vc.householdShare)]);
}
console.log(
  table(
    ['', 'P0', 'P1', 'P2', 'needs_ver', 'P0 needs_ver', `holdout Brier sev (n=${holdoutIds.size})`, 'holdout Brier help', `unverified-holdout Brier sev (n=${stillUnverified.size})`, 'unverified-holdout Brier help', 'verified cov (P0 cells)', 'verified cov (suspected hh)'],
    rows,
  ),
);

const changed: (string | number)[][] = [];
for (let i = 0; i < before.hexes.length; i++) {
  const a = before.hexes[i];
  const b = after.hexes[i];
  if (a.priority !== b.priority || a.verification !== b.verification) {
    changed.push([a.hex, `${a.priority}/${a.verification}`, `${b.priority}/${b.verification}`, String(b.counts.fieldReports), fmt(a.expectedSevere, 1), fmt(b.expectedSevere, 1), a.confidence, b.confidence, pct(truthSevereShare(a.hex))]);
  }
}
console.log(`\ncells whose tier or verification changed after the local updates: ${changed.length}`);
if (changed.length > 0) {
  console.log(table(['hex', 'before', 'after', 'field', 'E[sev] before', 'E[sev] after', 'conf before', 'conf after', 'truth sev% (eval)'], changed.slice(0, 15)));
  if (changed.length > 15) console.log(`... and ${changed.length - 15} more`);
}
let trustChanged = 0;
for (let i = 0; i < after.hexes.length; i++) {
  if (after.hexes[i].priority !== afterTrustOn.hexes[i].priority || after.hexes[i].verification !== afterTrustOn.hexes[i].verification) trustChanged++;
}
console.log(`cells that would additionally change if learned trust were applied to the weights: ${trustChanged}`);
