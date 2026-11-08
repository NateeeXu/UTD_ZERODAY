// COPIED from engine/src/interval.ts by spacetimedb/scripts/sync-engine.ts. Do not edit here; edit engine/src and re-sync.
// 90% interval for the number of severely damaged households in one cell.
// Shared by the live engine (infer.ts -> HexEstimate.severeLo/severeHi) and the backtest calibration
// (scripts/calibrate.ts: estimates the overdispersion and checks the empirical coverage), so both
// always use the same formula.
//
// The unverified households' severe count S is a sum of independent Bernoulli(p_i): its exact
// distribution is Poisson-binomial (dynamic program, cells have tens of households). The interval is
// its equal-tailed 5 % / 95 % quantiles (coverage >= 90 % by construction when the p_i are calibrated),
// widened for the shared cell-level error (e.g. the hazard estimate is off):
//   shared variance = tau2 * mu^2 * shrink / (shrink + k)   (shrinks as k field reports in the cell correct it)
//   widening factor  = sqrt(1 + shared / sum p(1-p)), applied to each side's distance from the mean
// Verified households are known: they shift the interval and contribute no variance.
// Measured on held-out backtests: 94-97 % coverage, 25-40 % narrower than a normal approximation.

export const CELL_INTERVAL_Z = 1.645; // two-sided 90 %

export interface CellIntervalInput {
  /** pSevere of every unverified household in the cell */
  pUnverified: readonly number[];
  /** verified households found severe / verified households in total */
  verifiedSevere: number;
  verifiedTotal: number;
  /** households in the cell */
  n: number;
  /** cell-level overdispersion (ModelParams.cellOverdispersion) */
  tau2: number;
  /** prior strength of the shared error, in field reports (cfg.neighbourUpdate.shrinkageCount) */
  shrink: number;
  /** field reports in the cell */
  k: number;
  /** probability in each tail (ModelParams.cellIntervalTail; default 0.05 = equal-tailed 90 %) */
  tail?: number;
}

export interface CellInterval {
  mean: number;
  lo: number;
  hi: number;
  variance: number;
  /** sum of p and sum of p(1-p) over unverified households (used to estimate tau2) */
  mu: number;
  binomVar: number;
}

export const CELL_INTERVAL_TAIL = 0.05; // each tail (default; the model stores a backtest-calibrated value)

/** Standard normal quantile (Acklam's rational approximation, |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = Math.min(1 - 1e-12, Math.max(1e-12, p));
  if (q < 0.02425) {
    const r = Math.sqrt(-2 * Math.log(q));
    return (((((c[0]! * r + c[1]!) * r + c[2]!) * r + c[3]!) * r + c[4]!) * r + c[5]!) / ((((d[0]! * r + d[1]!) * r + d[2]!) * r + d[3]!) * r + 1);
  }
  if (q > 1 - 0.02425) return -normalQuantile(1 - q);
  const r = q - 0.5;
  const s = r * r;
  return ((((((a[0]! * s + a[1]!) * s + a[2]!) * s + a[3]!) * s + a[4]!) * s + a[5]!) * r) / (((((b[0]! * s + b[1]!) * s + b[2]!) * s + b[3]!) * s + b[4]!) * s + 1);
}

/** Equal-tailed quantiles of a Poisson-binomial sum (smallest s with CDF(s) >= tail / >= 1 - tail). */
export function poissonBinomialQuantiles(ps: readonly number[], tail = CELL_INTERVAL_TAIL): { lo: number; hi: number } {
  const n = ps.length;
  const f = new Float64Array(n + 1);
  f[0] = 1;
  for (let i = 0; i < n; i++) {
    const p = Math.min(1, Math.max(0, ps[i]!));
    for (let s = i + 1; s >= 1; s--) f[s] = f[s]! * (1 - p) + f[s - 1]! * p;
    f[0] = f[0]! * (1 - p);
  }
  let cdf = 0;
  let lo = -1;
  let hi = n;
  for (let s = 0; s <= n; s++) {
    cdf += f[s]!;
    if (lo < 0 && cdf >= tail - 1e-12) lo = s;
    if (cdf >= 1 - tail - 1e-12) {
      hi = s;
      break;
    }
  }
  return { lo: Math.max(0, lo), hi };
}

export function cellSevereInterval(x: CellIntervalInput): CellInterval {
  let mu = 0;
  let binomVar = 0;
  for (const p of x.pUnverified) {
    mu += p;
    binomVar += p * (1 - p);
  }
  const shared = x.tau2 * mu * mu * (x.shrink / (x.shrink + Math.max(0, x.k)));
  const variance = binomVar + shared;
  const mean = x.verifiedSevere + mu;
  const nU = x.pUnverified.length;
  let loS: number;
  let hiS: number;
  if (binomVar > 0) {
    const q = poissonBinomialQuantiles(x.pUnverified, x.tail ?? CELL_INTERVAL_TAIL);
    const w = Math.sqrt(1 + shared / binomVar);
    // Widen each side by its distance from the mean times (w - 1), rounded to the nearest household, so a
    // negligible shared error leaves the exact quantiles alone (no outward rounding).
    loS = q.lo - Math.round(Math.max(0, mu - q.lo) * (w - 1));
    hiS = q.hi + Math.round(Math.max(0, q.hi - mu) * (w - 1));
  } else {
    // every p is 0 or 1: only the shared error is left (normal approximation)
    const sd = Math.sqrt(shared);
    const z = normalQuantile(1 - (x.tail ?? CELL_INTERVAL_TAIL));
    loS = Math.round(mu - z * sd);
    hiS = Math.round(mu + z * sd);
  }
  loS = Math.max(0, Math.min(nU, loS));
  hiS = Math.max(loS, Math.min(nU, hiS));
  return { mean, lo: x.verifiedSevere + loS, hi: x.verifiedSevere + hiS, variance, mu, binomVar };
}

/**
 * Method-of-moments estimate of tau2 from held-out cells with no field reports:
 * E[(y - mu)^2] = binomVar + tau2 * mu^2  =>  tau2 = sum((y - mu)^2 - binomVar) / sum(mu^2), floored at 0.
 */
export function estimateOverdispersion(cells: readonly { y: number; mu: number; binomVar: number }[]): number {
  let num = 0;
  let den = 0;
  for (const c of cells) {
    num += (c.y - c.mu) ** 2 - c.binomVar;
    den += c.mu * c.mu;
  }
  return den > 0 ? Math.max(0, num / den) : 0;
}
