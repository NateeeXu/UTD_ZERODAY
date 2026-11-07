// Backtest calibration.
//   node scripts/calibrate.ts [dataDir] [--out=<model.json>] [--test=backtest-6]
//                             [--times=360,720,1440,2880] [--l2=1]
// Trains P(damage>=2) and P(needs_help) on non-holdout households of every
// backtest except the test event, at several snapshot times, and reports
// Brier / ECE / AUC on the test event (all + holdout households) and on the
// holdout households of the training events. A hazard-only baseline
// (maps + policy attributes, no SMS, no claims) is fitted the same way so the
// gain from fusion is visible.

import { join } from 'node:path';
import type { EventBundle, ModelParams } from '../../shared/types.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { FEATURE_NAMES, HAZARD_BASELINE_FEATURES, buildSnapshot, householdFeatureRecord, selectFeatures } from '../src/features.ts';
import type { FeatureName } from '../src/features.ts';
import { fitLogistic, predictProb } from '../src/logistic.ts';
import type { FitResult, LinearModel } from '../src/logistic.ts';
import { brier, summarize } from '../src/metrics.ts';
import type { MetricSummary } from '../src/metrics.ts';
import { sourceOpinions } from '../src/learning.ts';
import { fmt, heading, loadBacktests, minutesLabel, parseArgs, pct, resolveDataDir, table, truthMap, writeJson } from './io.ts';

const cfg = DEFAULT_CONFIG;
const args = parseArgs(process.argv.slice(2));
const dataDir = resolveDataDir(args);
const outPath = args.flags.get('out') ?? join(dataDir, 'model.json');
const times = (args.flags.get('times') ?? '360,720,1440,2880').split(',').map(Number);
const l2 = Number(args.flags.get('l2') ?? 1);

interface Row {
  world: string;
  t: number;
  holdout: boolean;
  x: number[];
  ySevere: 0 | 1;
  yHelp: 0 | 1;
  opinions: { hazard: number; sms: number | null; claims: number | null };
}

function buildRows(b: EventBundle, t: number): Row[] {
  const truth = truthMap(b.truth);
  const snap = buildSnapshot(b.world, b.events, t, cfg);
  const rows: Row[] = [];
  for (const h of b.world.households) {
    const tr = truth.get(h.id);
    if (!tr) throw new Error(`${b.world.eventId}: no truth for ${h.id}`);
    const rec = householdFeatureRecord(h, snap, cfg);
    rows.push({
      world: b.world.eventId,
      t,
      holdout: h.holdout,
      x: FEATURE_NAMES.map((n) => rec[n]),
      ySevere: tr.damage >= 2 ? 1 : 0,
      yHelp: tr.safety === 'needs_help' ? 1 : 0,
      opinions: sourceOpinions(h.id, snap),
    });
  }
  return rows;
}

const bundles = loadBacktests(dataDir);
const testId = args.flags.get('test') ?? (bundles.some((b) => b.world.eventId === 'backtest-6') ? 'backtest-6' : bundles[bundles.length - 1].world.eventId);
const test = bundles.find((b) => b.world.eventId === testId);
if (!test) throw new Error(`test event ${testId} not found among ${bundles.map((b) => b.world.eventId).join(', ')}`);
const train = bundles.filter((b) => b.world.eventId !== testId);
if (train.length === 0) throw new Error('need at least one training event besides the test event');

console.log(`data: ${dataDir}`);
console.log(`train: ${train.map((b) => b.world.eventId).join(', ')}   test: ${testId}   snapshots: ${times.map(minutesLabel).join(' ')}   l2=${l2}`);

const t0 = Date.now();
const trainRows: Row[] = [];
const trainHoldoutRows: Row[] = [];
for (const b of train) {
  for (const t of times) {
    for (const r of buildRows(b, t)) (r.holdout ? trainHoldoutRows : trainRows).push(r);
  }
}
const testRowsByTime = new Map<number, Row[]>();
for (const t of times) testRowsByTime.set(t, buildRows(test, t));
const testRows = times.flatMap((t) => testRowsByTime.get(t)!);
console.log(`rows: train ${trainRows.length} (non-holdout), train-holdout ${trainHoldoutRows.length}, test ${testRows.length}  [${Date.now() - t0} ms]`);

// ---------- fit ----------
const baselineIdx = HAZARD_BASELINE_FEATURES.map((n) => FEATURE_NAMES.indexOf(n));
const pick = (x: readonly number[], idx: readonly number[]): number[] => idx.map((i) => x[i]);

function fit(label: string, X: number[][], y: number[]): FitResult {
  const t1 = Date.now();
  const res = fitLogistic(X, y, { l2, maxIter: 60, tol: 1e-8 });
  console.log(`fit ${label}: ${res.iterations} iterations, converged=${res.converged}, loss=${fmt(res.finalLoss, 1)} [${Date.now() - t1} ms]`);
  return res;
}

const Xfull = trainRows.map((r) => r.x);
const Xbase = trainRows.map((r) => pick(r.x, baselineIdx));
const ySevere = trainRows.map((r) => r.ySevere);
const yHelp = trainRows.map((r) => r.yHelp);

const severeFit = fit('severe (fusion)', Xfull, ySevere);
const helpFit = fit('needsHelp (fusion)', Xfull, yHelp);
const severeBase = fit('severe (hazard-only)', Xbase, ySevere);
const helpBase = fit('needsHelp (hazard-only)', Xbase, yHelp);

// ---------- evaluate ----------
function evalRows(rows: readonly Row[], model: LinearModel, idx: readonly number[] | null, which: 'severe' | 'help'): MetricSummary {
  const p = rows.map((r) => predictProb(model, idx ? pick(r.x, idx) : r.x));
  const y = rows.map((r) => (which === 'severe' ? r.ySevere : r.yHelp));
  return summarize(p, y);
}

interface EvalSet {
  label: string;
  rows: Row[];
}

function evalSets(): EvalSet[] {
  const sets: EvalSet[] = [];
  for (const t of times) {
    const rows = testRowsByTime.get(t)!;
    sets.push({ label: `${testId} all @${minutesLabel(t)}`, rows });
  }
  sets.push({ label: `${testId} all pooled`, rows: testRows });
  sets.push({ label: `${testId} holdout pooled`, rows: testRows.filter((r) => r.holdout) });
  sets.push({ label: `train-events holdout pooled`, rows: trainHoldoutRows });
  return sets;
}

function metricsTable(which: 'severe' | 'help', full: LinearModel, base: LinearModel): string {
  const rows = evalSets().map((s) => {
    const f = evalRows(s.rows, full, null, which);
    const b = evalRows(s.rows, base, baselineIdx, which);
    return [s.label, String(f.n), pct(f.positives / Math.max(f.n, 1), 1), f.brier, f.ece, f.auc, b.brier, b.ece, b.auc, f.brier - b.brier];
  });
  return table(['set', 'n', 'pos', 'Brier', 'ECE', 'AUC', 'base Brier', 'base ECE', 'base AUC', 'dBrier'], rows);
}

console.log(heading('P(damage >= 2): fusion vs hazard-only baseline (lower Brier/ECE better, higher AUC better)'));
console.log(metricsTable('severe', severeFit.model, severeBase.model));
console.log(heading('P(safety = needs_help): fusion vs hazard-only baseline'));
console.log(metricsTable('help', helpFit.model, helpBase.model));

function topWeights(res: FitResult, names: readonly string[], k = 10): string {
  const order = res.standardizedWeights.map((w, i) => ({ w, i })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  return order
    .slice(0, k)
    .map(({ w, i }) => `${names[i]} ${w >= 0 ? '+' : ''}${w.toFixed(2)}`)
    .join(', ');
}
console.log(heading('largest standardised weights'));
console.log(`severe:    ${topWeights(severeFit, FEATURE_NAMES)}`);
console.log(`needsHelp: ${topWeights(helpFit, FEATURE_NAMES)}`);

// ---------- source trust at calibration ----------
// Each source's own P(severe) proxy (see learning.ts sourceOpinions), scored
// as 1 - Brier against truth over the training rows. Online learning later
// moves these numbers with the same definition.
function trustFrom(rows: readonly Row[]): { trust: ModelParams['sourceTrust']; counts: Record<string, number> } {
  const score = (key: 'hazard' | 'sms' | 'claims'): { v: number; n: number } => {
    const p: number[] = [];
    const y: number[] = [];
    for (const r of rows) {
      const o = r.opinions[key];
      if (o === null) continue;
      p.push(o);
      y.push(r.ySevere);
    }
    const b = brier(p, y);
    return { v: p.length > 0 ? Math.min(1, Math.max(0.01, 1 - b)) : 0.5, n: p.length };
  };
  const hz = score('hazard');
  const sm = score('sms');
  const cl = score('claims');
  return { trust: { hazard: hz.v, sms: sm.v, claims: cl.v }, counts: { hazard: hz.n, sms: sm.n, claims: cl.n } };
}
const trustTrain = trustFrom(trainRows);
const trustTest = trustFrom(testRows.filter((r) => !r.holdout));
console.log(heading('source trust = 1 - Brier of each source\'s own severe-damage signal'));
console.log(
  table(
    ['set', 'hazard', 'n', 'sms', 'n', 'claims', 'n'],
    [
      ['train events', trustTrain.trust.hazard, String(trustTrain.counts.hazard), trustTrain.trust.sms, String(trustTrain.counts.sms), trustTrain.trust.claims, String(trustTrain.counts.claims)],
      [`${testId} (non-holdout)`, trustTest.trust.hazard, String(trustTest.counts.hazard), trustTest.trust.sms, String(trustTest.counts.sms), trustTest.trust.claims, String(trustTest.counts.claims)],
    ],
  ),
);

// ---------- write model ----------
const testSevere = evalRows(testRows, severeFit.model, null, 'severe');
const params: ModelParams = {
  version: 1,
  features: [...FEATURE_NAMES],
  severe: { bias: severeFit.model.bias, weights: severeFit.model.weights },
  needsHelp: { bias: helpFit.model.bias, weights: helpFit.model.weights },
  sourceTrust: trustTrain.trust,
  calibration: { brier: testSevere.brier, ece: testSevere.ece, heldOutEvent: testId },
  trainedOn: train.map((b) => b.world.eventId),
};
writeJson(outPath, params);
console.log(`\nwrote ${outPath}  (calibration = severe model on ${testId}, all households, pooled over ${times.map(minutesLabel).join('/')})`);

// Baseline weights are not part of the contract; keep them next to the model for the demo.
const baselineOut = outPath.replace(/\.json$/, '.hazard-baseline.json');
if (args.flags.get('write-baseline') === 'true') {
  writeJson(baselineOut, {
    note: 'hazard-only baseline (maps + policy attributes); not used by the engine, for comparison only',
    features: HAZARD_BASELINE_FEATURES as FeatureName[],
    severe: severeBase.model,
    needsHelp: helpBase.model,
  });
  console.log(`wrote ${baselineOut}`);
}
