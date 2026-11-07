// COPIED from engine/src/learning.ts by spacetimedb/scripts/sync-engine.ts. Do not edit here; edit engine/src and re-sync.
// Learning loop.
//
// (a) Local update: a field report is applied to the snapshot immediately and
//     only the affected household and its cell are re-estimated. The result is
//     identical to rebuilding the snapshot from all events (the self-check
//     script asserts this), just cheaper.
//
// (b) Global source-trust update: every field report on a NON-holdout
//     household is queued as an observation of how well each source's own
//     signal predicted the reported outcome. Only when `trust.batchSize`
//     (default 10) such observations have accumulated is trust adjusted, and
//     each adjustment moves a source by at most learningRate * |score - trust|
//     (default 10% of the gap). A single report therefore can never swing the
//     global weights: it changes exactly one household and one cell, and at
//     most 1/batchSize of the next batch score.
//
// Holdout households: their reports still update them locally (the adjuster
// really visited), but they are never used for trust updates, matching the
// rule that holdout households never train anything.

import type { HexEstimate, HexId, HouseholdEstimate, ModelParams, SimEvent } from '../contract.ts';
import type { TriageConfig } from './config.ts';
import { clamp } from './config.ts';
import type { HouseholdSignals, Snapshot } from './features.ts';
import { aggregateCellCounts, applyEventToSignals, fillExpected } from './features.ts';
import type { ResolvedModels, SourceTrust } from './infer.ts';
import { classifyCell, estimateCellHouseholds } from './infer.ts';

export type FieldReportEvent = Extract<SimEvent, { kind: 'field_report' }>;

/** Each source's own P(damage >= 2) for a household, before the field report. null = source has no opinion. */
export interface SourceOpinions {
  /** Hazard score of the cell, read as a probability of severe damage. */
  hazard: number;
  /** Own SMS reply damage / 3, if a reply exists. */
  sms: number | null;
  /** Own claim reportedDamage / 3, if a claim exists. */
  claims: number | null;
}

export interface FieldReportObservation {
  householdId: string;
  hex: HexId;
  t: number;
  holdout: boolean;
  outcomeSevere: 0 | 1;
  opinions: SourceOpinions;
}

export interface BatchScores {
  hazard: number | null;
  sms: number | null;
  claims: number | null;
}

export interface TrustUpdate {
  /** Non-holdout reports seen when this update fired. */
  afterNonHoldoutReports: number;
  batchSize: number;
  /** 1 - Brier of each source's opinion within the batch (null: too few opinions). */
  scores: BatchScores;
  opinionCounts: { hazard: number; sms: number; claims: number };
  before: SourceTrust;
  after: SourceTrust;
}

export interface LearningState {
  /** Trust measured at calibration (ModelParams.sourceTrust); reference for inference modulation. */
  baseline: SourceTrust;
  /** Current trust, shown in the UI and (optionally) applied to inference. */
  trust: SourceTrust;
  /** Non-holdout observations waiting for the next batch. */
  pending: FieldReportObservation[];
  nonHoldoutReports: number;
  holdoutReports: number;
  updates: TrustUpdate[];
}

export function initLearningState(params: ModelParams): LearningState {
  return {
    baseline: { ...params.sourceTrust },
    trust: { ...params.sourceTrust },
    pending: [],
    nonHoldoutReports: 0,
    holdoutReports: 0,
    updates: [],
  };
}

/** Opinions of the three sources about one household, from the snapshot BEFORE its field report. */
export function sourceOpinions(householdId: string, snap: Snapshot): SourceOpinions {
  const h = snap.householdById.get(householdId);
  const s = snap.signals.get(householdId);
  if (!h || !s) throw new Error(`sourceOpinions: unknown household ${householdId}`);
  const agg = snap.cells.get(h.hex)!;
  return {
    hazard: agg.hazard,
    sms: s.reply ? s.reply.damage / 3 : null,
    claims: s.claim ? s.claim.reportedDamage / 3 : null,
  };
}

/** Turn a field report into a trust observation. `snapBefore` must not yet contain the report. */
export function observeFieldReport(report: FieldReportEvent, snapBefore: Snapshot): FieldReportObservation {
  const h = snapBefore.householdById.get(report.householdId);
  if (!h) throw new Error(`observeFieldReport: unknown household ${report.householdId}`);
  return {
    householdId: h.id,
    hex: h.hex,
    t: report.t,
    holdout: h.holdout,
    outcomeSevere: report.damage >= 2 ? 1 : 0,
    opinions: sourceOpinions(h.id, snapBefore),
  };
}

/** 1 - Brier of a source's opinions over a batch, or null when it voiced fewer than minOpinions. */
export function scoreSource(batch: readonly FieldReportObservation[], source: keyof SourceOpinions, minOpinions: number): { score: number | null; count: number } {
  let n = 0;
  let se = 0;
  for (const obs of batch) {
    const p = obs.opinions[source];
    if (p === null) continue;
    n++;
    const d = p - obs.outcomeSevere;
    se += d * d;
  }
  if (n < minOpinions) return { score: null, count: n };
  return { score: 1 - se / n, count: n };
}

/** Apply one capped step toward the batch score (pure). */
export function stepTrust(trust: SourceTrust, scores: BatchScores, cfg: TriageConfig): SourceTrust {
  const { learningRate, min, max } = cfg.trust;
  const step = (cur: number, score: number | null): number => (score === null ? cur : clamp(cur + learningRate * (score - cur), min, max));
  return {
    hazard: step(trust.hazard, scores.hazard),
    sms: step(trust.sms, scores.sms),
    claims: step(trust.claims, scores.claims),
  };
}

/**
 * Record a field-report observation. Returns a new state; trust changes only
 * when a full batch of non-holdout observations is available.
 */
export function recordFieldReport(state: LearningState, obs: FieldReportObservation, cfg: TriageConfig): LearningState {
  if (obs.holdout) {
    return { ...state, holdoutReports: state.holdoutReports + 1 };
  }
  const pending = [...state.pending, obs];
  const nonHoldoutReports = state.nonHoldoutReports + 1;
  if (pending.length < cfg.trust.batchSize) {
    return { ...state, pending, nonHoldoutReports };
  }
  const batch = pending.slice(0, cfg.trust.batchSize);
  const rest = pending.slice(cfg.trust.batchSize);
  const hz = scoreSource(batch, 'hazard', cfg.trust.minOpinionsPerSource);
  const sm = scoreSource(batch, 'sms', cfg.trust.minOpinionsPerSource);
  const cl = scoreSource(batch, 'claims', cfg.trust.minOpinionsPerSource);
  const scores: BatchScores = { hazard: hz.score, sms: sm.score, claims: cl.score };
  const after = stepTrust(state.trust, scores, cfg);
  const update: TrustUpdate = {
    afterNonHoldoutReports: nonHoldoutReports,
    batchSize: batch.length,
    scores,
    opinionCounts: { hazard: hz.count, sms: sm.count, claims: cl.count },
    before: { ...state.trust },
    after: { ...after },
  };
  return {
    ...state,
    trust: after,
    pending: rest,
    nonHoldoutReports,
    updates: [...state.updates, update],
  };
}

function cloneSignals(s: HouseholdSignals): HouseholdSignals {
  return {
    smsSent: s.smsSent,
    firstSmsT: s.firstSmsT,
    reply: s.reply ? { ...s.reply } : null,
    replies: s.replies,
    claim: s.claim ? { ...s.claim } : null,
    claims: s.claims,
    fieldReport: s.fieldReport ? { ...s.fieldReport } : null,
    fieldReports: s.fieldReports,
  };
}

/**
 * Local update of a snapshot with one field report (pure: returns a new
 * snapshot sharing untouched entries). World reference rates do not depend
 * on field reports, so recomputing only the affected cell is exact.
 */
export function applyFieldReportToSnapshot(snap: Snapshot, report: FieldReportEvent): Snapshot {
  const h = snap.householdById.get(report.householdId);
  const old = snap.signals.get(report.householdId);
  if (!h || !old) throw new Error(`applyFieldReport: unknown household ${report.householdId}`);
  const updated = cloneSignals(old);
  applyEventToSignals(updated, report);
  const signals = new Map(snap.signals);
  signals.set(h.id, updated);
  const cell = snap.cellById.get(h.hex)!;
  const agg = aggregateCellCounts(cell, snap.householdsByHex.get(h.hex)!, signals, snap.cfg);
  fillExpected(agg, snap.refs);
  const cells = new Map(snap.cells);
  cells.set(h.hex, agg);
  return { ...snap, signals, cells };
}

/** Re-estimate only the households of `hex` and that hex (pure; other entries are shared). */
export function reestimateCell(
  snap: Snapshot,
  hex: HexId,
  models: ResolvedModels,
  cfg: TriageConfig,
  households: readonly HouseholdEstimate[],
  hexes: readonly HexEstimate[],
): { households: HouseholdEstimate[]; hexes: HexEstimate[] } {
  const members = snap.householdsByHex.get(hex);
  const agg = snap.cells.get(hex);
  if (!members || !agg) throw new Error(`reestimateCell: unknown hex ${hex}`);
  const cellMembers = estimateCellHouseholds(members, snap, models, cfg);
  const fresh = new Map<string, HouseholdEstimate>();
  for (const e of cellMembers) fresh.set(e.householdId, e);
  const outHouseholds = households.map((e) => fresh.get(e.householdId) ?? e);
  const newHex = classifyCell(agg, cellMembers, cfg);
  let replaced = false;
  const outHexes = hexes.map((x) => {
    if (x.hex !== hex) return x;
    replaced = true;
    return newHex;
  });
  if (!replaced) throw new Error(`reestimateCell: hex ${hex} missing from hex estimates`);
  return { households: outHouseholds, hexes: outHexes };
}

export interface LocalUpdateResult {
  snapshot: Snapshot;
  households: HouseholdEstimate[];
  hexes: HexEstimate[];
  observation: FieldReportObservation;
}

/** Convenience: observe (for trust), apply locally, re-estimate the one cell. */
export function localUpdate(
  snap: Snapshot,
  report: FieldReportEvent,
  models: ResolvedModels,
  cfg: TriageConfig,
  households: readonly HouseholdEstimate[],
  hexes: readonly HexEstimate[],
): LocalUpdateResult {
  const observation = observeFieldReport(report, snap);
  const snapshot = applyFieldReportToSnapshot(snap, report);
  const re = reestimateCell(snapshot, observation.hex, models, cfg, households, hexes);
  return { snapshot, households: re.households, hexes: re.hexes, observation };
}
