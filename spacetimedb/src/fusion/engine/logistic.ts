// COPIED from engine/src/logistic.ts by spacetimedb/scripts/sync-engine.ts. Do not edit here; edit engine/src and re-sync.
// Deterministic L2-regularised logistic regression.
//
// Training: features are standardised (mean 0, std 1) and fitted with
// Newton / IRLS steps plus a backtracking line search. The fitted weights are
// then folded back into raw feature space, so the stored model is simply
// p = sigmoid(bias + weights . x) on the raw features. No randomness, no
// dependencies; full-batch, so the same data always yields the same weights.

export interface LinearModel {
  bias: number;
  weights: number[];
}

export interface FitOptions {
  /** L2 penalty on standardised weights (the intercept is not penalised). */
  l2: number;
  maxIter: number;
  /** Stop when the largest coefficient change in one step is below this. */
  tol: number;
}

export const DEFAULT_FIT_OPTIONS: FitOptions = { l2: 1, maxIter: 50, tol: 1e-7 };

export interface FitResult {
  /** Model in raw feature space. */
  model: LinearModel;
  /** Standardisation used during training (for diagnostics). */
  mean: number[];
  std: number[];
  /** Weights in standardised space (comparable magnitudes = feature importance). */
  standardizedWeights: number[];
  iterations: number;
  converged: boolean;
  /** Penalised negative log-likelihood at the solution. */
  finalLoss: number;
}

export function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/** log(1 + exp(z)) without overflow. */
export function softplus(z: number): number {
  return z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z));
}

export function logit(model: LinearModel, x: readonly number[]): number {
  if (x.length !== model.weights.length) {
    throw new Error(`feature length ${x.length} does not match model weights ${model.weights.length}`);
  }
  let z = model.bias;
  for (let j = 0; j < x.length; j++) z += model.weights[j] * x[j];
  return z;
}

export function predictProb(model: LinearModel, x: readonly number[]): number {
  return sigmoid(logit(model, x));
}

/** Solve A x = b (A square) by Gaussian elimination with partial pivoting. Mutates copies only. */
export function solveLinear(aIn: readonly (readonly number[])[], bIn: readonly number[]): number[] {
  const n = bIn.length;
  const a = aIn.map((row) => row.slice());
  const b = bIn.slice();
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(a[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r][col]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-300) throw new Error('singular system in solveLinear');
    if (pivot !== col) {
      const tmp = a[col];
      a[col] = a[pivot];
      a[pivot] = tmp;
      const tb = b[col];
      b[col] = b[pivot];
      b[pivot] = tb;
    }
    const inv = 1 / a[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] * inv;
      if (f === 0) continue;
      const rowR = a[r];
      const rowC = a[col];
      for (let c = col; c < n; c++) rowR[c] -= f * rowC[c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= a[r][c] * x[c];
    x[r] = s / a[r][r];
  }
  return x;
}

function penalisedLoss(xs: number[][], y: readonly number[], w: readonly number[], l2: number): number {
  // w[0] is the intercept; xs rows already carry a leading 1.
  let loss = 0;
  for (let i = 0; i < xs.length; i++) {
    const row = xs[i];
    let z = 0;
    for (let j = 0; j < row.length; j++) z += w[j] * row[j];
    loss += softplus(z) - y[i] * z;
  }
  let pen = 0;
  for (let j = 1; j < w.length; j++) pen += w[j] * w[j];
  return loss + 0.5 * l2 * pen;
}

/**
 * Fit a logistic regression on rows X (n x d) with labels y in {0,1}.
 * Throws if y is constant (no information to fit) or shapes disagree.
 */
export function fitLogistic(X: readonly (readonly number[])[], y: readonly number[], opts: FitOptions = DEFAULT_FIT_OPTIONS): FitResult {
  const n = X.length;
  if (n === 0) throw new Error('fitLogistic: no rows');
  if (y.length !== n) throw new Error('fitLogistic: X and y length differ');
  const d = X[0].length;
  for (let i = 0; i < n; i++) {
    if (X[i].length !== d) throw new Error(`fitLogistic: row ${i} has ${X[i].length} features, expected ${d}`);
    if (y[i] !== 0 && y[i] !== 1) throw new Error(`fitLogistic: label ${y[i]} at row ${i} is not 0/1`);
  }
  let positives = 0;
  for (let i = 0; i < n; i++) positives += y[i];
  if (positives === 0 || positives === n) {
    throw new Error(`fitLogistic: labels are constant (${positives}/${n} positive); nothing to fit`);
  }

  // Standardise.
  const mean = new Array<number>(d).fill(0);
  const std = new Array<number>(d).fill(0);
  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += X[i][j];
    mean[j] = s / n;
  }
  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const v = X[i][j] - mean[j];
      s += v * v;
    }
    const sd = Math.sqrt(s / n);
    std[j] = sd > 1e-12 ? sd : 1; // constant feature: centred to 0, weight stays 0
  }
  const xs: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(d + 1);
    row[0] = 1;
    for (let j = 0; j < d; j++) row[j + 1] = (X[i][j] - mean[j]) / std[j];
    xs[i] = row;
  }

  const k = d + 1;
  let w = new Array<number>(k).fill(0);
  // Start the intercept at the empirical log-odds.
  w[0] = Math.log(positives / (n - positives));
  let loss = penalisedLoss(xs, y, w, opts.l2);
  let converged = false;
  let iter = 0;

  for (iter = 1; iter <= opts.maxIter; iter++) {
    // Gradient and Hessian of the penalised loss.
    const g = new Array<number>(k).fill(0);
    const H: number[][] = [];
    for (let a = 0; a < k; a++) H.push(new Array<number>(k).fill(0));
    for (let i = 0; i < n; i++) {
      const row = xs[i];
      let z = 0;
      for (let j = 0; j < k; j++) z += w[j] * row[j];
      const p = sigmoid(z);
      const r = p - y[i];
      const wgt = p * (1 - p);
      for (let a = 0; a < k; a++) {
        g[a] += r * row[a];
        const ra = wgt * row[a];
        const Ha = H[a];
        for (let b = a; b < k; b++) Ha[b] += ra * row[b];
      }
    }
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < a; b++) H[a][b] = H[b][a];
    }
    for (let j = 1; j < k; j++) {
      g[j] += opts.l2 * w[j];
      H[j][j] += opts.l2;
    }
    for (let j = 0; j < k; j++) H[j][j] += 1e-9; // numerical safety

    const step = solveLinear(H, g); // Newton direction is -step
    let alpha = 1;
    let next = w;
    let nextLoss = loss;
    let accepted = false;
    for (let ls = 0; ls < 30; ls++) {
      const cand = w.map((v, j) => v - alpha * step[j]);
      const candLoss = penalisedLoss(xs, y, cand, opts.l2);
      if (candLoss <= loss + 1e-12) {
        next = cand;
        nextLoss = candLoss;
        accepted = true;
        break;
      }
      alpha *= 0.5;
    }
    if (!accepted) {
      converged = true; // cannot decrease further: at a (numerical) optimum
      break;
    }
    let maxDelta = 0;
    for (let j = 0; j < k; j++) maxDelta = Math.max(maxDelta, Math.abs(next[j] - w[j]));
    w = next;
    loss = nextLoss;
    if (maxDelta < opts.tol) {
      converged = true;
      break;
    }
  }

  // Fold standardisation into raw-space coefficients.
  const weights = new Array<number>(d);
  let bias = w[0];
  for (let j = 0; j < d; j++) {
    weights[j] = w[j + 1] / std[j];
    bias -= (w[j + 1] * mean[j]) / std[j];
  }
  return {
    model: { bias, weights },
    mean,
    std,
    standardizedWeights: w.slice(1),
    iterations: Math.min(iter, opts.maxIter),
    converged,
    finalLoss: loss,
  };
}
