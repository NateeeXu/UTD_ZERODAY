// Fusion adapter: the only place where reducers touch the estimator.
//
// recomputeCells(ctx, hexIds) runs in three phases so the engine's world reference rates are always
// computed from up-to-date aggregates of every cell:
//   1. per touched cell: gather households + events from the tables, aggregate (engine
//      aggregateCellCounts) and persist the counters in the private cell_agg table;
//   2. world refs = engine computeRefs over all cell_agg rows (one row per cell);
//   3. per touched cell: estimate, then write household_estimate, inspection_candidate and the
//      fusion columns of hex_stats (rows are rewritten only when something moved materially).
// A cell's aggregate only changes with its own events, and every event recomputes its cell in the
// same transaction, so cell_agg is always exact. Untouched cells pick up drifting refs / time at the
// next full recompute (replay cadence, jump, pause, reset).
import type { Ctx } from '../schema';
import { getMetrics, getModelState, getReplay, worldCtxOf, worldStampKey } from '../state';
import { stubEstimator } from './stub';
import { engineEstimator, engineWorldRefs, INSPECT_PER_CELL } from './engine-adapter';
import type { Damage, Facility, HexCell, Household, ModelParams, Peril, Safety } from './contract';
import type {
  CellEstimator,
  CellInput,
  HouseholdSignals,
  PreparedCell,
  RefsCounters,
  SourceTrust,
  WorldContext,
  WorldRefs,
} from './types';

// ----- model params (parsed once per version) --------------------------------

let paramsCache: { key: string; params: ModelParams | null } | null = null;

export function modelParams(ctx: Ctx): ModelParams | null {
  const ms = getModelState(ctx);
  if (!ms.loaded || !ms.paramsJson) return null;
  const key = `${ms.version}:${ms.paramsJson.length}:${ms.updatedAt.microsSinceUnixEpoch}`;
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

/** Real engine when a valid model is loaded; the TEMPORARY stub otherwise. */
export function activeEstimator(params: ModelParams | null): CellEstimator {
  if (params && engineEstimator.supports(params)) return engineEstimator;
  return stubEstimator;
}

export function currentTrust(ctx: Ctx): SourceTrust {
  const ms = getModelState(ctx);
  return { hazard: ms.trustHazard, sms: ms.trustSms, claims: ms.trustClaims };
}

// ----- row -> contract conversions ------------------------------------------

type HexRow = NonNullable<ReturnType<Ctx['db']['hex']['hex']['find']>>;
type HouseholdRow = NonNullable<ReturnType<Ctx['db']['household']['id']['find']>>;
type FacilityRow = NonNullable<ReturnType<Ctx['db']['facility']['id']['find']>>;

/** Copy defined optional fields only, so the engine sees exactly what the bundle had. */
function withOptional<T extends object>(base: T, optional: Record<string, unknown>): T {
  for (const [k, v] of Object.entries(optional)) if (v !== undefined) (base as Record<string, unknown>)[k] = v;
  return base;
}

export function toHexCell(row: HexRow): HexCell {
  return withOptional<HexCell>(
    {
      hex: row.hex,
      lat: row.lat,
      lng: row.lng,
      windMph: row.windMph,
      floodDepthFt: row.floodDepthFt,
      towerOutagePct: row.towerOutagePct,
      analystZone: row.analystZone as 0 | 1 | 2,
    },
    {
      hazardIndex: row.hazardIndex,
      shakingMmi: row.shakingMmi,
      liquefaction: row.liquefaction,
      tractGeoid: row.tractGeoid,
      daytimeWorkers: row.daytimeWorkers,
      residentWorkers: row.residentWorkers,
      k12Enrollment: row.k12Enrollment,
      collegeEnrollment: row.collegeEnrollment,
    }
  );
}

export function toHousehold(row: HouseholdRow): Household {
  return withOptional<Household>(
    {
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
    },
    {
      tractGeoid: row.tractGeoid,
      childrenUnder18: row.childrenUnder18,
      awayDaytime: row.awayDaytime,
      age75: row.age75,
      disability: row.disability,
      noVehicle: row.noVehicle,
      limitedEnglish: row.limitedEnglish,
      primaryLanguage: row.primaryLanguage,
      mobileHome: row.mobileHome,
      policyType: row.policyType,
      schoolAgeChildren: row.schoolAgeChildren,
      collegeStudent: row.collegeStudent,
      nearestSchoolId: row.nearestSchoolId,
    }
  );
}

function toFacility(row: FacilityRow): Facility {
  return withOptional<Facility>(
    { id: row.id, kind: row.kind as Facility['kind'], name: row.name, lat: row.lat, lng: row.lng, hex: row.hex, source: row.source },
    { enrollment: row.enrollment, capacity: row.capacity }
  );
}

// ----- static world cache -----------------------------------------------------
// Cells, households and facilities only change through the seed reducers, which stamp
// config.worldStamp. Decoding 30,000 household rows was ~25% of a full recompute, so the converted
// objects are kept in module memory keyed by that stamp. Derived data only: if the runtime does not
// keep module state between calls, this simply misses and rebuilds.

interface StaticCell {
  cell: HexCell;
  households: Household[];
  facilities: Facility[];
}
let staticCache: { key: string; byHex: Map<string, StaticCell> } | null = null;

export function staticWorld(ctx: Ctx): Map<string, StaticCell> {
  const key = worldStampKey(ctx);
  if (staticCache && staticCache.key === key) return staticCache.byHex;
  const byHex = new Map<string, StaticCell>();
  for (const h of ctx.db.hex.iter()) byHex.set(h.hex, { cell: toHexCell(h), households: [], facilities: [] });
  for (const h of ctx.db.household.iter()) byHex.get(h.hex)?.households.push(toHousehold(h));
  for (const f of ctx.db.facility.iter()) byHex.get(f.hex)?.facilities.push(toFacility(f));
  staticCache = { key, byHex };
  return byHex;
}

// ----- gathering -------------------------------------------------------------

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

/** Signals for every household of one cell (static households from the cache + 4 event index scans). */
export function gatherCellSignals(ctx: Ctx, hexId: string, members?: Household[]): HouseholdSignals[] {
  const byId = new Map<string, HouseholdSignals>();
  for (const h of members ?? staticWorld(ctx).get(hexId)?.households ?? [])
    byId.set(h.id, { household: h, smsSentT: null, reply: null, claim: null, field: null });
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

/** Everything a recompute needs that does not depend on the cell. Build once per transaction. */
export interface RecomputePrep {
  params: ModelParams | null;
  estimator: CellEstimator;
  trust: SourceTrust;
  nowMin: number;
  world: WorldContext;
}

export function prepareRecompute(ctx: Ctx): RecomputePrep {
  const params = modelParams(ctx);
  return {
    params,
    estimator: activeEstimator(params),
    trust: currentTrust(ctx),
    nowMin: getReplay(ctx).simMinutes,
    world: worldCtxOf(ctx),
  };
}

/** World reference rates from every cell's persisted aggregate. */
export function currentWorldRefs(ctx: Ctx, world: WorldContext): WorldRefs {
  return engineWorldRefs(ctx.db.cellAgg.iter() as Iterable<RefsCounters>, world);
}

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

/** Recompute one cell. */
export function recomputeHex(ctx: Ctx, hexId: string, prep?: RecomputePrep) {
  recomputeCells(ctx, [hexId], prep);
}

/** Recompute a set of cells in three phases (see the file header). */
export function recomputeCells(ctx: Ctx, hexIds: Iterable<string>, prep: RecomputePrep = prepareRecompute(ctx)) {
  const { estimator } = prep;

  // Phase 1: aggregate each touched cell and persist its refs counters.
  const world = staticWorld(ctx);
  const prepared: PreparedCell[] = [];
  for (const hexId of hexIds) {
    const st = world.get(hexId);
    if (!st || !ctx.db.hexStats.hex.find(hexId)) continue;
    const input: CellInput = {
      cell: st.cell,
      households: gatherCellSignals(ctx, hexId, st.households),
      facilities: st.facilities,
      nowMin: prep.nowMin,
      world: prep.world,
      trust: prep.trust,
      params: prep.params,
    };
    const p = estimator.prepare(input);
    const counters = estimator.refsCounters(p);
    if (counters) {
      if (ctx.db.cellAgg.hex.find(hexId)) ctx.db.cellAgg.hex.update(counters);
      else ctx.db.cellAgg.insert(counters);
    }
    prepared.push(p);
  }
  if (prepared.length === 0) return;

  // Phase 2: world reference rates over all cells.
  const refs = estimator.needsRefs ? currentWorldRefs(ctx, prep.world) : null;

  // Phase 3: estimate and write.
  const m = getMetrics(ctx);
  let metricsDirty = m.engine !== estimator.name;
  let accountingDirty = false;
  m.engine = estimator.name;
  for (const p of prepared) {
    const hexId = p.input.cell.hex;
    const out = estimator.estimate(p, refs);
    const sigById = new Map(p.input.households.map((s) => [s.household.id, s]));
    const priorityNow = out.hex.priority;
    let accounted = 0, vulnerable = 0, unaccountedVulnerable = 0;
    const acct = new Map<string, { accounted: boolean; escalation: string }>();
    for (const e of out.households) {
      const s = sigById.get(e.householdId);
      const a = accountFor(s, e.pNeedsHelp, priorityNow, prep.nowMin);
      acct.set(e.householdId, a);
      if (a.accounted) accounted++;
      if (s && isVulnerable(s.household)) {
        vulnerable++;
        if (!a.accounted) unaccountedVulnerable++;
      }
    }

    // One index scan per cell instead of one primary-key lookup per household.
    const prevById = new Map<string, ReturnType<typeof ctx.db.householdEstimate.householdId.find>>();
    for (const r of ctx.db.householdEstimate.hex.filter(hexId)) prevById.set(r.householdId, r);
    for (const e of out.households) {
      const prev = prevById.get(e.householdId);
      const a = acct.get(e.householdId)!;
      const row = {
        householdId: e.householdId,
        hex: hexId,
        pSevere: e.pSevere,
        pNeedsHelp: e.pNeedsHelp,
        uncertainty: e.uncertainty,
        verified: e.verified,
        inspectScore: e.inspectScore,
        accounted: a.accounted,
        escalation: a.escalation,
        updatedAt: ctx.timestamp,
      };
      if (!prev) ctx.db.householdEstimate.insert(row);
      else if (
        changed(prev.pSevere, row.pSevere) ||
        changed(prev.pNeedsHelp, row.pNeedsHelp) ||
        changed(prev.uncertainty, row.uncertainty) ||
        changed(prev.inspectScore, row.inspectScore) ||
        prev.verified !== row.verified ||
        prev.accounted !== row.accounted ||
        prev.escalation !== row.escalation
      )
        ctx.db.householdEstimate.householdId.update(row);
    }

    const h = out.hex;
    writeCandidates(ctx, hexId, out.households.map((e) => ({ ...e, ...acct.get(e.householdId)! })), h.priority, h.verification);

    const stats = ctx.db.hexStats.hex.find(hexId)!;
    const reason = h.reason ?? '';
    const silenceCause = h.silenceCause ?? '';
    const hazard = h.hazard ?? 0;
    const priorityChanged = stats.priority !== h.priority || stats.verification !== h.verification;
    if (priorityChanged) {
      bumpPriority(m, stats.priority, stats.verification, -1);
      bumpPriority(m, h.priority, h.verification, 1);
      metricsDirty = true;
    }
    const unaccounted = out.households.length - accounted;
    const accountingChanged =
      stats.accounted !== accounted ||
      stats.unaccounted !== unaccounted ||
      stats.vulnerable !== vulnerable ||
      stats.unaccountedVulnerable !== unaccountedVulnerable;
    if (accountingChanged) accountingDirty = true;
    const material =
      priorityChanged ||
      accountingChanged ||
      stats.reason !== reason ||
      stats.silenceCause !== silenceCause ||
      changed(stats.hazard, hazard) ||
      changed(stats.severity, h.severity) ||
      changed(stats.confidence, h.confidence) ||
      changed(stats.silence, h.silence) ||
      changed(stats.expectedSevere, h.expectedSevere) ||
      changed(stats.maxPNeedsHelp, h.maxPNeedsHelp);
    if (!material) continue;
    ctx.db.hexStats.hex.update({
      ...stats,
      severity: h.severity,
      confidence: h.confidence,
      priority: h.priority,
      verification: h.verification,
      silence: h.silence,
      expectedSevere: h.expectedSevere,
      maxPNeedsHelp: h.maxPNeedsHelp,
      hazard,
      silenceCause,
      reason,
      accounted,
      unaccounted,
      vulnerable,
      unaccountedVulnerable,
      updatedAt: ctx.timestamp,
      updatedSimMinutes: prep.nowMin,
    });
  }
  if (accountingDirty) {
    // Totals over all cells (a few hundred rows), so full rebuilds and partial recomputes agree.
    let acc = 0, un = 0, vul = 0, unVul = 0;
    for (const s of ctx.db.hexStats.iter()) { acc += s.accounted; un += s.unaccounted; vul += s.vulnerable; unVul += s.unaccountedVulnerable; }
    m.accounted = acc;
    m.unaccounted = un;
    m.accountedRate = acc + un > 0 ? acc / (acc + un) : 0;
    m.vulnerable = vul;
    m.vulnerableAccounted = vul - unVul;
    m.vulnerableAccountedRate = vul > 0 ? (vul - unVul) / vul : 0;
    metricsDirty = true;
  }
  if (metricsDirty) {
    m.updatedAt = ctx.timestamp;
    ctx.db.metrics.id.update(m);
  }
}

/**
 * "No one overlooked": escalation ladder for a household we have not heard from yet.
 * Minutes are sim minutes since the outreach text (or since landfall when there is no phone on file).
 *   sms_sent (< 2 h) -> sms_resend (< 6 h) -> agent_call (< 12 h, or a low-risk P2 cell) -> field_visit
 * Heard from: 'emergency_referral' when they reported needing help and nobody has visited,
 * 'accounted' otherwise, 'verified' once an adjuster filed a field report.
 */
export const ESCALATION = ['sms_sent', 'sms_resend', 'agent_call', 'field_visit', 'emergency_referral', 'accounted', 'verified'] as const;

function accountFor(s: HouseholdSignals | undefined, pNeedsHelp: number, cellPriority: string, nowMin: number): { accounted: boolean; escalation: string } {
  if (!s) return { accounted: false, escalation: 'sms_sent' };
  if (s.field) return { accounted: true, escalation: 'verified' };
  if (s.reply || s.claim) {
    const needsHelp = s.reply?.safety === 'needs_help';
    return { accounted: true, escalation: needsHelp ? 'emergency_referral' : 'accounted' };
  }
  const since = nowMin - (s.smsSentT ?? 0);
  if (s.smsSentT !== null && since < 120) return { accounted: false, escalation: 'sms_sent' };
  if (s.smsSentT !== null && since < 360) return { accounted: false, escalation: 'sms_resend' };
  if (since < 720 || (cellPriority === 'P2' && pNeedsHelp < 0.2)) return { accounted: false, escalation: 'agent_call' };
  return { accounted: false, escalation: 'field_visit' };
}

function isVulnerable(h: HouseholdSignals['household']): boolean {
  return !!(h.age75 || h.disability || h.noVehicle || h.limitedEnglish || h.medicalDevice || (h.age65 && h.livesAlone));
}

/** Keep the cell's top-INSPECT_PER_CELL unverified households in inspection_candidate. */
function writeCandidates(
  ctx: Ctx,
  hexId: string,
  households: { householdId: string; verified: boolean; inspectScore: number; pSevere: number; pNeedsHelp: number; uncertainty: number; accounted: boolean; escalation: string }[],
  cellPriority: string,
  cellVerification: string
) {
  const top = households
    .filter(e => !e.verified)
    .sort((a, b) => b.inspectScore - a.inspectScore || (a.householdId < b.householdId ? -1 : 1))
    .slice(0, INSPECT_PER_CELL);
  const existing = [...ctx.db.inspectionCandidate.hex.filter(hexId)];
  const same =
    existing.length === top.length &&
    top.every((e, i) => {
      const x = existing.find(r => r.householdId === e.householdId);
      return (
        x &&
        x.rank === i + 1 &&
        !changed(x.inspectScore, e.inspectScore) &&
        !changed(x.pSevere, e.pSevere) &&
        !changed(x.pNeedsHelp, e.pNeedsHelp) &&
        x.cellPriority === cellPriority &&
        x.cellVerification === cellVerification &&
        x.accounted === e.accounted &&
        x.escalation === e.escalation
      );
    });
  if (same) return;
  for (const x of existing) ctx.db.inspectionCandidate.householdId.delete(x.householdId);
  top.forEach((e, i) =>
    ctx.db.inspectionCandidate.insert({
      householdId: e.householdId,
      hex: hexId,
      rank: i + 1,
      inspectScore: e.inspectScore,
      pSevere: e.pSevere,
      pNeedsHelp: e.pNeedsHelp,
      uncertainty: e.uncertainty,
      cellPriority,
      cellVerification,
      accounted: e.accounted,
      escalation: e.escalation,
    })
  );
}
