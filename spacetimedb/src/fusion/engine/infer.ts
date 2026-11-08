// COPIED from engine/src/infer.ts by spacetimedb/scripts/sync-engine.ts. Do not edit here; edit engine/src and re-sync.
// Inference: HouseholdEstimate[] and HexEstimate[] at a snapshot time.
//
// Rules (all cutoffs come from TriageConfig.thresholds):
//   priority  P0  if any household has pNeedsHelp >= p0HelpProb
//                 or expectedSevere / households >= p0SevereShare
//             P1  if any pNeedsHelp >= p1HelpProb or severe share >= p1SevereShare
//             P2  otherwise
//             A high-hazard silent cell is floored at silentHighHazardFloor
//             (default P0, "suspected P0") and always needs verification.
//   verification  needs_verification if confidence < thresholds.confidence
//                 or (hazard >= highHazard and silence >= highSilence)
// Verified households (field report present) take the reported values.

import type { Facility, HexCell, HexEstimate, HexId, Household, HouseholdEstimate, ModelParams, Priority, SimEvent, Verification, World } from '../contract.ts';
import type { TriageConfig } from './config.ts';
import { DEFAULT_CONFIG, clamp, clamp01 } from './config.ts';
import type { CellAggregate, FeatureName, Snapshot } from './features.ts';
import { FEATURE_SOURCE, buildSnapshot, householdFeatureRecord, isFeatureName, neutralValue, selectFeatures } from './features.ts';
import type { LinearModel } from './logistic.ts';
import { predictProb, sigmoid } from './logistic.ts';
import { cellSevereInterval, type CellInterval, CELL_INTERVAL_TAIL } from './interval.ts';

export type SourceTrust = ModelParams['sourceTrust'];

export interface SourceMultipliers {
  hazard: number;
  sms: number;
  claims: number;
}

/** Models aligned to params.features and (optionally) modulated by current source trust. */
export interface ResolvedModels {
  featureNames: string[];
  severe: LinearModel;
  needsHelp: LinearModel;
  multipliers: SourceMultipliers;
  /** cell-level overdispersion for the severe-count interval (params.cellOverdispersion or the config default) */
  overdispersion: number;
  /** tail probability of the severe-count interval (params.cellIntervalTail or 0.05) */
  intervalTail: number;
}

/** Validate ModelParams shape; throws with a precise message instead of mis-indexing weights. */
export function validateParams(params: ModelParams): void {
  const d = params.features.length;
  if (d === 0) throw new Error('ModelParams.features is empty');
  if (params.severe.weights.length !== d) {
    throw new Error(`severe.weights has ${params.severe.weights.length} entries for ${d} features`);
  }
  if (params.needsHelp.weights.length !== d) {
    throw new Error(`needsHelp.weights has ${params.needsHelp.weights.length} entries for ${d} features`);
  }
  const seen = new Set<string>();
  for (const name of params.features) {
    if (!isFeatureName(name)) throw new Error(`ModelParams.features contains unknown feature "${name}"`);
    if (seen.has(name)) throw new Error(`ModelParams.features lists "${name}" twice`);
    seen.add(name);
  }
  for (const [k, v] of Object.entries(params.sourceTrust)) {
    if (!(v > 0 && v <= 1)) throw new Error(`sourceTrust.${k} = ${v} must be in (0, 1]`);
  }
}

/**
 * Multiplier applied to each source's learned weights: current trust relative
 * to the trust measured at calibration, clamped so no online drift can more
 * than moderately re-weight a source. Equal trust -> multiplier 1.
 */
export function trustMultipliers(params: ModelParams, trust: SourceTrust | undefined, cfg: TriageConfig): SourceMultipliers {
  if (!trust || !cfg.trust.applyToInference) return { hazard: 1, sms: 1, claims: 1 };
  const { min, max } = cfg.trust.effectClamp;
  const ratio = (cur: number, base: number): number => clamp(cur / base, min, max);
  return {
    hazard: ratio(trust.hazard, params.sourceTrust.hazard),
    sms: ratio(trust.sms, params.sourceTrust.sms),
    claims: ratio(trust.claims, params.sourceTrust.claims),
  };
}

function modulate(model: LinearModel, names: readonly string[], m: SourceMultipliers, cfg: TriageConfig): LinearModel {
  // w x  ->  w*neutral + mult*w*(x - neutral) = (mult*w) x + (1-mult)*w*neutral
  let bias = model.bias;
  const weights = model.weights.slice();
  for (let j = 0; j < names.length; j++) {
    const name = names[j] as FeatureName;
    const group = FEATURE_SOURCE[name];
    let mult = 1;
    if (group === 'hazard') mult = m.hazard;
    else if (group === 'sms') mult = m.sms;
    else if (group === 'claims') mult = m.claims;
    if (mult === 1) continue;
    const w = model.weights[j];
    weights[j] = mult * w;
    bias += (1 - mult) * w * neutralValue(name, cfg);
  }
  return { bias, weights };
}

export function resolveModels(params: ModelParams, cfg: TriageConfig = DEFAULT_CONFIG, trust?: SourceTrust): ResolvedModels {
  validateParams(params);
  const multipliers = trustMultipliers(params, trust, cfg);
  return {
    featureNames: params.features.slice(),
    severe: modulate(params.severe, params.features, multipliers, cfg),
    needsHelp: modulate(params.needsHelp, params.features, multipliers, cfg),
    multipliers,
    overdispersion: params.cellOverdispersion ?? cfg.interval.defaultOverdispersion,
    intervalTail: params.cellIntervalTail ?? CELL_INTERVAL_TAIL,
  };
}

/** The model's own probabilities for a household (no verification override, no neighbour update). */
export function modelProbs(h: Household, snap: Snapshot, models: ResolvedModels, cfg: TriageConfig): { pSevere: number; pNeedsHelp: number } {
  const rec = householdFeatureRecord(h, snap, cfg);
  const x = selectFeatures(rec, models.featureNames);
  return { pSevere: predictProb(models.severe, x), pNeedsHelp: predictProb(models.needsHelp, x) };
}

/** Shrunk mean residual (reported outcome - model prediction) over a cell's verified households. */
export interface CellResidual {
  severe: number;
  help: number;
  /** Verified households that contributed to `severe`. */
  k: number;
}

export const NO_RESIDUAL: CellResidual = { severe: 0, help: 0, k: 0 };

function logitOf(p: number): number {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(q / (1 - q));
}

/**
 * Household estimate given its model probabilities and the cell residual.
 * Verified households take the reported values; unverified ones get the
 * neighbour update from cfg.neighbourUpdate.
 */
export function finishHousehold(
  h: Household,
  snap: Snapshot,
  probs: { pSevere: number; pNeedsHelp: number },
  residual: CellResidual,
  cfg: TriageConfig,
): HouseholdEstimate {
  const s = snap.signals.get(h.id);
  const agg = snap.cells.get(h.hex);
  if (!s || !agg) throw new Error(`household ${h.id} not in snapshot`);

  const fr = s.fieldReport;
  if (fr) {
    const { high, low } = cfg.verifiedValues;
    const pSevere = fr.damage >= 2 ? high : low;
    let pNeedsHelp = probs.pNeedsHelp; // 'unsure': keep the model's needs-help estimate
    if (fr.safety === 'needs_help') pNeedsHelp = high;
    else if (fr.safety === 'safe') pNeedsHelp = low;
    const uncertainty = fr.safety === 'unsure' ? cfg.uncertainty.verifiedUnsureSafety : cfg.uncertainty.verified;
    return { householdId: h.id, pSevere, pNeedsHelp, uncertainty, verified: true };
  }

  const nu = cfg.neighbourUpdate;
  const pSevere = residual.k > 0 && nu.gainSevere !== 0 ? sigmoid(logitOf(probs.pSevere) + nu.gainSevere * residual.severe) : probs.pSevere;
  const pNeedsHelp = residual.k > 0 && nu.gainHelp !== 0 ? sigmoid(logitOf(probs.pNeedsHelp) + nu.gainHelp * residual.help) : probs.pNeedsHelp;

  // Uncertainty: spread of the estimate plus how much evidence backs it.
  const ownHeard = s.reply || s.claim ? 1 : 0;
  const n1 = Math.max(agg.households - 1, 0);
  const neighbourCoverage = n1 > 0 ? (agg.heardFrom - ownHeard) / n1 : 0;
  const evidenceScore = Math.max(ownHeard, clamp01(neighbourCoverage / cfg.uncertainty.neighbourCoverageForFullEvidence));
  const spread = 2 * Math.sqrt(pSevere * (1 - pSevere)); // 1 at p=0.5, 0 at p in {0,1}
  const uncertainty = clamp01(cfg.uncertainty.pWeight * spread + cfg.uncertainty.evidenceWeight * (1 - evidenceScore));

  return { householdId: h.id, pSevere, pNeedsHelp, uncertainty, verified: false };
}

/**
 * Estimate every household of one cell (two passes: model probabilities,
 * then residual from the verified members, then final estimates).
 */
export function estimateCellHouseholds(members: readonly Household[], snap: Snapshot, models: ResolvedModels, cfg: TriageConfig): HouseholdEstimate[] {
  const probs = members.map((h) => modelProbs(h, snap, models, cfg));
  let k = 0;
  let kHelp = 0;
  let sumSevere = 0;
  let sumHelp = 0;
  for (let i = 0; i < members.length; i++) {
    const fr = snap.signals.get(members[i].id)!.fieldReport;
    if (!fr) continue;
    k++;
    sumSevere += (fr.damage >= 2 ? 1 : 0) - probs[i].pSevere;
    if (fr.safety !== 'unsure') {
      kHelp++;
      sumHelp += (fr.safety === 'needs_help' ? 1 : 0) - probs[i].pNeedsHelp;
    }
  }
  const sc = cfg.neighbourUpdate.shrinkageCount;
  const residual: CellResidual = k === 0 ? NO_RESIDUAL : { severe: sumSevere / (k + sc), help: kHelp > 0 ? sumHelp / (kHelp + sc) : 0, k };
  return members.map((h, i) => finishHousehold(h, snap, probs[i], residual, cfg));
}

/** Convenience for a single household (recomputes its cell; use estimateCellHouseholds for whole cells). */
export function estimateHousehold(h: Household, snap: Snapshot, models: ResolvedModels, cfg: TriageConfig): HouseholdEstimate {
  const members = snap.householdsByHex.get(h.hex);
  if (!members) throw new Error(`household ${h.id} references unknown hex ${h.hex}`);
  const est = estimateCellHouseholds(members, snap, models, cfg).find((e) => e.householdId === h.id);
  if (!est) throw new Error(`household ${h.id} not in its cell's member list`);
  return est;
}

/** All households, in world.households order. */
export function estimateHouseholdsFromSnapshot(snap: Snapshot, models: ResolvedModels, cfg: TriageConfig): HouseholdEstimate[] {
  const byId = new Map<string, HouseholdEstimate>();
  for (const c of snap.world.hexes) {
    for (const e of estimateCellHouseholds(snap.householdsByHex.get(c.hex)!, snap, models, cfg)) byId.set(e.householdId, e);
  }
  return snap.world.households.map((h) => byId.get(h.id)!);
}

/**
 * Silence: hazard-weighted share of expected signal that is missing,
 * attenuated while so little signal is expected that absence proves nothing.
 * expectedHeard is conditioned on coverage / policy type (claims) and on
 * limited English / being away (replies), see features.ts fillExpected.
 */
export function cellSilence(agg: CellAggregate, cfg: TriageConfig): number {
  if (!(agg.expectedHeard > 0)) return 0;
  const deficit = clamp01(1 - agg.heardFrom / agg.expectedHeard);
  const evidence = 1 - Math.exp(-agg.expectedHeard / cfg.silence.expectedHeardScale);
  return clamp01(agg.hazard * deficit * evidence);
}

export type SilenceCause = NonNullable<HexEstimate['silenceCause']>;

/**
 * Why is the cell silent?
 *   'outage'  tower outage >= cfg.silenceCause.outageExplains
 *   'away'    daytime event and away-from-home households dominate the silent ones
 *   'trapped' CMIST-vulnerable households (age75, disability, noVehicle, medicalDevice, livesAlone) dominate
 *   'unknown' otherwise
 * "Dominate" = at least dominantShare of the silent households and over-represented
 * (by overRepresentation) relative to the whole cell. Returns undefined below minSilence.
 */
export function silenceCauseOf(agg: CellAggregate, silence: number, cfg: TriageConfig): SilenceCause | undefined {
  const sc = cfg.silenceCause;
  if (silence < sc.minSilence) return undefined;
  if (agg.outage >= sc.outageExplains) return 'outage';
  if (agg.silent === 0) return 'unknown';
  const n = agg.households;
  const awayShare = agg.silentAway / agg.silent;
  const vulnShare = agg.silentVulnerable / agg.silent;
  const awayCell = n > 0 ? agg.away / n : 0;
  const vulnCell = n > 0 ? agg.vulnerable / n : 0;
  const awayOk = agg.daytime && awayShare >= sc.dominantShare && awayShare >= awayCell * sc.overRepresentation;
  const vulnOk = vulnShare >= sc.dominantShare && vulnShare >= vulnCell * sc.overRepresentation;
  if (awayOk && vulnOk) {
    const awayRatio = awayCell > 0 ? awayShare / awayCell : Infinity;
    const vulnRatio = vulnCell > 0 ? vulnShare / vulnCell : Infinity;
    return awayRatio >= vulnRatio ? 'away' : 'trapped';
  }
  if (awayOk) return 'away';
  if (vulnOk) return 'trapped';
  return 'unknown';
}

const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };

export function higherPriority(a: Priority, b: Priority): Priority {
  return PRIORITY_RANK[a] <= PRIORITY_RANK[b] ? a : b;
}

/** Optional context for the human-readable reason (schools for the students note). */
export interface CellContext {
  cell?: HexCell;
  facilities?: readonly Facility[];
  schoolHours?: boolean;
  /** cell-level overdispersion for the severe-count interval (defaults to cfg.interval.defaultOverdispersion) */
  tau2?: number;
  /** tail probability of the severe-count interval (defaults to 0.05) */
  tail?: number;
}

function fmtInt(x: number): string {
  return Math.round(x).toLocaleString('en-US');
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Students note for a weekday school-hours event hitting a high-hazard cell with enrolled pupils. */
export function studentsNote(ctx: CellContext | undefined, hazard: number, cfg: TriageConfig): string | null {
  if (!ctx || !ctx.schoolHours || !ctx.cell) return null;
  if (hazard < cfg.thresholds.highHazard) return null;
  const k12 = ctx.cell.k12Enrollment ?? 0;
  if (!(k12 > 0)) return null;
  const schools = (ctx.facilities ?? []).filter((f) => f.kind === 'school' && f.hex === ctx.cell!.hex);
  if (schools.length === 0) return `${fmtInt(k12)} students at local schools (school hours)`;
  const top = schools.slice().sort((a, b) => (b.enrollment ?? 0) - (a.enrollment ?? 0) || (a.name < b.name ? -1 : 1))[0];
  const more = schools.length > 1 ? ` and ${schools.length - 1} more school${schools.length > 2 ? 's' : ''}` : '';
  const n = top.enrollment && top.enrollment > 0 ? top.enrollment : k12;
  return `${fmtInt(n)} students at ${top.name}${more} (school hours)`;
}

/**
 * 90% interval for the number of severe households in a cell: unverified households contribute their
 * (neighbour-updated) pSevere, verified ones count as known (severe if pSevere >= 0.5), and the shared
 * cell-level error shrinks with the cell's field reports. Exported so the database can store the variance.
 */
export function severeIntervalFor(agg: CellAggregate, members: readonly HouseholdEstimate[], cfg: TriageConfig, tau2?: number, tail?: number): CellInterval {
  const pUnverified: number[] = [];
  let verifiedSevere = 0;
  let verifiedTotal = 0;
  for (const m of members) {
    if (!m.verified) pUnverified.push(m.pSevere);
    else {
      verifiedTotal++;
      if (m.pSevere >= 0.5) verifiedSevere++;
    }
  }
  return cellSevereInterval({
    pUnverified,
    verifiedSevere,
    verifiedTotal,
    n: agg.households,
    tau2: tau2 ?? cfg.interval.defaultOverdispersion,
    shrink: cfg.neighbourUpdate.shrinkageCount,
    k: agg.fieldReported,
    ...(tail !== undefined ? { tail } : {}),
  });
}

/** Classify one cell from its aggregate and the estimates of its households. */
export function classifyCell(agg: CellAggregate, members: readonly HouseholdEstimate[], cfg: TriageConfig, ctx?: CellContext): HexEstimate {
  const n = agg.households;
  if (members.length !== n) {
    throw new Error(`cell ${agg.hex}: aggregate has ${n} households but ${members.length} estimates were supplied`);
  }
  let expectedSevere = 0;
  let maxPNeedsHelp = 0;
  let spreadSum = 0;
  let verifiedHelp = 0;
  for (const m of members) {
    expectedSevere += m.pSevere;
    if (m.pNeedsHelp > maxPNeedsHelp) maxPNeedsHelp = m.pNeedsHelp;
    if (!m.verified) spreadSum += 4 * m.pSevere * (1 - m.pSevere);
    else if (m.pNeedsHelp >= cfg.verifiedValues.high) verifiedHelp++;
  }
  // 90% interval for the number of severe households (src/interval.ts).
  const interval = severeIntervalFor(agg, members, cfg, ctx?.tau2, ctx?.tail);
  const severeShare = n > 0 ? expectedSevere / n : 0;
  const severity = clamp01(1 - (1 - severeShare) * (1 - maxPNeedsHelp));

  // Confidence: evidence coverage relative to what the hazard demands, times
  // how decided the estimates are, penalised when outage explains the gap.
  const coverage = n > 0 ? agg.heardFrom / n : 1;
  const required = cfg.confidence.minRequiredCoverage + cfg.confidence.hazardCoverageSlope * agg.hazard;
  const coverageScore = clamp01(coverage / required);
  const meanSpread = n > 0 ? spreadSum / n : 0;
  const confidence = clamp01(
    (0.5 * coverageScore + 0.5 * (1 - meanSpread)) * (1 - cfg.confidence.outagePenalty * agg.outage * (1 - coverageScore)),
  );

  const silence = cellSilence(agg, cfg);
  const th = cfg.thresholds;

  let priority: Priority;
  let tierWhy: string;
  if (maxPNeedsHelp >= th.p0HelpProb) {
    priority = 'P0';
    tierWhy = verifiedHelp > 0 ? `${verifiedHelp} household${verifiedHelp > 1 ? 's' : ''} confirmed needing help` : `credible needs-help signal (max ${pct(maxPNeedsHelp)})`;
  } else if (severeShare >= th.p0SevereShare) {
    priority = 'P0';
    tierWhy = `${expectedSevere.toFixed(1)} of ${n} expected severe`;
  } else if (maxPNeedsHelp >= th.p1HelpProb) {
    priority = 'P1';
    tierWhy = `possible needs-help (max ${pct(maxPNeedsHelp)})`;
  } else if (severeShare >= th.p1SevereShare) {
    priority = 'P1';
    tierWhy = `${expectedSevere.toFixed(1)} of ${n} expected severe`;
  } else {
    priority = 'P2';
    tierWhy = n > 0 ? `${expectedSevere.toFixed(1)} of ${n} expected severe` : 'no policyholders';
  }

  const highHazardSilent = agg.hazard >= th.highHazard && silence >= th.highSilence;
  let suspected = false;
  if (highHazardSilent && PRIORITY_RANK[th.silentHighHazardFloor] < PRIORITY_RANK[priority]) {
    priority = th.silentHighHazardFloor;
    suspected = true;
  }
  const verification: Verification = confidence < th.confidence || highHazardSilent ? 'needs_verification' : 'verified';
  const silenceCause = silenceCauseOf(agg, silence, cfg);

  const parts: string[] = [];
  parts.push(suspected ? `suspected ${priority}: high hazard (${pct(agg.hazard)}) and silent` : `${priority}: ${tierWhy}`);
  if (silence >= cfg.silenceCause.minSilence) {
    const cause = silenceCause === 'outage' ? 'tower outage' : silenceCause === 'away' ? 'residents away' : silenceCause === 'trapped' ? 'vulnerable residents may be trapped' : 'cause unknown';
    parts.push(`silence ${pct(silence)} (${agg.replied}/${agg.smsSent} replied, ${agg.claimed} claim${agg.claimed === 1 ? '' : 's'}, outage ${pct(agg.outage)}): ${cause}`);
  }
  if (agg.fieldReported > 0) parts.push(`${agg.fieldReported}/${n} field-verified`);
  parts.push(verification === 'verified' ? `confidence ${pct(confidence)}` : `needs verification (confidence ${pct(confidence)})`);
  const note = studentsNote(ctx, agg.hazard, cfg);
  if (note) parts.push(note);

  return {
    hex: agg.hex,
    households: n,
    expectedSevere,
    severeLo: interval.lo,
    severeHi: interval.hi,
    maxPNeedsHelp,
    severity,
    confidence,
    priority,
    verification,
    silence,
    counts: {
      smsSent: agg.smsSent,
      smsReplies: agg.replied,
      claims: agg.claimed,
      fieldReports: agg.fieldReported,
    },
    hazard: agg.hazard,
    reason: parts.join('; '),
    ...(silenceCause !== undefined ? { silenceCause } : {}),
  };
}

/**
 * Active-inspection score of a household, normalised to 0..1 (0 for verified):
 * (wSevere*pSevere + wHelp*pNeedsHelp + wUncertainty*uncertainty + wSilence*cellSilence
 *  + wNeedsVerification*[cell needs verification]) / sum of weights.
 */
export function inspectionScore(e: HouseholdEstimate, cell: Pick<HexEstimate, 'silence' | 'verification'>, cfg: TriageConfig): number {
  if (e.verified) return 0;
  const w = cfg.active;
  const wSum = w.wSevere + w.wHelp + w.wUncertainty + w.wSilence + w.wNeedsVerification;
  const nv = cell.verification === 'needs_verification' ? 1 : 0;
  return (w.wSevere * e.pSevere + w.wHelp * e.pNeedsHelp + w.wUncertainty * e.uncertainty + w.wSilence * cell.silence + w.wNeedsVerification * nv) / wSum;
}

/** Household estimates of one cell with inspectScore filled in (pure). */
export function attachInspectScores(members: readonly HouseholdEstimate[], hex: HexEstimate, cfg: TriageConfig): HouseholdEstimate[] {
  return members.map((e) => ({ ...e, inspectScore: inspectionScore(e, hex, cfg) }));
}

/** Group household estimates by hex (in world.hexes order). */
export function groupByHex(snap: Snapshot, estimates: readonly HouseholdEstimate[]): Map<HexId, HouseholdEstimate[]> {
  const groups = new Map<HexId, HouseholdEstimate[]>();
  for (const c of snap.world.hexes) groups.set(c.hex, []);
  for (const e of estimates) {
    const h = snap.householdById.get(e.householdId);
    if (!h) throw new Error(`estimate for unknown household ${e.householdId}`);
    groups.get(h.hex)!.push(e);
  }
  return groups;
}

export function cellContext(snap: Snapshot, hex: HexId, tau2?: number, tail?: number): CellContext {
  return { cell: snap.cellById.get(hex), facilities: snap.facilitiesByHex.get(hex) ?? [], schoolHours: snap.ctx.schoolHours, ...(tau2 !== undefined ? { tau2 } : {}), ...(tail !== undefined ? { tail } : {}) };
}

export function estimateHexesFromSnapshot(snap: Snapshot, estimates: readonly HouseholdEstimate[], cfg: TriageConfig, tau2?: number, tail?: number): HexEstimate[] {
  const groups = groupByHex(snap, estimates);
  return snap.world.hexes.map((c) => classifyCell(snap.cells.get(c.hex)!, groups.get(c.hex)!, cfg, cellContext(snap, c.hex, tau2, tail)));
}

/** Fill inspectScore on every household estimate from its cell's estimate (pure). */
export function withInspectScores(snap: Snapshot, estimates: readonly HouseholdEstimate[], hexes: readonly HexEstimate[], cfg: TriageConfig): HouseholdEstimate[] {
  const hexById = new Map<HexId, HexEstimate>();
  for (const x of hexes) hexById.set(x.hex, x);
  return estimates.map((e) => {
    const h = snap.householdById.get(e.householdId);
    const x = h ? hexById.get(h.hex) : undefined;
    if (!h || !x) throw new Error(`no hex estimate for household ${e.householdId}`);
    return { ...e, inspectScore: inspectionScore(e, x, cfg) };
  });
}

export interface Estimates {
  t: number;
  snapshot: Snapshot;
  models: ResolvedModels;
  households: HouseholdEstimate[];
  hexes: HexEstimate[];
}

/** One-call inference: snapshot at t, household estimates (with inspectScore), hex estimates. */
export function estimateAll(
  world: World,
  events: readonly SimEvent[],
  t: number,
  params: ModelParams,
  cfg: TriageConfig = DEFAULT_CONFIG,
  trust?: SourceTrust,
): Estimates {
  const models = resolveModels(params, cfg, trust);
  const snapshot = buildSnapshot(world, events, t, cfg);
  const raw = estimateHouseholdsFromSnapshot(snapshot, models, cfg);
  const hexes = estimateHexesFromSnapshot(snapshot, raw, cfg, models.overdispersion, models.intervalTail);
  const households = withInspectScores(snapshot, raw, hexes, cfg);
  return { t, snapshot, models, households, hexes };
}

export function estimateHouseholds(
  world: World,
  events: readonly SimEvent[],
  t: number,
  params: ModelParams,
  cfg: TriageConfig = DEFAULT_CONFIG,
  trust?: SourceTrust,
): HouseholdEstimate[] {
  return estimateAll(world, events, t, params, cfg, trust).households;
}

export function estimateHexes(
  world: World,
  events: readonly SimEvent[],
  t: number,
  params: ModelParams,
  cfg: TriageConfig = DEFAULT_CONFIG,
  trust?: SourceTrust,
): HexEstimate[] {
  return estimateAll(world, events, t, params, cfg, trust).hexes;
}
