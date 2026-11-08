// Engine self-checks (run with `npm run check`). Exits non-zero on failure.
//  1. determinism          same inputs -> identical estimates
//  2. no leakage           future events never change estimates at t
//  3. local update         applyFieldReport + reestimateCell == full recompute
//  4. trainer              fitLogistic recovers known coefficients (incl. column selection)
//  5. metrics              Brier / AUC / ECE sanity
//  6. trust loop           one report never moves trust; holdout never counts; steps are capped
//  7. silence guard        high hazard + outage + no replies is "suspected P0" + needs_verification
//  8. validation           malformed ModelParams are rejected
//  9. hazardIndex          used when present, v1 wind/flood formula otherwise
// 10. coverage             uninsured quake households do not make a cell look silent on the claims channel
// 11. limited English      lowers the expected-reply baseline (and renters the claims baseline)
// 12. silence cause        outage / away / trapped / unknown
// 13. event time           daytime and school-hours flags from eventLocalHour or landfallIso
// 14. students note        school-hours event + high hazard + k12Enrollment -> reason mentions students

import type { EventBundle, Facility, HexCell, Household, ModelParams, SimEvent, World } from '../../shared/types.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { FEATURE_NAMES, buildSnapshot, fillExpected, hazardScore, householdFeatures, worldContext } from '../src/features.ts';
import type { CellAggregate } from '../src/features.ts';
import { cellSilence, estimateAll, validateParams } from '../src/infer.ts';
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

// ---------- tiny world builder for rule tests ----------
interface CellSpec {
  hex: string;
  n: number;
  cell?: Partial<HexCell>;
  household?: (i: number) => Partial<Household>;
  /** Return events for household i (id given). */
  events?: (i: number, id: string, h: Household) => SimEvent[];
}
function mkWorld(specs: CellSpec[], world: Partial<World> = {}): { world: World; events: SimEvent[] } {
  const hexes: HexCell[] = [];
  const households: Household[] = [];
  const events: SimEvent[] = [];
  specs.forEach((sp, ci) => {
    hexes.push({ hex: sp.hex, lat: 0, lng: ci * 0.1, windMph: 0, floodDepthFt: 0, towerOutagePct: 0, analystZone: 0, ...sp.cell });
    for (let i = 0; i < sp.n; i++) {
      const id = `${sp.hex}-${i}`;
      const h: Household = {
        id,
        hex: sp.hex,
        lat: 0,
        lng: ci * 0.1,
        age65: false,
        livesAlone: false,
        medicalDevice: false,
        windCovered: true,
        floodPolicy: false,
        earthquakeEndorsement: false,
        phoneOnFile: true,
        holdout: false,
        ...(sp.household ? sp.household(i) : {}),
      };
      households.push(h);
      if (sp.events) events.push(...sp.events(i, id, h));
    }
  });
  events.sort((a, b) => a.t - b.t);
  return {
    world: { eventId: 'guard', name: 'guard', landfallIso: '2026-01-14T06:00:00.000Z', center: { lat: 0, lng: 0 }, hexes, households, ...world },
    events,
  };
}
const sent = (id: string): SimEvent => ({ kind: 'sms_sent', t: 60, householdId: id });
const reply = (id: string, damage: 0 | 1 | 2 | 3 = 0): SimEvent => ({ kind: 'sms_reply', t: 200, householdId: id, safety: 'safe', damage });
const claim = (id: string): SimEvent => ({ kind: 'claim', t: 500, householdId: id, peril: 'earthquake', reportedDamage: 2 });
/** Reference cells with low hazard, full replies at 80%, no outage: they define the world's reply baseline. */
const refCells = (count: number, rate = 0.8): CellSpec[] =>
  Array.from({ length: count }, (_, k) => ({
    hex: `ref${k}`,
    n: 20,
    cell: { hazardIndex: 0.05 },
    events: (i, id) => (i < Math.round(20 * rate) ? [sent(id), reply(id)] : [sent(id)]),
  }));

// Quick in-memory training on fixture data so the generic checks use a real model.
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
    maxDiff = Math.max(maxDiff, Math.abs(hh[i].pSevere - full.households[i].pSevere), Math.abs(hh[i].uncertainty - full.households[i].uncertainty), Math.abs((hh[i].inspectScore ?? 0) - (full.households[i].inspectScore ?? 0)));
  }
  let same = true;
  for (let i = 0; i < hx.length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(hx[i].confidence - full.hexes[i].confidence), Math.abs(hx[i].silence - full.hexes[i].silence));
    if (hx[i].priority !== full.hexes[i].priority || hx[i].verification !== full.hexes[i].verification || hx[i].reason !== full.hexes[i].reason) same = false;
  }
  check('local update == full recompute (probabilities, inspect scores, tiers, reasons)', maxDiff < 1e-12 && same, `max diff ${maxDiff.toExponential(1)}`);
  check('verified household takes reported values', hh.find((e) => e.householdId === picks[0].householdId)!.verified);
  check('active inspection never recommends verified households', recommendInspections(world, hh, hx, 50, cfg).every((c) => !picks.some((p) => p.householdId === c.householdId)));
  check('inspectScore is filled and in [0,1]', full.households.every((e) => typeof e.inspectScore === 'number' && e.inspectScore >= 0 && e.inspectScore <= 1));
  check('ranking by inspectScore matches recommendInspections', recommendInspections(world, full.households, full.hexes, 1, cfg)[0].score === Math.max(...full.households.map((e) => e.inspectScore ?? 0)));
}

// 4. trainer recovers known coefficients
{
  const rng = mulberry32(7);
  const trueW = [1.5, -2, 0.5];
  const trueB = -0.5;
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < 20000; i++) {
    const x = [randNormal(rng), randNormal(rng) * 2 + 1, rng.next(), randNormal(rng)]; // 4th column is noise
    const z = trueB + x[0] * trueW[0] + x[1] * trueW[1] + x[2] * trueW[2];
    X.push(x);
    y.push(rng.next() < 1 / (1 + Math.exp(-z)) ? 1 : 0);
  }
  const fit = fitLogistic(X, y, { l2: 1e-3, maxIter: 50, tol: 1e-9 }, [0, 1, 2]);
  const err = Math.max(...trueW.map((w, j) => Math.abs(w - fit.model.weights[j])), Math.abs(trueB - fit.model.bias));
  check('fitLogistic recovers coefficients (with column selection)', err < 0.12 && fit.converged && fit.model.weights.length === 3, `max |err| ${err.toFixed(3)}, ${fit.iterations} iters`);
  const p = X.map((x) => predictProb(fit.model, x.slice(0, 3)));
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
  const dz = Math.abs(st.trust.hazard - t0.hazard);
  const ds = Math.abs(st.trust.sms - t0.sms);
  check('trust updates exactly once after a full batch', st.updates.length === 1 && st.pending.length === 0);
  check('trust step is capped by learningRate', dz <= cfg.trust.learningRate + 1e-12 && ds <= cfg.trust.learningRate + 1e-12, `d hazard ${dz.toFixed(3)}, d sms ${ds.toFixed(3)}`);
  check('hazard (always right in batch) goes up, sms (always wrong) goes down', st.trust.hazard > t0.hazard && st.trust.sms < t0.sms);
  check('claims (no opinions) unchanged', st.trust.claims === t0.claims);
}

// 7. silence guard: a high-hazard, fully-outaged cell with SMS sent and nobody replying.
{
  const { world: w, events: evs } = mkWorld([
    { hex: 'silent', n: 20, cell: { windMph: 130, floodDepthFt: 5, towerOutagePct: 100, analystZone: 0 }, events: (_, id) => [sent(id)] },
    { hex: 'calm', n: 20, cell: { windMph: 45 }, events: (i, id) => (i % 2 === 0 ? [sent(id), reply(id)] : [sent(id)]) },
  ]);
  // A deliberately blind model (all weights 0, p = 0.12) so only the rule can catch it.
  const est = estimateAll(w, evs, 720, dummyParams(-2, -4), cfg);
  const silent = est.hexes.find((x) => x.hex === 'silent')!;
  const calm = est.hexes.find((x) => x.hex === 'calm')!;
  check('silent high-hazard cell is needs_verification', silent.verification === 'needs_verification', `silence ${silent.silence.toFixed(2)}, conf ${silent.confidence.toFixed(2)}`);
  check('silent high-hazard cell is floored at P0 ("suspected P0")', silent.priority === 'P0' && cfg.thresholds.silentHighHazardFloor === 'P0' && (silent.reason ?? '').startsWith('suspected P0'), silent.reason ?? '');
  check('silence cause of the outaged cell is outage', silent.silenceCause === 'outage');
  check('calm cell with replies is verified P2', calm.verification === 'verified' && calm.priority === 'P2', `silence ${calm.silence.toFixed(2)}, conf ${calm.confidence.toFixed(2)}`);
  check('hazard is exposed on the hex estimate', silent.hazard !== undefined && silent.hazard >= cfg.thresholds.highHazard && calm.hazard !== undefined && calm.hazard < 0.1);
  const off = { ...cfg, thresholds: { ...cfg.thresholds, silentHighHazardFloor: 'P1' as const } };
  const est2 = estimateAll(w, evs, 720, dummyParams(-2, -4), off);
  check('floor is configurable (P1 when asked)', est2.hexes.find((x) => x.hex === 'silent')!.priority === 'P1');
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

// 9. hazardIndex fallback
{
  const withIdx: HexCell = { hex: 'a', lat: 0, lng: 0, windMph: 0, floodDepthFt: 0, towerOutagePct: 0, analystZone: 0, hazardIndex: 0.9 };
  const without: HexCell = { hex: 'b', lat: 0, lng: 0, windMph: 130, floodDepthFt: 0, towerOutagePct: 0, analystZone: 2 };
  check('hazardIndex is used when present (wind 0 still hazard 0.9)', hazardScore(withIdx, cfg) === 0.9);
  check('v1 wind/flood formula when hazardIndex is absent', Math.abs(hazardScore(without, cfg) - (cfg.hazard.intensityWeight * 1 + cfg.hazard.zoneWeight * 1)) < 1e-12);
}

// 10. coverage-conditioned claims baseline (earthquake)
{
  const quake = { hazardType: 'earthquake' as const, region: 'ca-test' };
  const { world: w, events: evs } = mkWorld(
    [
      ...refCells(3),
      // insured cell: all endorsed, half replied, zero claims
      { hex: 'ins', n: 20, cell: { hazardIndex: 0.8 }, household: () => ({ earthquakeEndorsement: true }), events: (i, id) => (i < 10 ? [sent(id), reply(id, 2)] : [sent(id)]) },
      // uninsured cell: nobody endorsed, same replies, zero claims
      { hex: 'unins', n: 20, cell: { hazardIndex: 0.8 }, household: () => ({ earthquakeEndorsement: false }), events: (i, id) => (i < 10 ? [sent(id), reply(id, 2)] : [sent(id)]) },
      // a claim-rich insured cell so the world has a claims rate
      { hex: 'claimy', n: 20, cell: { hazardIndex: 0.8 }, household: () => ({ earthquakeEndorsement: true }), events: (i, id) => (i < 10 ? [sent(id), reply(id, 2), claim(id)] : [sent(id), claim(id)]) },
    ],
    quake,
  );
  const snap = buildSnapshot(w, evs, 720, cfg);
  const ins = snap.cells.get('ins')!;
  const unins = snap.cells.get('unins')!;
  check('claims rate per exposure is positive in the test world', snap.refs.claimRatePerExposure > 0);
  check('uninsured cell expects ~uninsuredClaimFactor x the claims of an insured one', Math.abs(unins.expectedClaims / ins.expectedClaims - cfg.coverage.uninsuredClaimFactor) < 1e-9, `${unins.expectedClaims.toFixed(2)} vs ${ins.expectedClaims.toFixed(2)}`);
  check('uninsured quake cell is not more silent than the insured one', cellSilence(unins, cfg) <= cellSilence(ins, cfg) + 1e-12, `${cellSilence(unins, cfg).toFixed(3)} vs ${cellSilence(ins, cfg).toFixed(3)}`);
  // renters: same hazard and coverage but far fewer claims -> renter factor < 1
  const { world: w2, events: e2 } = mkWorld(
    [
      ...refCells(2),
      { hex: 'owners', n: 40, cell: { hazardIndex: 0.8 }, household: () => ({ earthquakeEndorsement: true, policyType: 'homeowners' }), events: (i, id) => (i < 20 ? [sent(id), claim(id)] : [sent(id)]) },
      { hex: 'renters', n: 40, cell: { hazardIndex: 0.8 }, household: () => ({ earthquakeEndorsement: true, policyType: 'renters' }), events: (i, id) => (i < 2 ? [sent(id), claim(id)] : [sent(id)]) },
    ],
    quake,
  );
  const snap2 = buildSnapshot(w2, e2, 720, cfg);
  check('renter claim factor < 1 when renters file far fewer claims', snap2.refs.renterClaimFactor < 0.6, `factor ${snap2.refs.renterClaimFactor.toFixed(2)}`);
}

// 11. limited English lowers the expected-reply baseline
{
  const leCell = (k: number): CellSpec => ({
    hex: `le${k}`,
    n: 20,
    cell: { hazardIndex: 0.9 },
    household: () => ({ limitedEnglish: true, primaryLanguage: 'es' }),
    events: (i, id) => (i < 8 ? [sent(id), reply(id, 2)] : [sent(id)]), // 40% reply vs 80% baseline
  });
  const { world: w, events: evs } = mkWorld([...refCells(3), leCell(0), leCell(1), leCell(2), leCell(3), leCell(4)]);
  const snap = buildSnapshot(w, evs, 720, cfg);
  const agg = snap.cells.get('le0')!;
  const naive: CellAggregate = { ...agg };
  fillExpected(naive, { ...snap.refs, limitedEnglishReplyFactor: 1 });
  check('limited-English reply factor is learned from the data (< 0.8)', snap.refs.limitedEnglishReplyFactor < 0.8, `factor ${snap.refs.limitedEnglishReplyFactor.toFixed(2)}`);
  check('conditioning lowers expected replies and silence for limited-English cells', agg.expectedReplies < naive.expectedReplies && cellSilence(agg, cfg) < cellSilence(naive, cfg), `silence ${cellSilence(agg, cfg).toFixed(2)} vs naive ${cellSilence(naive, cfg).toFixed(2)}`);
}

// 12. silence cause: away (daytime quake) and trapped (CMIST), plus unknown
{
  const daytimeQuake = { hazardType: 'earthquake' as const, region: 'ca-test', eventLocalHour: 12, eventWeekday: true };
  const nightQuake = { hazardType: 'earthquake' as const, region: 'ca-test', eventLocalHour: 3, eventWeekday: true };
  // half away: 8/10 at-home replied, 1/10 away replied
  const awaySpec: CellSpec = {
    hex: 'awaycell',
    n: 20,
    cell: { hazardIndex: 0.9 },
    household: (i) => ({ awayDaytime: i < 10 }),
    events: (i, id) => ((i < 10 && i < 1) || (i >= 10 && i < 18) ? [sent(id), reply(id)] : [sent(id)]),
  };
  const day = estimateAll(mkWorld([...refCells(3), awaySpec], daytimeQuake).world, mkWorld([...refCells(3), awaySpec], daytimeQuake).events, 720, dummyParams(), cfg);
  const dayCell = day.hexes.find((x) => x.hex === 'awaycell')!;
  check('silence cause is away for a daytime quake when away households dominate the silent ones', dayCell.silenceCause === 'away', `silence ${dayCell.silence.toFixed(2)}, cause ${dayCell.silenceCause}`);
  const night = estimateAll(mkWorld([...refCells(3), awaySpec], nightQuake).world, mkWorld([...refCells(3), awaySpec], nightQuake).events, 720, dummyParams(), cfg);
  const nightCell = night.hexes.find((x) => x.hex === 'awaycell')!;
  check('the same cell at night is not explained by away', nightCell.silenceCause !== 'away', `cause ${nightCell.silenceCause}`);
  // CMIST: 10 age75 households of which 1 replied, 10 others of which 8 replied, no outage, night
  const trappedSpec: CellSpec = {
    hex: 'trapped',
    n: 20,
    cell: { hazardIndex: 0.9 },
    household: (i) => ({ age75: i < 10, age65: i < 10 }),
    events: (i, id) => ((i < 10 && i < 1) || (i >= 10 && i < 18) ? [sent(id), reply(id)] : [sent(id)]),
  };
  const tw = mkWorld([...refCells(3), trappedSpec], nightQuake);
  const trapped = estimateAll(tw.world, tw.events, 720, dummyParams(), cfg).hexes.find((x) => x.hex === 'trapped')!;
  check('silence cause is trapped when CMIST-vulnerable households dominate the silent ones', trapped.silenceCause === 'trapped', `silence ${trapped.silence.toFixed(2)}, cause ${trapped.silenceCause}`);
  // uniform silence: nobody special -> unknown
  const plainSpec: CellSpec = { hex: 'plain', n: 20, cell: { hazardIndex: 0.9 }, events: (i, id) => (i < 4 ? [sent(id), reply(id)] : [sent(id)]) };
  const pw = mkWorld([...refCells(3), plainSpec], nightQuake);
  const plain = estimateAll(pw.world, pw.events, 720, dummyParams(), cfg).hexes.find((x) => x.hex === 'plain')!;
  check('silence cause is unknown when no group explains it', plain.silenceCause === 'unknown', `silence ${plain.silence.toFixed(2)}, cause ${plain.silenceCause}`);
  check('no silence cause on a non-silent cell', day.hexes.find((x) => x.hex === 'ref0')!.silenceCause === undefined);
}

// 13. event time
{
  const base: World = { eventId: 'x', name: 'x', landfallIso: '2026-11-07T00:18:00.000Z', center: { lat: 0, lng: 0 }, hexes: [], households: [], region: 'ca-bay-area', hazardType: 'earthquake' };
  const a = worldContext(base, cfg); // HayWired live: Fri 16:18 PST
  check('CA live quake derived from landfallIso is a weekday daytime event (16:18 PST)', a.localHour === 16 && a.weekday && a.daytime && !a.schoolHours && a.timeSource === 'landfallIso');
  const b = worldContext({ ...base, landfallIso: '2021-06-03T19:05:00.000Z' }, cfg); // Calaveras backtest: Thu 12:05 PDT
  check('CA backtest-2 derived: Thu 12:05 PDT, daytime and school hours', b.localHour === 12 && b.daytime && b.schoolHours);
  const c = worldContext({ ...base, landfallIso: '2019-03-12T10:42:00.000Z' }, cfg); // Tue 03:42 PDT
  check('CA backtest-1 derived: 03:42, not daytime', c.localHour === 3 && !c.daytime);
  const d = worldContext({ ...base, region: 'tx-corpus-christi', hazardType: 'hurricane', landfallIso: '2026-11-07T08:00:00.000Z' }, cfg); // 02:00 CST
  check('TX live hurricane derived: 02:00 CST, night', d.localHour === 2 && !d.daytime);
  const e = worldContext({ ...base, eventLocalHour: 10, eventWeekday: true }, cfg);
  check('explicit eventLocalHour/eventWeekday take precedence', e.localHour === 10 && e.daytime && e.schoolHours && e.timeSource === 'world');
  const f = worldContext({ ...base, eventLocalHour: 10, eventWeekday: false }, cfg);
  check('weekend events are never daytime/school hours', !f.daytime && !f.schoolHours);
}

// 14. students note
{
  const school: Facility = { id: 's1', kind: 'school', name: 'Thornton Middle', lat: 0, lng: 0, hex: 'hot', enrollment: 1854, source: 'test' };
  const { world: w, events: evs } = mkWorld(
    [
      ...refCells(2),
      { hex: 'hot', n: 20, cell: { hazardIndex: 0.9, k12Enrollment: 1854 }, events: (i, id) => (i < 4 ? [sent(id), reply(id, 3)] : [sent(id)]) },
      { hex: 'cool', n: 20, cell: { hazardIndex: 0.1, k12Enrollment: 900 }, events: (_, id) => [sent(id), reply(id)] },
    ],
    { hazardType: 'earthquake', region: 'ca-test', eventLocalHour: 10, eventWeekday: true, facilities: [school] },
  );
  const est = estimateAll(w, evs, 720, dummyParams(), cfg);
  const hot = est.hexes.find((x) => x.hex === 'hot')!;
  const cool = est.hexes.find((x) => x.hex === 'cool')!;
  check('reason mentions students for a school-hours event in a high-hazard cell with pupils', (hot.reason ?? '').includes('1,854 students at Thornton Middle'), hot.reason ?? '');
  check('no students note for a low-hazard cell', !(cool.reason ?? '').includes('students'));
  const night = estimateAll({ ...w, eventLocalHour: 22 }, evs, 720, dummyParams(), cfg).hexes.find((x) => x.hex === 'hot')!;
  check('no students note outside school hours', !(night.reason ?? '').includes('students'));
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
