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
// v3 uncertainty (chosen strategy, all households): 95% cluster-bootstrap CIs (cells resampled within each
// held-out event, B = BOOT_B) for the mean-over-folds severe Brier / AUC / ECE; the fold range; the Brier
// skill score vs the hazard-only baseline; the cell overdispersion tau2 (method of moments, all folds) and
// the empirical coverage of the 90% cell interval with tau2 estimated on the OTHER folds (no leakage).

import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { EventBundle, HazardType, ModelParams } from '../../shared/types.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { FEATURE_NAMES, HAZARD_BASELINE_FEATURES, buildSnapshot, householdFeatureRecord, worldContext } from '../src/features.ts';
import { fitLogistic, predictProb } from '../src/logistic.ts';
import type { FitResult, LinearModel } from '../src/logistic.ts';
import { auc, brier, ece, summarize } from '../src/metrics.ts';
import { CELL_INTERVAL_TAIL, cellSevereInterval, estimateOverdispersion } from '../src/interval.ts';
import { mulberry32 } from '../src/rng.ts';
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
  /** cell index of each row (index into cellIds) */
  cell: Int32Array;
  cellIds: string[];
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
  const cellArr = new Int32Array(n);
  const cellIndex = new Map<string, number>();
  for (const h of b.world.households) if (!cellIndex.has(h.hex)) cellIndex.set(h.hex, cellIndex.size);
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
      cellArr[i] = cellIndex.get(h.hex)!;
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
    cell: cellArr,
    cellIds: [...cellIndex.keys()],
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
  world: WorldRows;
  /** severe probability for every row of the held-out event */
  pSevere: Float64Array;
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

// ---------- uncertainty (v3) ----------
const BOOT_B = 300;
const BOOT_SEED = 20261108;

interface FoldData {
  event: string;
  p: Float64Array;
  y: Uint8Array;
  cell: Int32Array;
  nCells: number;
  order: Int32Array; // rows sorted by p ascending (for the weighted AUC)
}

/** Weighted severe Brier / AUC / ECE (10 equal-width bins, as metrics.ts) with per-row integer weights. */
function weightedMetrics(d: FoldData, w: Float64Array): { brier: number; auc: number; ece: number } {
  let sw = 0;
  let sb = 0;
  const binN = new Float64Array(10);
  const binP = new Float64Array(10);
  const binY = new Float64Array(10);
  for (let i = 0; i < d.p.length; i++) {
    const wi = w[i];
    if (wi === 0) continue;
    const p = d.p[i];
    const y = d.y[i];
    sw += wi;
    sb += wi * (p - y) * (p - y);
    let b = Math.floor(p * 10);
    if (b >= 10) b = 9;
    binN[b] += wi;
    binP[b] += wi * p;
    binY[b] += wi * y;
  }
  let e = 0;
  for (let b = 0; b < 10; b++) if (binN[b] > 0) e += (binN[b] / sw) * Math.abs(binP[b] / binN[b] - binY[b] / binN[b]);
  // AUC: walk tie groups in ascending p; positives score negatives below them (+ half of tied ones).
  let negBelow = 0;
  let num = 0;
  let P = 0;
  let N = 0;
  let k = 0;
  while (k < d.order.length) {
    let j = k;
    let gp = 0;
    let gn = 0;
    const pv = d.p[d.order[k]];
    while (j < d.order.length && d.p[d.order[j]] === pv) {
      const i = d.order[j];
      if (d.y[i]) gp += w[i];
      else gn += w[i];
      j++;
    }
    num += gp * (negBelow + 0.5 * gn);
    negBelow += gn;
    P += gp;
    N += gn;
    k = j;
  }
  return { brier: sw > 0 ? sb / sw : NaN, auc: P > 0 && N > 0 ? num / (P * N) : NaN, ece: sw > 0 ? e : NaN };
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

interface CellObs { y: number; mu: number; binomVar: number; ps: number[]; n: number; fold: string }

/** One observation per (held-out event, snapshot time, cell): true severe count and the predictions. */
function cellObservations(fr: FoldRecord): CellObs[] {
  const w = fr.world;
  const groups = new Map<string, CellObs>();
  for (let i = 0; i < w.X.length; i++) {
    const key = `${w.t[i]}|${w.cell[i]}`;
    let g = groups.get(key);
    if (!g) {
      g = { y: 0, mu: 0, binomVar: 0, ps: [], n: 0, fold: fr.event };
      groups.set(key, g);
    }
    const p = fr.pSevere[i];
    g.y += w.ySevere[i];
    g.mu += p;
    g.binomVar += p * (1 - p);
    g.ps.push(p);
    g.n += 1;
  }
  return [...groups.values()];
}

interface Uncertainty {
  brierCI: [number, number];
  aucCI: [number, number];
  eceCI: [number, number];
  brierRange: [number, number];
  bss: number;
  bssRange: [number, number];
  tau2: number;
  coverage: number;
  meanWidth: number;
  coverageBinomialOnly: number;
  meanWidthBinomialOnly: number;
  coverageNearest: number;
  meanWidthNearest: number;
  coverageExact: number;
  meanWidthExact: number;
  perFold: { event: string; brier: number; bss: number; tau2: number; coverage: number; width: number; cells: number }[];
  tail: number;
  tailByFold: number[];
  coverageDefaultTail: number;
  meanWidthDefaultTail: number;
}

/**
 * Candidate tighter intervals, evaluated only (the live formula is engine/src/interval.ts):
 *   nearest: same normal approximation, bounds rounded to the nearest household instead of outward;
 *   exact:   equal-tailed 5% / 95% quantiles of the exact Poisson-binomial distribution of the count
 *            (sum of independent Bernoulli(p_i)), shared error ignored (tau2 is small).
 */
function candidateIntervals(c: CellObs, tau2: number): { nearest: [number, number]; exact: [number, number] } {
  let mu = 0;
  let bv = 0;
  for (const p of c.ps) {
    mu += p;
    bv += p * (1 - p);
  }
  const sd = Math.sqrt(bv + tau2 * mu * mu); // k = 0 in backtests
  const nearest: [number, number] = [Math.max(0, Math.round(mu - 1.645 * sd)), Math.min(c.n, Math.round(mu + 1.645 * sd))];
  // Poisson-binomial pmf by dynamic programming
  let pmf = new Float64Array(c.n + 1);
  pmf[0] = 1;
  let len = 1;
  for (const p of c.ps) {
    const next = new Float64Array(c.n + 1);
    for (let k = 0; k < len; k++) {
      next[k] += pmf[k] * (1 - p);
      next[k + 1] += pmf[k] * p;
    }
    pmf = next;
    len++;
  }
  let cdf = 0;
  let lo = 0;
  let hi = c.n;
  let loSet = false;
  for (let k = 0; k <= c.n; k++) {
    // lo = largest k with P(Y < k) <= 0.05; hi = smallest k with P(Y <= k) >= 0.95
    if (!loSet && cdf + pmf[k] > 0.05) {
      lo = k;
      loSet = true;
    }
    cdf += pmf[k];
    if (cdf >= 0.95) {
      hi = k;
      break;
    }
  }
  return { nearest, exact: [lo, hi] };
}

// Candidate tail probabilities for the cell interval (0.05 = equal-tailed 90 %; larger = narrower).
const TAILS = [0.05, 0.06, 0.07, 0.08, 0.09, 0.1, 0.12, 0.14, 0.16, 0.18, 0.2];
const TARGET_COVERAGE = 0.9;

function intervalCheck(obs: readonly CellObs[], tau2: number, tail = 0.05): { inside: number; width: number } {
  let inside = 0;
  let width = 0;
  for (const c of obs) {
    const iv = cellSevereInterval({ pUnverified: c.ps, verifiedSevere: 0, verifiedTotal: 0, n: c.n, tau2, shrink: cfg.neighbourUpdate.shrinkageCount, k: 0, tail });
    if (c.y >= iv.lo && c.y <= iv.hi) inside++;
    width += iv.hi - iv.lo;
  }
  return { inside, width };
}

function uncertaintyFor(chosenFolds: readonly FoldRecord[]): Uncertainty {
  // fold-level spread and skill
  const briers = chosenFolds.map((fr) => fr.all.severe.brier);
  const bssList = chosenFolds.map((fr) => 1 - fr.all.severe.brier / fr.all.severeBase.brier);
  // cluster bootstrap of the mean-over-folds metrics
  const data: FoldData[] = chosenFolds.map((fr) => {
    const order = Int32Array.from({ length: fr.pSevere.length }, (_, i) => i).sort((a, b) => fr.pSevere[a] - fr.pSevere[b] || a - b);
    return { event: fr.event, p: fr.pSevere, y: fr.world.ySevere, cell: fr.world.cell, nCells: fr.world.cellIds.length, order };
  });
  // sanity: unit weights reproduce metrics.ts
  for (const d of data) {
    const one = weightedMetrics(d, new Float64Array(d.p.length).fill(1));
    const ref = { brier: brier([...d.p], [...d.y]), auc: auc([...d.p], [...d.y]), ece: ece([...d.p], [...d.y]) };
    if (Math.abs(one.brier - ref.brier) > 1e-9 || Math.abs(one.ece - ref.ece) > 1e-9 || (Number.isFinite(ref.auc) && Math.abs(one.auc - ref.auc) > 1e-9))
      throw new Error(`weighted metrics disagree with metrics.ts on ${d.event}`);
  }
  const rng = mulberry32(BOOT_SEED);
  const bootB: number[] = [];
  const bootA: number[] = [];
  const bootE: number[] = [];
  for (let b = 0; b < BOOT_B; b++) {
    let sB = 0;
    let sA = 0;
    let sE = 0;
    let nA = 0;
    for (const d of data) {
      const counts = new Float64Array(d.nCells);
      for (let c = 0; c < d.nCells; c++) counts[Math.floor(rng.next() * d.nCells)] += 1;
      const w = new Float64Array(d.p.length);
      for (let i = 0; i < w.length; i++) w[i] = counts[d.cell[i]];
      const m = weightedMetrics(d, w);
      sB += m.brier;
      sE += m.ece;
      if (Number.isFinite(m.auc)) {
        sA += m.auc;
        nA++;
      }
    }
    bootB.push(sB / data.length);
    bootE.push(sE / data.length);
    if (nA > 0) bootA.push(sA / nA);
  }
  const ci = (v: number[]): [number, number] => {
    const s = [...v].sort((a, b) => a - b);
    return [quantile(s, 0.025), quantile(s, 0.975)];
  };
  // overdispersion and leak-free coverage
  const obsByFold = new Map<string, CellObs[]>();
  for (const fr of chosenFolds) obsByFold.set(fr.event, cellObservations(fr));
  const allObs = [...obsByFold.values()].flat();
  const tau2 = estimateOverdispersion(allObs);
  let inside = 0;
  let width = 0;
  let insideB = 0;
  let widthB = 0;
  let insideN = 0;
  let widthN = 0;
  let insideX = 0;
  let widthX = 0;
  const perFold: Uncertainty['perFold'] = [];
  const tailByFold: number[] = [];
  let insideD = 0;
  let widthD = 0;
  chosenFolds.forEach((fr, idx) => {
    const own = obsByFold.get(fr.event)!;
    const others = chosenFolds.length > 1 ? chosenFolds.filter((x) => x !== fr).flatMap((x) => obsByFold.get(x.event)!) : own;
    const t2 = estimateOverdispersion(others);
    // Nested choice of the tail: the widest tail (narrowest interval) that still covers >= 90 % of the
    // OTHER folds' cells; then measure coverage on this fold (never used to choose it).
    let tailE = TAILS[0]!;
    for (const tl of TAILS) {
      const r = intervalCheck(others, t2, tl);
      if (r.inside / Math.max(1, others.length) >= TARGET_COVERAGE) tailE = tl;
    }
    const r1 = intervalCheck(own, t2, tailE);
    tailByFold.push(tailE);
    const rD = intervalCheck(own, t2, CELL_INTERVAL_TAIL);
    insideD += rD.inside;
    widthD += rD.width;
    const r0 = intervalCheck(own, 0);
    for (const c of own) {
      const cand = candidateIntervals(c, t2);
      if (c.y >= cand.nearest[0] && c.y <= cand.nearest[1]) insideN++;
      widthN += cand.nearest[1] - cand.nearest[0];
      if (c.y >= cand.exact[0] && c.y <= cand.exact[1]) insideX++;
      widthX += cand.exact[1] - cand.exact[0];
    }
    inside += r1.inside;
    width += r1.width;
    insideB += r0.inside;
    widthB += r0.width;
    perFold.push({ event: fr.event, brier: briers[idx], bss: bssList[idx], tau2: t2, coverage: r1.inside / own.length, width: r1.width / own.length, cells: own.length });
  });
  const nObs = allObs.length;
  // Final tail for the live model: the widest tail whose leave-one-event-out coverage is still >= 90 %.
  let tail = TAILS[0]!;
  for (const tl of TAILS) {
    let ins = 0;
    for (const fr of chosenFolds) {
      const own = obsByFold.get(fr.event)!;
      const others = chosenFolds.length > 1 ? chosenFolds.filter((x) => x !== fr).flatMap((x) => obsByFold.get(x.event)!) : own;
      ins += intervalCheck(own, estimateOverdispersion(others), tl).inside;
    }
    if (ins / Math.max(1, nObs) >= TARGET_COVERAGE) tail = tl;
  }
  return {
    tail,
    tailByFold,
    coverageDefaultTail: insideD / Math.max(1, nObs),
    meanWidthDefaultTail: widthD / Math.max(1, nObs),
    brierCI: ci(bootB),
    aucCI: ci(bootA),
    eceCI: ci(bootE),
    brierRange: [Math.min(...briers), Math.max(...briers)],
    bss: meanOf(bssList),
    bssRange: [Math.min(...bssList), Math.max(...bssList)],
    tau2,
    coverage: inside / nObs,
    meanWidth: width / nObs,
    coverageBinomialOnly: insideB / nObs,
    meanWidthBinomialOnly: widthB / nObs,
    coverageNearest: insideN / nObs,
    meanWidthNearest: widthN / nObs,
    coverageExact: insideX / nObs,
    meanWidthExact: widthX / nObs,
    perFold,
  };
}

function printUncertainty(region: string, u: Uncertainty) {
  console.log(`\nuncertainty for ${region} (chosen strategy, all households, ${BOOT_B} cluster-bootstrap replicates):`);
  console.log(
    table(
      ['fold', 'sev Brier', 'BSS', 'tau2 (other folds)', '90% cell coverage', 'mean width', 'cell obs'],
      u.perFold.map((f) => [f.event, f.brier, f.bss, f.tau2, f.coverage, f.width, String(f.cells)]),
    ),
  );
  const r = (a: [number, number]) => `[${fmt(a[0])}, ${fmt(a[1])}]`;
  console.log(`  severe Brier 95% CI ${r(u.brierCI)}  fold range ${r(u.brierRange)}`);
  console.log(`  AUC 95% CI ${r(u.aucCI)}  ECE 95% CI ${r(u.eceCI)}`);
  console.log(`  Brier skill score ${fmt(u.bss)} (fold range ${r(u.bssRange)})`);
  console.log(`  deployed (equal-tailed 90%): held-out coverage ${pct(u.coverageDefaultTail, 1)}, mean width ${fmt(u.meanWidthDefaultTail)} households`);
  console.log(`  tau2 (all folds) ${fmt(u.tau2)}; calibrated tail ${u.tail} (per fold: ${u.tailByFold.join(', ')}); nested held-out 90% cell coverage ${pct(u.coverage, 1)}, mean width ${fmt(u.meanWidth)} households`);
  console.log(`  (binomial only, tau2 = 0: coverage ${pct(u.coverageBinomialOnly, 1)}, mean width ${fmt(u.meanWidthBinomialOnly)})`);
  console.log(`  candidates (not used live): nearest rounding coverage ${pct(u.coverageNearest, 1)}, width ${fmt(u.meanWidthNearest)}; exact Poisson-binomial 5-95% coverage ${pct(u.coverageExact, 1)}, width ${fmt(u.meanWidthExact)}`);
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
      const allIdx = Array.from({ length: held.X.length }, (_, k) => k);
      const pSevere = Float64Array.from(predictRows(f.severe.model, held.X, allIdx, null));
      folds.push({ event: held.eventId, strategy, world: held, pSevere, all: evaluate(f, held, false), holdout: evaluate(f, held, true), rows: f.rows, ms: f.ms });
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
  const unc = uncertaintyFor(folds.filter((fr) => fr.strategy === chosen));
  printUncertainty(r.id, unc);

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
      brierCI: unc.brierCI,
      aucCI: unc.aucCI,
      eceCI: unc.eceCI,
      brierRange: unc.brierRange,
      bss: unc.bss,
      bssRange: unc.bssRange,
      cellIntervalCoverage: unc.coverageDefaultTail,
      cellIntervalMeanWidth: unc.meanWidthDefaultTail,
    },
    cellOverdispersion: unc.tau2,
    // Live uses the conservative equal-tailed 90 % interval: the backtest-calibrated (narrower) tail was
    // overconfident on the harder live events (see docs/DATA.md). unc.tail is printed for reference.
    cellIntervalTail: CELL_INTERVAL_TAIL,
    region: own[0].worldRegion ?? r.id,
    hazardType: own[0].hazardType,
    trainedOn: finalTrain.map((w) => (w.region === r.id ? w.eventId : w.key)),
  };
  const out = singleOut ?? join(r.dir, 'model.json');
  writeJson(out, params);
  console.log(`wrote ${out}  (calibration = mean LOEO of the ${chosen} strategy, all households, pooled over ${times.map(minutesLabel).join('/')})`);
}
console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)} s`);
