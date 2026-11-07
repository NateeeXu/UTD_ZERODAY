// Fusion adapter: the only place where reducers touch the estimator.
// recomputeHex(ctx, hexId) gathers one cell's households and events from the tables, calls a pure
// estimator (CellEstimator), and writes household_estimate + the fusion columns of hex_stats.
//
// To swap in the real engine: see `activeEstimator` below and docs/SPACETIME_API.md ("Fusion engine").
import type { Ctx } from '../schema';
import { getMetrics, getModelState, getReplay } from '../state';
import { stubEstimator } from './stub';
import { engineEstimator, engineWorldRefs } from './engine-adapter';
import type { Damage, HexCell, Household, ModelParams, Peril, Safety } from './contract';
import type { CellEstimator, CellInput, HouseholdSignals, SourceTrust, WorldRefs } from './types';

// ----- model params (parsed once per version) --------------------------------

let paramsCache: { key: string; params: ModelParams | null } | null = null;

export function modelParams(ctx: Ctx): ModelParams | null {
  const ms = getModelState(ctx);
  if (!ms.loaded || !ms.paramsJson) return null;
  const key = `${ms.version}:${ms.paramsJson.length}`;
  if (!paramsCache || paramsCache.key !== key) {
    let params: ModelParams | null = null;
    try {
      params = JSON.parse(ms.paramsJson) as ModelParams;
    } catch {
      params = null;
    }
    paramsCache = { key, params };
  }
  return paramsCache.params;
}

/** Real engine when it is available and a model is loaded; the TEMPORARY stub otherwise. */
export function activeEstimator(params: ModelParams | null): CellEstimator {
  if (params && engineEstimator && engineEstimator.supports(params)) return engineEstimator;
  return stubEstimator;
}

export function currentTrust(ctx: Ctx): SourceTrust {
  const ms = getModelState(ctx);
  return { hazard: ms.trustHazard, sms: ms.trustSms, claims: ms.trustClaims };
}

// ----- gathering -------------------------------------------------------------

type HexRow = NonNullable<ReturnType<Ctx['db']['hex']['hex']['find']>>;
type HouseholdRow = NonNullable<ReturnType<Ctx['db']['household']['id']['find']>>;

export function toHexCell(row: HexRow): HexCell {
  return {
    hex: row.hex,
    lat: row.lat,
    lng: row.lng,
    windMph: row.windMph,
    floodDepthFt: row.floodDepthFt,
    towerOutagePct: row.towerOutagePct,
    analystZone: row.analystZone as 0 | 1 | 2,
  };
}

export function toHousehold(row: HouseholdRow): Household {
  return {
    id: row.id,
    hex: row.hex,
    lat: row.lat,
    lng: row.lng,
    age65: row.age65,
    livesAlone: row.livesAlone,
    medicalDevice: row.medicalDevice,
    windCovered: row.windCovered,
    floodPolicy: row.floodPolicy,
    earthquakeEndorsement: row.earthquakeEndorsement,
    phoneOnFile: row.phoneOnFile,
    holdout: row.holdout,
  };
}

function emptySignals(h: HouseholdRow): HouseholdSignals {
  return { household: toHousehold(h), smsSentT: null, reply: null, claim: null, field: null };
}

type EventRows = {
  sent: Iterable<{ householdId: string; t: number }>;
  replies: Iterable<{ householdId: string; t: number; safety: string; damage: number }>;
  claims: Iterable<{ householdId: string; t: number; peril: string; reportedDamage: number }>;
  fields: Iterable<{ householdId: string; t: number; safety: string; damage: number; adjusterId: string }>;
};

function foldEvents(byId: Map<string, HouseholdSignals>, rows: EventRows) {
  for (const e of rows.sent) {
    const s = byId.get(e.householdId);
    if (s && (s.smsSentT === null || e.t < s.smsSentT)) s.smsSentT = e.t;
  }
  for (const e of rows.replies) {
    const s = byId.get(e.householdId);
    if (s && (!s.reply || e.t >= s.reply.t))
      s.reply = { t: e.t, safety: e.safety as 'safe' | 'needs_help', damage: e.damage as Damage };
  }
  for (const e of rows.claims) {
    const s = byId.get(e.householdId);
    if (s && (!s.claim || e.t >= s.claim.t))
      s.claim = { t: e.t, peril: e.peril as Peril, reportedDamage: e.reportedDamage as Damage };
  }
  for (const e of rows.fields) {
    const s = byId.get(e.householdId);
    if (s && (!s.field || e.t >= s.field.t))
      s.field = { t: e.t, safety: e.safety as Safety, damage: e.damage as Damage, adjusterId: e.adjusterId };
  }
}

/** Signals for every household of one cell (5 index scans). */
export function gatherCellSignals(ctx: Ctx, hexId: string): HouseholdSignals[] {
  const byId = new Map<string, HouseholdSignals>();
  for (const h of ctx.db.household.hex.filter(hexId)) byId.set(h.id, emptySignals(h));
  foldEvents(byId, {
    sent: ctx.db.smsSent.hex.filter(hexId),
    replies: ctx.db.smsReply.hex.filter(hexId),
    claims: ctx.db.claim.hex.filter(hexId),
    fields: ctx.db.fieldReport.hex.filter(hexId),
  });
  return [...byId.values()];
}

/** Signals for a single household (used before a field report to score source agreement). */
export function gatherHouseholdSignals(ctx: Ctx, h: HouseholdRow): HouseholdSignals {
  const byId = new Map([[h.id, emptySignals(h)]]);
  foldEvents(byId, {
    sent: ctx.db.smsSent.householdId.filter(h.id),
    replies: ctx.db.smsReply.householdId.filter(h.id),
    claims: ctx.db.claim.householdId.filter(h.id),
    fields: ctx.db.fieldReport.householdId.filter(h.id),
  });
  return byId.get(h.id)!;
}

// ----- recompute -------------------------------------------------------------

// Rows are only rewritten when an output moved by at least this much. The model has a time feature,
// so every recompute nudges every probability; skipping tiny moves keeps subscription traffic (and
// Maincloud energy) proportional to real changes.
const WRITE_EPS = 5e-4;
const changed = (a: number, b: number) => Math.abs(a - b) >= WRITE_EPS;

function bumpPriority(m: ReturnType<typeof getMetrics>, priority: string, verification: string, d: 1 | -1) {
  const add = (x: number) => Math.max(0, x + d);
  if (priority === 'P0') m.p0Cells = add(m.p0Cells);
  else if (priority === 'P1') m.p1Cells = add(m.p1Cells);
  else if (priority === 'P2') m.p2Cells = add(m.p2Cells);
  if (priority && verification === 'needs_verification') m.needsVerificationCells = add(m.needsVerificationCells);
}

/** World reference rates from the hex_stats counters (one pass over all cells). */
export function computeWorldRefs(ctx: Ctx): WorldRefs {
  const rows: { cell: HexCell; households: number; smsSent: number; replied: number; claimed: number }[] = [];
  for (const s of ctx.db.hexStats.iter()) {
    const cell = ctx.db.hex.hex.find(s.hex);
    if (!cell) continue;
    // hex_stats.claims counts claim events; the simulator files at most one claim per household.
    rows.push({ cell: toHexCell(cell), households: s.households, smsSent: s.smsSent, replied: s.smsReplies, claimed: s.claims });
  }
  return engineWorldRefs(rows);
}

/** Everything recomputeHex needs that does not depend on the cell. Build once per batch. */
export interface RecomputePrep {
  params: ModelParams | null;
  estimator: CellEstimator;
  trust: SourceTrust;
  nowMin: number;
  refs: WorldRefs | null;
}

export function prepareRecompute(ctx: Ctx): RecomputePrep {
  const params = modelParams(ctx);
  const estimator = activeEstimator(params);
  return {
    params,
    estimator,
    trust: currentTrust(ctx),
    nowMin: getReplay(ctx).simMinutes,
    refs: estimator.needsRefs ? computeWorldRefs(ctx) : null,
  };
}

/** Recompute one cell. Pass `prep` when recomputing many cells in the same transaction. */
export function recomputeHex(ctx: Ctx, hexId: string, prep: RecomputePrep = prepareRecompute(ctx)) {
  const cellRow = ctx.db.hex.hex.find(hexId);
  const stats = ctx.db.hexStats.hex.find(hexId);
  if (!cellRow || !stats) return;

  const { estimator } = prep;
  const input: CellInput = {
    cell: toHexCell(cellRow),
    households: gatherCellSignals(ctx, hexId),
    nowMin: prep.nowMin,
    trust: prep.trust,
    params: prep.params,
    refs: prep.refs,
  };
  const out = estimator.estimateCell(input);

  for (const e of out.households) {
    const prev = ctx.db.householdEstimate.householdId.find(e.householdId);
    const row = {
      householdId: e.householdId,
      hex: hexId,
      pSevere: e.pSevere,
      pNeedsHelp: e.pNeedsHelp,
      uncertainty: e.uncertainty,
      verified: e.verified,
      inspectScore: e.inspectScore,
      updatedAt: ctx.timestamp,
    };
    if (!prev) ctx.db.householdEstimate.insert(row);
    else if (
      changed(prev.pSevere, row.pSevere) ||
      changed(prev.pNeedsHelp, row.pNeedsHelp) ||
      changed(prev.uncertainty, row.uncertainty) ||
      changed(prev.inspectScore, row.inspectScore) ||
      prev.verified !== row.verified
    )
      ctx.db.householdEstimate.householdId.update(row);
  }

  const h = out.hex;
  const m = getMetrics(ctx);
  const priorityChanged = stats.priority !== h.priority || stats.verification !== h.verification;
  if (priorityChanged) {
    bumpPriority(m, stats.priority, stats.verification, -1);
    bumpPriority(m, h.priority, h.verification, 1);
  }
  if (priorityChanged || m.engine !== estimator.name) {
    m.engine = estimator.name;
    m.updatedAt = ctx.timestamp;
    ctx.db.metrics.id.update(m);
  }

  const material =
    priorityChanged ||
    stats.reason !== out.reason ||
    changed(stats.severity, h.severity) ||
    changed(stats.confidence, h.confidence) ||
    changed(stats.silence, h.silence) ||
    changed(stats.expectedSevere, h.expectedSevere) ||
    changed(stats.maxPNeedsHelp, h.maxPNeedsHelp);
  if (!material) return;
  ctx.db.hexStats.hex.update({
    ...stats,
    severity: h.severity,
    confidence: h.confidence,
    priority: h.priority,
    verification: h.verification,
    silence: h.silence,
    expectedSevere: h.expectedSevere,
    maxPNeedsHelp: h.maxPNeedsHelp,
    reason: out.reason,
    updatedAt: ctx.timestamp,
    updatedSimMinutes: input.nowMin,
  });
}
