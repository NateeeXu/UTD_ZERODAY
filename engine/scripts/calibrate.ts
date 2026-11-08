// Backtest calibration (v2): leave-one-event-out per region, region-specific vs pooled.
//   node scripts/calibrate.ts                       # all known regions under <repo>/data
//   node scripts/calibrate.ts --regions tx-corpus-christi,ca-bay-area
//   node scripts/calibrate.ts <dataDir> --out <model.json>   # one directory (no pooling partner)
// Options: --data-root <dir> --times 360,720,1440,2880 --l2 1 --no-pooled
//
// For every region and every backtest event e (leave-one-event-out):
//   specific: train on the region's other events;  pooled: train on every other event of every region
//   (all hazards share the 0-1 hazardIndex). Both are evaluated on e (all households and holdout only).
// The strategy with the lower mean severe Brier wins; the final model is that strategy trained on
// all backtests, and ModelParams.calibration stores the LOEO means (never in-sample numbers).
// Holdout households are never trained on. Truth is used only as labels. sim-meta.json is never read.

import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { EventBundle, HazardType, ModelParams } from '../../shared/types.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { FEATURE_NAMES, HAZARD_BASELINE_FEATURES, buildSnapshot, householdFeatureRecord, worldContext } from '../src/features.ts';
import { fitLogistic, predictProb } from '../src/logistic.ts';
import type { FitResult, LinearModel } from '../src/logistic.ts';
import { brier, summarize } from '../src/metrics.ts';
import type { MetricSummary } from '../src/metrics.ts';
import { sourceOpinions } from '../src/learning.ts';
import { DEFAULT_DATA_DIR, fmt, heading, knownRegions, loadBacktests, minutesLabel, parseArgs, pct, table, truthMap, writeJson } from './io.ts';
import type { RegionSpec } from './io.ts';

const cfg = DEFAULT_CONFIG;
const args = parseArgs(process.argv.slice(2));
const times = (args.flags.get('times') ?? '360,720,1440,2880').split(',').map(Number);
const l2 = Number(args.flags.get('l2') ?? 1);
const usePooled = args.flags.get('no-pooled') !== 'true';
const dataRoot = resolve(args.flags.get('data-root') ?? DEFAULT_DATA_DIR);

// ---------- which regions ----------
let regions: RegionSpec[];
let singleOut: string | null = null;
if (args.positional.length > 0) {
  const dir = resolve(args.positional[0]);
  regions = [{ id: basename(dir), dir, label: dir }];
  singleOut = args.flags.get('out') ?? join(dir, 'model.json');
} else {
  const wanted = args.flags.get('regions')?.split(',');
  regions = knownRegions(dataRoot).filter((r) => !wanted || wanted.includes(r.id));
  const missing = regions.filter((r) => !existsSync(r.dir));
  for (const m of missing) console.log(`skipping ${m.id}: ${m.dir} does not exist`);
  regions = regions.filter((r) => existsSync(r.dir));
}
if (regions.length === 0) throw new Error('no regions to calibrate');

// ---------- rows ----------
interface WorldRows {
  region: string;
  eventId: string;
  key: string;
  hazardType: HazardType;
  worldRegion: string | undefined;
  X: Float64Array[];
  ySevere: Uint8Array;
  yHelp: Uint8Array;
  holdout: Uint8Array;
  t: Int32Array;
  opinionHazard: Float64Array;
  opinionSms: Float64Array; // NaN = no opinion
  opinionClaims: Float64Array;
}

function buildWorldRows(region: string, b: EventBundle): WorldRows {
  const truth = truthMap(b.truth);
  const n = b.world.households.length * times.length;
  const X: Float64Array[] = new Array(n);
  const ySevere = new Uint8Array(n);
  const yHelp = new Uint8Array(n);
  const holdout = new Uint8Array(n);
  const tArr = new Int32Array(n);
  const oh = new Float64Array(n);
  const os = new Float64Array(n);
  const oc = new Float64Array(n);
  let i = 0;
  for (const t of times) {
    const snap = buildSnapshot(b.world, b.events, t, cfg);
    for (const h of b.world.households) {
      const tr = truth.get(h.id);
      if (!tr) throw new Error(`${b.world.eventId}: no truth for ${h.id}`);
      const rec = householdFeatureRecord(h, snap, cfg);
      const row = new Float64Array(FEATURE_NAMES.length);
      for (let j = 0; j < FEATURE_NAMES.length; j++) row[j] = rec[FEATURE_NAMES[j]];
      X[i] = row;
      ySevere[i] = tr.damage >= 2 ? 1 : 0;
      yHelp[i] = tr.safety === 'needs_help' ? 1 : 0;
      holdout[i] = h.holdout ? 1 : 0;
      tArr[i] = t;
      const op = sourceOpinions(h.id, snap);
      oh[i] = op.hazard;
      os[i] = op.sms === null ? NaN : op.sms;
      oc[i] = op.claims === null ? NaN : op.claims;
      i++;
    }
  }
  return {
    region,
    eventId: b.world.eventId,
    key: `${region}/${b.world.eventId}`,
    hazardType: worldContext(b.world, cfg).hazardType,
    worldRegion: b.world.region,
    X,
    ySevere,
    yHelp,
    holdout,
    t: tArr,
    opinionHazard: oh,
    opinionSms: os,
    opinionClaims: oc,
  };
}

const t0 = Date.now();
const worldsByRegion = new Map<string, WorldRows[]>();
for (const r of regions) {
  const bundles = loadBacktests(r.dir);
  const rows = bundles.map((b) => buildWorldRows(r.id, b));
  worldsByRegion.set(r.id, rows);
  const ctx = worldContext(bundles[0].world, cfg);
  console.log(
    `${r.id}: ${rows.map((w) => `${w.eventId} (${w.X.length / times.length} hh)`).join(', ')}  hazard=${ctx.hazardType} daytime=${ctx.daytime} schoolHours=${ctx.schoolHours} (time from ${ctx.timeSource})`,
  );
}
const allWorlds = [...worldsByRegion.values()].flat();
console.log(`rows built in ${Date.now() - t0} ms; snapshots ${times.map(minutesLabel).join(' ')}; l2=${l2}; features ${FEATURE_NAMES.length} (baseline ${HAZARD_BASELINE_FEATURES.length})`);

// ---------- fitting ----------
const baselineCols = HAZARD_BASELINE_FEATURES.map((n) => FEATURE_NAMES.indexOf(n));

interface TrainSet {
  X: Float64Array[];
  ySevere: number[];
  yHelp: number[];
}

function trainSet(worlds: readonly WorldRows[]): TrainSet {
  const X: Float64Array[] = [];
  const ySevere: number[] = [];
  const yHelp: number[] = [];
  for (const w of worlds) {
    for (let i = 0; i < w.X.length; i++) {
      if (w.holdout[i]) continue; // holdout households never train
      X.push(w.X[i]);
      ySevere.push(w.ySevere[i]);
      yHelp.push(w.yHelp[i]);
    }
  }
  return { X, ySevere, yHelp };
}

interface Fitted {
  severe: FitResult;
  help: FitResult;
  severeBase: FitResult;
  helpBase: FitResult;
  rows: number;
  ms: number;
}

function fitAll(ts: TrainSet): Fitted {
  const t1 = Date.now();
  const opts = { l2, maxIter: 60, tol: 1e-8 };
  const severe = fitLogistic(ts.X, ts.ySevere, opts);
  const help = fitLogistic(ts.X, ts.yHelp, opts);
  const severeBase = fitLogistic(ts.X, ts.ySevere, opts, baselineCols);
  const helpBase = fitLogistic(ts.X, ts.yHelp, opts, baselineCols);
  for (const [name, f] of [['severe', severe], ['help', help], ['severe-base', severeBase], ['help-base', helpBase]] as const) {
    if (!f.converged) console.log(`  warning: ${name} did not converge in ${f.iterations} iterations`);
  }
  return { severe, help, severeBase, helpBase, rows: ts.X.length, ms: Date.now() - t1 };
}

function predictRows(model: LinearModel, X: readonly Float64Array[], idx: readonly number[], cols: readonly number[] | null): number[] {
  const out = new Array<number>(idx.length);
  const buf = cols ? new Float64Array(cols.length) : null;
  for (let k = 0; k < idx.length; k++) {
    const row = X[idx[k]];
    if (cols && buf) {
      for (let j = 0; j < cols.length; j++) buf[j] = row[cols[j]];
      out[k] = predictProb(model, buf);
    } else out[k] = predictProb(model, row);
  }
  return out;
}

interface EvalResult {
  severe: MetricSummary;
  help: MetricSummary;
  severeBase: MetricSummary;
  helpBase: MetricSummary;
}

function evaluate(f: Fitted, w: WorldRows, onlyHoldout: boolean): EvalResult {
  const idx: number[] = [];
  for (let i = 0; i < w.X.length; i++) if (!onlyHoldout || w.holdout[i]) idx.push(i);
  const yS = idx.map((i) => w.ySevere[i]);
  const yH = idx.map((i) => w.yHelp[i]);
  return {
    severe: summarize(predictRows(f.severe.model, w.X, idx, null), yS),
    help: summarize(predictRows(f.help.model, w.X, idx, null), yH),
    severeBase: summarize(predictRows(f.severeBase.model, w.X, idx, baselineCols), yS),
    helpBase: summarize(predictRows(f.helpBase.model, w.X, idx, baselineCols), yH),
  };
}

function meanOf(values: number[]): number {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

interface FoldRecord {
  event: string;
  strategy: 'specific' | 'pooled';
  all: EvalResult;
  holdout: EvalResult;
  rows: number;
  ms: number;
}

function evalRow(label: string, e: EvalResult, n: string): (string | number)[] {
  return [label, n, pct(e.severe.positives / Math.max(e.severe.n, 1), 1), e.severe.brier, e.severe.ece, e.severe.auc, e.severeBase.brier, e.severeBase.auc, pct(e.help.positives / Math.max(e.help.n, 1), 1), e.help.brier, e.help.ece, e.help.auc, e.helpBase.brier, e.helpBase.auc];
}
const EVAL_HEADERS = ['fold / strategy', 'n', 'sev%', 'sev Brier', 'sev ECE', 'sev AUC', 'base Brier', 'base AUC', 'help%', 'help Brier', 'help ECE', 'help AUC', 'base Brier', 'base AUC'];

function meanEval(list: EvalResult[]): EvalResult {
  const m = (pick: (e: EvalResult) => MetricSummary): MetricSummary => ({
    n: list.reduce((a, e) => a + pick(e).n, 0),
    positives: list.reduce((a, e) => a + pick(e).positives, 0),
    brier: meanOf(list.map((e) => pick(e).brier)),
    ece: meanOf(list.map((e) => pick(e).ece)),
    auc: meanOf(list.map((e) => pick(e).auc)),
    logLoss: meanOf(list.map((e) => pick(e).logLoss)),
  });
  return { severe: m((e) => e.severe), help: m((e) => e.help), severeBase: m((e) => e.severeBase), helpBase: m((e) => e.helpBase) };
}

function trustFrom(worlds: readonly WorldRows[]): ModelParams['sourceTrust'] {
  const score = (pick: (w: WorldRows) => Float64Array): number => {
    const p: number[] = [];
    const y: number[] = [];
    for (const w of worlds) {
      const o = pick(w);
      for (let i = 0; i < w.X.length; i++) {
        if (w.holdout[i] || Number.isNaN(o[i])) continue;
        p.push(o[i]);
        y.push(w.ySevere[i]);
      }
    }
    if (p.length === 0) return 0.5;
    return Math.min(1, Math.max(0.01, 1 - brier(p, y)));
  };
  return { hazard: score((w) => w.opinionHazard), sms: score((w) => w.opinionSms), claims: score((w) => w.opinionClaims) };
}

function topWeights(res: FitResult, k = 10): string {
  return res.standardizedWeights
    .map((w, i) => ({ w, i }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
    .slice(0, k)
    .map(({ w, i }) => `${FEATURE_NAMES[i]} ${w >= 0 ? '+' : ''}${w.toFixed(2)}`)
    .join(', ');
}

// ---------- per region ----------
for (const r of regions) {
  const own = worldsByRegion.get(r.id)!;
  const others = allWorlds.filter((w) => w.region !== r.id);
  const canPool = usePooled && others.length > 0;
  console.log(heading(`${r.id}: leave-one-event-out over ${own.map((w) => w.eventId).join(', ')}${canPool ? ` (pooled adds ${others.length} events from ${[...new Set(others.map((w) => w.region))].join(', ')})` : ''}`));

  const folds: FoldRecord[] = [];
  for (const held of own) {
    const strategies: ('specific' | 'pooled')[] = canPool ? ['specific', 'pooled'] : ['specific'];
    for (const strategy of strategies) {
      const train = strategy === 'specific' ? own.filter((w) => w !== held) : allWorlds.filter((w) => w !== held);
      if (train.length === 0) continue;
      const f = fitAll(trainSet(train));
      folds.push({ event: held.eventId, strategy, all: evaluate(f, held, false), holdout: evaluate(f, held, true), rows: f.rows, ms: f.ms });
      console.log(`  fold ${held.eventId} / ${strategy}: ${f.rows} training rows, ${f.ms} ms`);
    }
  }

  const rowsAll: (string | number)[][] = [];
  const rowsHold: (string | number)[][] = [];
  for (const fr of folds) {
    rowsAll.push(evalRow(`${fr.event} / ${fr.strategy}`, fr.all, String(fr.all.severe.n)));
    rowsHold.push(evalRow(`${fr.event} / ${fr.strategy}`, fr.holdout, String(fr.holdout.severe.n)));
  }
  const means = new Map<string, { all: EvalResult; holdout: EvalResult; count: number }>();
  for (const strategy of ['specific', 'pooled'] as const) {
    const list = folds.filter((f) => f.strategy === strategy);
    if (list.length === 0) continue;
    const all = meanEval(list.map((f) => f.all));
    const holdout = meanEval(list.map((f) => f.holdout));
    means.set(strategy, { all, holdout, count: list.length });
    rowsAll.push(evalRow(`MEAN / ${strategy}`, all, `${list.length} folds`));
    rowsHold.push(evalRow(`MEAN / ${strategy}`, holdout, `${list.length} folds`));
  }
  console.log('\nall households of the held-out event:');
  console.log(table(EVAL_HEADERS, rowsAll));
  console.log('\nholdout households only (never trained on anywhere):');
  console.log(table(EVAL_HEADERS, rowsHold));

  // choose
  let chosen: 'specific' | 'pooled' = 'specific';
  let why = 'only one strategy available';
  const sp = means.get('specific');
  const po = means.get('pooled');
  if (sp && po) {
    const dSev = po.all.severe.brier - sp.all.severe.brier;
    const dHelp = po.all.help.brier - sp.all.help.brier;
    if (dSev < -1e-4 || (Math.abs(dSev) <= 1e-4 && dHelp < 0)) {
      chosen = 'pooled';
      why = `pooled has lower mean LOEO severe Brier (${fmt(po.all.severe.brier)} vs ${fmt(sp.all.severe.brier)}; needs-help ${fmt(po.all.help.brier)} vs ${fmt(sp.all.help.brier)})`;
    } else {
      why = `region-specific has lower (or equal) mean LOEO severe Brier (${fmt(sp.all.severe.brier)} vs pooled ${fmt(po.all.severe.brier)}; needs-help ${fmt(sp.all.help.brier)} vs ${fmt(po.all.help.brier)})`;
    }
  }
  console.log(`\nchosen strategy for ${r.id}: ${chosen} - ${why}`);

  // final model
  const finalTrain = chosen === 'specific' ? own : allWorlds;
  const f = fitAll(trainSet(finalTrain));
  const m = means.get(chosen)!;
  console.log(`final fit (${chosen}): ${f.rows} rows, ${f.ms} ms`);
  console.log(`  severe:    ${topWeights(f.severe)}`);
  console.log(`  needsHelp: ${topWeights(f.help)}`);
  const trust = trustFrom(finalTrain);
  console.log(`  source trust: hazard ${fmt(trust.hazard)}, sms ${fmt(trust.sms)}, claims ${fmt(trust.claims)}`);

  const params: ModelParams = {
    version: 2,
    features: [...FEATURE_NAMES],
    severe: { bias: f.severe.model.bias, weights: f.severe.model.weights },
    needsHelp: { bias: f.help.model.bias, weights: f.help.model.weights },
    sourceTrust: trust,
    calibration: {
      brier: m.all.severe.brier,
      ece: m.all.severe.ece,
      heldOutEvent: `leave-one-event-out:${own.map((w) => w.eventId).join(',')}`,
      auc: m.all.severe.auc,
      needsHelp: { brier: m.all.help.brier, ece: m.all.help.ece, auc: m.all.help.auc },
      baseline: { brier: m.all.severeBase.brier, ece: m.all.severeBase.ece, auc: m.all.severeBase.auc },
    },
    region: own[0].worldRegion ?? r.id,
    hazardType: own[0].hazardType,
    trainedOn: finalTrain.map((w) => (w.region === r.id ? w.eventId : w.key)),
  };
  const out = singleOut ?? join(r.dir, 'model.json');
  writeJson(out, params);
  console.log(`wrote ${out}  (calibration = mean LOEO of the ${chosen} strategy, all households, pooled over ${times.map(minutesLabel).join('/')})`);
}
console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)} s`);
