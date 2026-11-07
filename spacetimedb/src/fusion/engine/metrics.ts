// COPIED from engine/src/metrics.ts by spacetimedb/scripts/sync-engine.ts. Do not edit here; edit engine/src and re-sync.
// Calibration and ranking metrics. All functions are pure and return NaN
// (never a misleading number) when a metric is undefined for the input.

import type { HexEstimate, HouseholdEstimate } from '../contract.ts';

export interface Scored {
  p: number;
  y: 0 | 1;
}

function checkPairs(p: readonly number[], y: readonly number[]): void {
  if (p.length !== y.length) throw new Error(`metrics: ${p.length} predictions vs ${y.length} labels`);
  for (let i = 0; i < p.length; i++) {
    if (!(p[i] >= 0 && p[i] <= 1)) throw new Error(`metrics: prediction ${p[i]} at ${i} is not in [0,1]`);
    if (y[i] !== 0 && y[i] !== 1) throw new Error(`metrics: label ${y[i]} at ${i} is not 0/1`);
  }
}

/** Mean squared error between probability and 0/1 outcome. Lower is better. */
export function brier(p: readonly number[], y: readonly number[]): number {
  checkPairs(p, y);
  if (p.length === 0) return NaN;
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const d = p[i] - y[i];
    s += d * d;
  }
  return s / p.length;
}

export function logLoss(p: readonly number[], y: readonly number[], eps = 1e-6): number {
  checkPairs(p, y);
  if (p.length === 0) return NaN;
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const q = Math.min(1 - eps, Math.max(eps, p[i]));
    s -= y[i] === 1 ? Math.log(q) : Math.log(1 - q);
  }
  return s / p.length;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  meanP: number;
  meanY: number;
}

/** Equal-width reliability bins. Empty bins have n = 0 and NaN means. */
export function calibrationBins(p: readonly number[], y: readonly number[], bins = 10): CalibrationBin[] {
  checkPairs(p, y);
  const out: CalibrationBin[] = [];
  for (let b = 0; b < bins; b++) out.push({ lo: b / bins, hi: (b + 1) / bins, n: 0, meanP: 0, meanY: 0 });
  for (let i = 0; i < p.length; i++) {
    let b = Math.floor(p[i] * bins);
    if (b >= bins) b = bins - 1;
    const bin = out[b];
    bin.n += 1;
    bin.meanP += p[i];
    bin.meanY += y[i];
  }
  for (const bin of out) {
    if (bin.n > 0) {
      bin.meanP /= bin.n;
      bin.meanY /= bin.n;
    } else {
      bin.meanP = NaN;
      bin.meanY = NaN;
    }
  }
  return out;
}

/** Expected calibration error with equal-width bins (default 10). */
export function ece(p: readonly number[], y: readonly number[], bins = 10): number {
  if (p.length === 0) return NaN;
  const cb = calibrationBins(p, y, bins);
  let s = 0;
  for (const bin of cb) if (bin.n > 0) s += (bin.n / p.length) * Math.abs(bin.meanP - bin.meanY);
  return s;
}

/** Area under the ROC curve (Mann-Whitney with tie correction). NaN if one class is missing. */
export function auc(p: readonly number[], y: readonly number[]): number {
  checkPairs(p, y);
  const n = p.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => p[a] - p[b] || a - b);
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && p[idx[j + 1]] === p[idx[i]]) j++;
    const avg = (i + j) / 2 + 1; // 1-based average rank for ties
    for (let k = i; k <= j; k++) ranks[idx[k]] = avg;
    i = j + 1;
  }
  let pos = 0;
  let rankSum = 0;
  for (let k = 0; k < n; k++) {
    if (y[k] === 1) {
      pos++;
      rankSum += ranks[k];
    }
  }
  const neg = n - pos;
  if (pos === 0 || neg === 0) return NaN;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export interface MetricSummary {
  n: number;
  positives: number;
  brier: number;
  ece: number;
  auc: number;
  logLoss: number;
}

export function summarize(p: readonly number[], y: readonly number[]): MetricSummary {
  let positives = 0;
  for (const v of y) positives += v;
  return { n: p.length, positives, brier: brier(p, y), ece: ece(p, y), auc: auc(p, y), logLoss: logLoss(p, y) };
}

export interface VerifiedCoverage {
  /** Cells currently at P0. */
  p0Cells: number;
  /** P0 cells with at least one field report. */
  p0CellsWithReport: number;
  /** p0CellsWithReport / p0Cells (NaN when there are no P0 cells). */
  cellShare: number;
  /** Households with pSevere >= severeThreshold in P0 cells ("suspected P0 households"). */
  suspectedHouseholds: number;
  suspectedVerified: number;
  /** suspectedVerified / suspectedHouseholds (NaN when none). */
  householdShare: number;
}

/**
 * "Verified coverage": how much of what we believe is P0 has actually been
 * seen by an adjuster. `householdHex` maps householdId -> hex.
 */
export function verifiedCoverage(
  hexes: readonly HexEstimate[],
  households: readonly HouseholdEstimate[],
  householdHex: ReadonlyMap<string, string>,
  severeThreshold = 0.5,
): VerifiedCoverage {
  const p0 = new Set<string>();
  let p0CellsWithReport = 0;
  for (const h of hexes) {
    if (h.priority === 'P0') {
      p0.add(h.hex);
      if (h.counts.fieldReports > 0) p0CellsWithReport++;
    }
  }
  let suspected = 0;
  let suspectedVerified = 0;
  for (const e of households) {
    const hex = householdHex.get(e.householdId);
    if (hex === undefined) throw new Error(`verifiedCoverage: household ${e.householdId} has no hex`);
    if (!p0.has(hex)) continue;
    if (e.pSevere >= severeThreshold || e.pNeedsHelp >= severeThreshold) {
      suspected++;
      if (e.verified) suspectedVerified++;
    }
  }
  return {
    p0Cells: p0.size,
    p0CellsWithReport,
    cellShare: p0.size > 0 ? p0CellsWithReport / p0.size : NaN,
    suspectedHouseholds: suspected,
    suspectedVerified,
    householdShare: suspected > 0 ? suspectedVerified / suspected : NaN,
  };
}
