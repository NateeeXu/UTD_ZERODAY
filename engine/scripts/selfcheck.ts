// Engine self-checks (run with `npm run check`). Exits non-zero on failure.
//  1. determinism          same inputs -> identical estimates
//  2. no leakage           future events never change estimates at t
//  3. local update         applyFieldReport + reestimateCell == full recompute
//  4. trainer              fitLogistic recovers known coefficients
//  5. metrics              Brier / AUC / ECE sanity
//  6. trust loop           one report never moves trust; holdout never counts; steps are capped
//  7. silence guard        high hazard + outage + no replies is never "P2 + verified"
//  8. validation           malformed ModelParams are rejected

import type { EventBundle, ModelParams, SimEvent, World } from '../../shared/types.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { FEATURE_NAMES, buildSnapshot, householdFeatures } from '../src/features.ts';
import { estimateAll, validateParams } from '../src/infer.ts';
import { fitLogistic, predictProb } from '../src/logistic.ts';
import { auc, brier, ece } from '../src/metrics.ts';
import { initLearningState, localUpdate, recordFieldReport } from '../src/learning.ts';
import type { FieldReportEvent, FieldReportObservation } from '../src/learning.ts';
import { recommendInspections } from '../src/active.ts';
import { mulberry32, randNormal } from '../src/rng.ts';
import { fixtureSet } from './fixturegen.ts';

const cfg = DEFAULT_CONFIG;
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failures++;
}

function dummyParams(bias = -2, help = -3): ModelParams {
  return {
    version: 0,
    features: [...FEATURE_NAMES],
    severe: { bias, weights: FEATURE_NAMES.map(() => 0) },
    needsHelp: { bias: help, weights: FEATURE_NAMES.map(() => 0) },
    sourceTrust: { hazard: 0.8, sms: 0.85, claims: 0.9 },
    calibration: { brier: NaN, ece: NaN, heldOutEvent: 'none' },
    trainedOn: [],
  };
}

// Quick in-memory training on fixture data so the checks use a real model.
const { backtests, live } = fixtureSet(300, 3);
function trainOn(bundles: EventBundle[]): ModelParams {
  const X: number[][] = [];
  const yS: number[] = [];
  const yH: number[] = [];
  for (const b of bundles) {
    const truth = new Map(b.truth.map((r) => [r.householdId, r]));
    for (const t of [360, 1440]) {
      const snap = buildSnapshot(b.world, b.events, t, cfg);
      for (const h of b.world.households) {
        if (h.holdout) continue;
        const tr = truth.get(h.id)!;
        X.push(householdFeatures(h, snap, cfg));
        yS.push(tr.damage >= 2 ? 1 : 0);
        yH.push(tr.safety === 'needs_help' ? 1 : 0);
      }
    }
  }
  const s = fitLogistic(X, yS, { l2: 1, maxIter: 50, tol: 1e-7 });
  const hlp = fitLogistic(X, yH, { l2: 1, maxIter: 50, tol: 1e-7 });
  return { ...dummyParams(), severe: s.model, needsHelp: hlp.model, trainedOn: bundles.map((b) => b.world.eventId) };
}
const params = trainOn(backtests);
const world: World = live.world;
const events: SimEvent[] = live.events;

// 1. determinism
{
  const a = JSON.stringify(estimateAll(world, events, 720, params, cfg).hexes);
  const b = JSON.stringify(estimateAll(world, events, 720, params, cfg).hexes);
  check('determinism: identical output for identical input', a === b);
}

// 2. no leakage
{
  const t = 720;
  const onlyPast = events.filter((e) => e.t <= t);
  const future: SimEvent[] = [
    ...events,
    { kind: 'sms_reply', t: t + 1, householdId: world.households[0].id, safety: 'needs_help', damage: 3 },
    { kind: 'field_report', t: t + 5, householdId: world.households[1].id, adjusterId: 'x', safety: 'needs_help', damage: 3 },
  ];
  const a = JSON.stringify(estimateAll(world, onlyPast, t, params, cfg).households);
  const b = JSON.stringify(estimateAll(world, future, t, params, cfg).households);
  const c = JSON.stringify(estimateAll(world, events, t, params, cfg).households);
  check('no leakage: events after t never change estimates at t', a === b && b === c);
}

// 3. local update equals full recompute
{
  const t = 1440;
  const base = estimateAll(world, events, t, params, cfg);
  const picks = recommendInspections(world, base.households, base.hexes, 5, cfg);
  let snap = base.snapshot;
  let hh = base.households;
  let hx = base.hexes;
  const evs = events.slice();
  const truth = new Map(live.truth.map((r) => [r.householdId, r]));
  for (const p of picks) {
    const tr = truth.get(p.householdId)!;
    const report: FieldReportEvent = { kind: 'field_report', t, householdId: p.householdId, adjusterId: 'adj', safety: tr.safety, damage: tr.damage };
    evs.push(report);
    const lu = localUpdate(snap, report, base.models, cfg, hh, hx);
    snap = lu.snapshot;
    hh = lu.households;
    hx = lu.hexes;
  }
  const full = estimateAll(world, evs, t, params, cfg);
  let maxDiff = 0;
  for (let i = 0; i < hh.length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(hh[i].pSevere - full.households[i].pSevere), Math.abs(hh[i].uncertainty - full.households[i].uncertainty));
  }
  let sameTiers = true;
  for (let i = 0; i < hx.length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(hx[i].confidence - full.hexes[i].confidence), Math.abs(hx[i].silence - full.hexes[i].silence));
    if (hx[i].priority !== full.hexes[i].priority || hx[i].verification !== full.hexes[i].verification) sameTiers = false;
  }
  check('local update == full recompute', maxDiff < 1e-12 && sameTiers, `max diff ${maxDiff.toExponential(1)}`);
  check('verified household takes reported values', hh.find((e) => e.householdId === picks[0].householdId)!.verified);
  check('active inspection never recommends verified households', recommendInspections(world, hh, hx, 50, cfg).every((c) => !picks.some((p) => p.householdId === c.householdId)));
}

// 4. trainer recovers known coefficients
{
  const rng = mulberry32(7);
  const trueW = [1.5, -2, 0.5];
  const trueB = -0.5;
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < 20000; i++) {
    const x = [randNormal(rng), randNormal(rng) * 2 + 1, rng.next()];
    const z = trueB + x[0] * trueW[0] + x[1] * trueW[1] + x[2] * trueW[2];
    X.push(x);
    y.push(rng.next() < 1 / (1 + Math.exp(-z)) ? 1 : 0);
  }
  const fit = fitLogistic(X, y, { l2: 1e-3, maxIter: 50, tol: 1e-9 });
  const err = Math.max(...trueW.map((w, j) => Math.abs(w - fit.model.weights[j])), Math.abs(trueB - fit.model.bias));
  check('fitLogistic recovers coefficients', err < 0.12 && fit.converged, `max |err| ${err.toFixed(3)}, ${fit.iterations} iters`);
  const p = X.map((x) => predictProb(fit.model, x));
  check('fitLogistic predictions are in (0,1)', p.every((v) => v > 0 && v < 1));
  let threw = false;
  try {
    fitLogistic([[1], [2]], [1, 1]);
  } catch {
    threw = true;
  }
  check('fitLogistic rejects constant labels', threw);
}

// 5. metrics
{
  check('brier perfect = 0', brier([1, 0, 1], [1, 0, 1]) === 0);
  check('brier worst = 1', brier([1, 0], [0, 1]) === 1);
  check('auc perfect ranking = 1', auc([0.1, 0.3, 0.4, 0.8], [0, 0, 1, 1]) === 1);
  check('auc counts pair-wise order (3 of 4 pairs = 0.75)', Math.abs(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]) - 0.75) < 1e-12);
  check('auc random-ish = 0.5 with ties', Math.abs(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]) - 0.5) < 1e-12);
  check('auc undefined for one class', Number.isNaN(auc([0.2, 0.3], [1, 1])));
  check('ece of perfectly calibrated bins ~ 0', ece([0.25, 0.25, 0.25, 0.25], [1, 0, 0, 0]) < 1e-12);
}

// 6. trust loop
{
  let st = initLearningState(params);
  const mk = (i: number, holdout: boolean, outcome: 0 | 1): FieldReportObservation => ({
    householdId: `h${i}`,
    hex: 'x',
    t: 0,
    holdout,
    outcomeSevere: outcome,
    opinions: { hazard: 0.9, sms: 0.0, claims: null },
  });
  const t0 = { ...st.trust };
  st = recordFieldReport(st, mk(0, false, 1), cfg);
  check('one report does not move trust', JSON.stringify(st.trust) === JSON.stringify(t0));
  for (let i = 1; i < 50; i++) st = recordFieldReport(st, mk(i, true, 0), cfg);
  check('holdout reports never count toward a batch', st.pending.length === 1 && st.holdoutReports === 49 && JSON.stringify(st.trust) === JSON.stringify(t0));
  for (let i = 50; i < 50 + cfg.trust.batchSize - 1; i++) st = recordFieldReport(st, mk(i, false, 1), cfg);
  const moved = st.updates.length === 1;
  const dz = Math.abs(st.trust.hazard - t0.hazard);
  const ds = Math.abs(st.trust.sms - t0.sms);
  check('trust updates exactly once after a full batch', moved && st.pending.length === 0);
  check('trust step is capped by learningRate', dz <= cfg.trust.learningRate + 1e-12 && ds <= cfg.trust.learningRate + 1e-12, `d hazard ${dz.toFixed(3)}, d sms ${ds.toFixed(3)}`);
  check('hazard (always right in batch) goes up, sms (always wrong) goes down', st.trust.hazard > t0.hazard && st.trust.sms < t0.sms);
  check('claims (no opinions) unchanged', st.trust.claims === t0.claims);
}

// 7. silence guard: one high-hazard, fully-outaged cell, SMS sent, nobody replied; plus a quiet control cell.
{
  const hexes = [
    { hex: 'silent', lat: 0, lng: 0, windMph: 130, floodDepthFt: 5, towerOutagePct: 100, analystZone: 0 as const },
    { hex: 'calm', lat: 0, lng: 0.1, windMph: 45, floodDepthFt: 0, towerOutagePct: 0, analystZone: 0 as const },
  ];
  const hh = [];
  const evs: SimEvent[] = [];
  for (let i = 0; i < 20; i++) {
    for (const hex of ['silent', 'calm']) {
      const id = `${hex}-${i}`;
      hh.push({ id, hex, lat: 0, lng: 0, age65: false, livesAlone: false, medicalDevice: false, windCovered: true, floodPolicy: false, earthquakeEndorsement: false, phoneOnFile: true, holdout: false });
      evs.push({ kind: 'sms_sent', t: 60, householdId: id });
      if (hex === 'calm' && i % 2 === 0) evs.push({ kind: 'sms_reply', t: 200, householdId: id, safety: 'safe', damage: 0 });
    }
  }
  const w: World = { eventId: 'guard', name: 'guard', landfallIso: '2026-01-01T00:00:00Z', center: { lat: 0, lng: 0 }, hexes, households: hh };
  // A deliberately blind model (all weights 0, p = 0.12) so only the rule can catch it.
  const est = estimateAll(w, evs, 720, dummyParams(-2, -4), cfg);
  const silent = est.hexes.find((x) => x.hex === 'silent')!;
  const calm = est.hexes.find((x) => x.hex === 'calm')!;
  check('silent high-hazard cell is needs_verification', silent.verification === 'needs_verification', `silence ${silent.silence.toFixed(2)}, conf ${silent.confidence.toFixed(2)}`);
  check('silent high-hazard cell is not P2', silent.priority !== 'P2', silent.priority);
  check('calm cell with replies is verified P2', calm.verification === 'verified' && calm.priority === 'P2', `silence ${calm.silence.toFixed(2)}, conf ${calm.confidence.toFixed(2)}`);
}

// 8. validation
{
  let threw = 0;
  const bad1 = dummyParams();
  bad1.severe.weights = bad1.severe.weights.slice(1);
  try {
    validateParams(bad1);
  } catch {
    threw++;
  }
  const bad2 = dummyParams();
  bad2.features[0] = 'notAFeature';
  try {
    validateParams(bad2);
  } catch {
    threw++;
  }
  check('validateParams rejects malformed params', threw === 2);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
