// The single ingest path. Every event (replayed from data/live.json, an SMS reply from the
// policyholder page, an adjuster's field report) goes through onEvent, which:
//   1. inserts the event row,
//   2. updates the cell's hex_stats counters and the global metrics incrementally,
//   3. calls recomputeHex (immediately, or once per cell at the end of a batch, see IngestBatch).
import { SenderError } from 'spacetimedb/server';
import type { Ctx } from './schema';
import { freshLearning, getMetrics, getModelState, getReplay, worldCtxOf } from './state';
import { gatherHouseholdSignals, recomputeCells, recomputeHex, toHexCell } from './fusion';
import { batchScores, DEFAULT_TRUST, nextTrust, sourceOpinions, TRUST_BATCH } from './fusion/trust';
import type { Damage, Peril, Safety } from './fusion/contract';

export type IngestEvent =
  | { kind: 'sms_sent'; t: number; householdId: string }
  | {
      kind: 'sms_reply';
      t: number;
      householdId: string;
      safety: 'safe' | 'needs_help';
      damage: Damage;
      text?: string; // free-text reply (already parsed into safety/damage)
      language?: string;
    }
  | { kind: 'claim'; t: number; householdId: string; peril: Peril; reportedDamage: Damage }
  | {
      kind: 'field_report';
      t: number;
      householdId: string;
      adjusterId: string;
      safety: Safety;
      damage: Damage;
      note: string;
    };

export type Source = 'replay' | 'live';

function any(it: Iterable<unknown>): boolean {
  for (const _ of it) return true;
  return false;
}

export function emptyStats(ctx: Ctx, hexId: string, displayOrder: number) {
  return {
    hex: hexId,
    displayOrder,
    households: 0,
    phones: 0,
    smsSent: 0,
    smsReplies: 0,
    replyRate: 0,
    severeReplies: 0,
    helpReplies: 0,
    claims: 0,
    fieldReports: 0,
    verifiedHouseholds: 0,
    severity: 0,
    confidence: 0,
    priority: '',
    verification: '',
    silence: 0,
    expectedSevere: 0,
    maxPNeedsHelp: 0,
    hazard: 0,
    silenceCause: '',
    reason: '',
    accounted: 0,
    unaccounted: 0,
    vulnerable: 0,
    unaccountedVulnerable: 0,
    updatedAt: ctx.timestamp,
    updatedSimMinutes: 0,
  };
}

type StatsRow = NonNullable<ReturnType<Ctx['db']['hexStats']['hex']['find']>>;
type MetricsRow = ReturnType<typeof getMetrics>;

/**
 * Many events in one transaction (replay tick, jump): the metrics row and each touched cell's
 * hex_stats row are updated in memory per event and written once by flushBatch, which then
 * recomputes every touched cell once.
 */
export interface IngestBatch {
  metrics: MetricsRow;
  stats: Map<string, StatsRow>;
}

export function newBatch(ctx: Ctx): IngestBatch {
  return { metrics: getMetrics(ctx), stats: new Map() };
}

export function flushBatch(ctx: Ctx, batch: IngestBatch) {
  for (const s of batch.stats.values()) ctx.db.hexStats.hex.update(s);
  batch.metrics.updatedAt = ctx.timestamp;
  ctx.db.metrics.id.update(batch.metrics);
  if (batch.stats.size > 0) recomputeCells(ctx, [...batch.stats.keys()]);
}

/**
 * Insert one event, update counters incrementally, recompute the cell.
 * With `batch`, counter rows stay in memory and the recompute is deferred to flushBatch.
 * Throws SenderError for an unknown household before writing anything.
 */
export function onEvent(ctx: Ctx, ev: IngestEvent, source: Source, batch?: IngestBatch): string {
  const hh = ctx.db.household.id.find(ev.householdId);
  if (!hh) throw new SenderError(`unknown household ${ev.householdId}`);
  const stats = batch?.stats.get(hh.hex) ?? ctx.db.hexStats.hex.find(hh.hex);
  if (!stats) throw new SenderError(`unknown hex ${hh.hex}`);
  const m = batch?.metrics ?? getMetrics(ctx);
  const base = {
    id: 0n,
    householdId: hh.id,
    hex: hh.hex,
    t: Math.max(0, Math.floor(ev.t)),
    source,
    ingestedBy: ctx.sender,
    ingestedAt: ctx.timestamp,
  };

  const markSent = () => {
    if (!any(ctx.db.smsSent.householdId.filter(hh.id))) {
      stats.smsSent += 1;
      m.smsSent += 1;
    }
  };

  switch (ev.kind) {
    case 'sms_sent': {
      markSent();
      ctx.db.smsSent.insert(base);
      break;
    }
    case 'sms_reply': {
      // A reply from the live policyholder page may arrive for a household we never texted in the
      // replay; record the text too so replyRate stays <= 1.
      if (!any(ctx.db.smsSent.householdId.filter(hh.id))) {
        markSent();
        ctx.db.smsSent.insert(base);
      }
      if (!any(ctx.db.smsReply.householdId.filter(hh.id))) {
        stats.smsReplies += 1;
        m.smsReplies += 1;
      }
      ctx.db.smsReply.insert({
        ...base,
        safety: ev.safety,
        damage: ev.damage,
        text: ev.text || undefined,
        language: ev.language || undefined,
      });
      if (ev.damage >= 2) stats.severeReplies += 1;
      if (ev.safety === 'needs_help') {
        stats.helpReplies += 1;
        m.helpReplies += 1;
      }
      break;
    }
    case 'claim': {
      ctx.db.claim.insert({ ...base, peril: ev.peril, reportedDamage: ev.reportedDamage });
      stats.claims += 1;
      m.claims += 1;
      break;
    }
    case 'field_report': {
      const learned = accumulateTrust(ctx, hh, ev.damage);
      if (learned) {
        m.trustHazard = learned.trust.hazard;
        m.trustSms = learned.trust.sms;
        m.trustClaims = learned.trust.claims;
        m.trustUpdates = learned.updates;
      }
      if (!any(ctx.db.fieldReport.householdId.filter(hh.id))) {
        stats.verifiedHouseholds += 1;
        m.verifiedHouseholds += 1;
      }
      ctx.db.fieldReport.insert({
        ...base,
        adjusterId: ev.adjusterId,
        safety: ev.safety,
        damage: ev.damage,
        note: ev.note,
      });
      stats.fieldReports += 1;
      m.fieldReports += 1;
      break;
    }
  }

  stats.replyRate = stats.smsSent > 0 ? stats.smsReplies / stats.smsSent : 0;
  m.verifiedCoverage = m.households > 0 ? m.verifiedHouseholds / m.households : 0;
  if (batch) {
    batch.stats.set(hh.hex, stats);
    return hh.hex;
  }
  ctx.db.hexStats.hex.update(stats);
  m.updatedAt = ctx.timestamp;
  ctx.db.metrics.id.update(m);
  recomputeHex(ctx, hh.hex);
  return hh.hex;
}

/**
 * Learning loop (engine rules): record each source's opinion vs. the adjuster's finding; every
 * TRUST_BATCH non-holdout reports, move trust one capped step toward 1 - Brier. Holdout reports
 * only update their own household and cell (never trust).
 */
function accumulateTrust(
  ctx: Ctx,
  hh: NonNullable<ReturnType<Ctx['db']['household']['id']['find']>>,
  reportedDamage: number
): { trust: { hazard: number; sms: number; claims: number }; updates: number } | null {
  const cellRow = ctx.db.hex.hex.find(hh.hex);
  if (!cellRow) return null;
  const ms = getModelState(ctx);
  ms.updatedAt = ctx.timestamp;
  if (hh.holdout) {
    ms.holdoutReports += 1;
    ctx.db.modelState.id.update(ms);
    return null;
  }
  let learned: { trust: { hazard: number; sms: number; claims: number }; updates: number } | null = null;
  const y = reportedDamage >= 2 ? 1 : 0;
  const op = sourceOpinions(toHexCell(cellRow), gatherHouseholdSignals(ctx, hh));
  ms.pendingFieldReports += 1;
  ms.pendingHazardSse += (op.hazard - y) ** 2;
  ms.pendingHazardN += 1;
  if (op.sms !== null) {
    ms.pendingSmsSse += (op.sms - y) ** 2;
    ms.pendingSmsN += 1;
  }
  if (op.claims !== null) {
    ms.pendingClaimsSse += (op.claims - y) ** 2;
    ms.pendingClaimsN += 1;
  }
  if (ms.pendingFieldReports >= TRUST_BATCH) {
    const scores = batchScores({
      hazardSse: ms.pendingHazardSse,
      hazardN: ms.pendingHazardN,
      smsSse: ms.pendingSmsSse,
      smsN: ms.pendingSmsN,
      claimsSse: ms.pendingClaimsSse,
      claimsN: ms.pendingClaimsN,
    });
    const next = nextTrust({ hazard: ms.trustHazard, sms: ms.trustSms, claims: ms.trustClaims }, scores);
    const updates = ms.trustUpdates + 1;
    Object.assign(ms, freshLearning(next), {
      trustUpdates: updates,
      holdoutReports: ms.holdoutReports,
      lastScoreHazard: scores.hazard ?? -1,
      lastScoreSms: scores.sms ?? -1,
      lastScoreClaims: scores.claims ?? -1,
    });
    learned = { trust: next, updates }; // the caller (onEvent) writes these into metrics
    console.info(
      `source trust update #${updates}: hazard ${next.hazard.toFixed(3)} sms ${next.sms.toFixed(3)} claims ${next.claims.toFixed(3)}`
    );
  }
  ctx.db.modelState.id.update(ms);
  return learned;
}

// ----- full rebuilds (seeding, reset, repair) --------------------------------

/** Recount every hex_stats counter and global total from the tables, then recompute every cell. */
export function rebuildAll(ctx: Ctx) {
  const m = getMetrics(ctx);
  const byHex = new Map<string, ReturnType<typeof emptyStats>>();
  for (const h of ctx.db.hex.iter()) {
    const prev = ctx.db.hexStats.hex.find(h.hex);
    const s = emptyStats(ctx, h.hex, h.displayOrder);
    if (prev) {
      s.priority = prev.priority;
      s.verification = prev.verification;
    }
    byHex.set(h.hex, s);
  }
  // Drop stats rows for cells that no longer exist.
  for (const s of [...ctx.db.hexStats.iter()]) if (!byHex.has(s.hex)) ctx.db.hexStats.hex.delete(s.hex);

  let households = 0;
  for (const h of ctx.db.household.iter()) {
    const s = byHex.get(h.hex);
    if (!s) continue;
    households++;
    s.households++;
    if (h.phoneOnFile) s.phones++;
  }

  const sentHH = new Set<string>();
  for (const e of ctx.db.smsSent.iter()) {
    if (sentHH.has(e.householdId)) continue;
    sentHH.add(e.householdId);
    const s = byHex.get(e.hex);
    if (s) s.smsSent++;
  }
  const repliedHH = new Set<string>();
  let helpReplies = 0;
  for (const e of ctx.db.smsReply.iter()) {
    const s = byHex.get(e.hex);
    if (e.safety === 'needs_help') helpReplies++;
    if (!s) continue;
    if (e.damage >= 2) s.severeReplies++;
    if (e.safety === 'needs_help') s.helpReplies++;
    if (!repliedHH.has(e.householdId)) {
      repliedHH.add(e.householdId);
      s.smsReplies++;
    }
  }
  let claims = 0;
  for (const e of ctx.db.claim.iter()) {
    claims++;
    const s = byHex.get(e.hex);
    if (s) s.claims++;
  }
  let fieldReports = 0;
  const verifiedHH = new Set<string>();
  for (const e of ctx.db.fieldReport.iter()) {
    fieldReports++;
    const s = byHex.get(e.hex);
    if (!s) continue;
    s.fieldReports++;
    if (!verifiedHH.has(e.householdId)) {
      verifiedHH.add(e.householdId);
      s.verifiedHouseholds++;
    }
  }

  for (const s of byHex.values()) {
    s.replyRate = s.smsSent > 0 ? s.smsReplies / s.smsSent : 0;
    if (ctx.db.hexStats.hex.find(s.hex)) ctx.db.hexStats.hex.update(s);
    else ctx.db.hexStats.insert(s);
  }

  m.hexes = byHex.size;
  m.households = households;
  m.smsSent = sentHH.size;
  m.smsReplies = repliedHH.size;
  m.helpReplies = helpReplies;
  m.claims = claims;
  m.fieldReports = fieldReports;
  m.verifiedHouseholds = verifiedHH.size;
  m.verifiedCoverage = households > 0 ? verifiedHH.size / households : 0;
  m.updatedAt = ctx.timestamp;
  ctx.db.metrics.id.update(m);

  recomputeCells(ctx, [...byHex.keys()]);
  recountPriorities(ctx);
  refreshHoldoutMetrics(ctx);
}

/** Full recount of the P0/P1/P2/needs_verification cell totals. */
export function recountPriorities(ctx: Ctx) {
  const m = getMetrics(ctx);
  m.p0Cells = m.p1Cells = m.p2Cells = m.needsVerificationCells = 0;
  for (const s of ctx.db.hexStats.iter()) {
    if (s.priority === 'P0') m.p0Cells++;
    else if (s.priority === 'P1') m.p1Cells++;
    else if (s.priority === 'P2') m.p2Cells++;
    if (s.priority && s.verification === 'needs_verification') m.needsVerificationCells++;
  }
  ctx.db.metrics.id.update(m);
}

/** Score current estimates against private truth on the holdout households (never trained on). */
export function refreshHoldoutMetrics(ctx: Ctx) {
  let n = 0;
  let brierSevere = 0;
  let brierHelp = 0;
  let severeN = 0;
  let severeCaught = 0;
  for (const h of ctx.db.household.holdout.filter(true)) {
    const truth = ctx.db.simTruth.householdId.find(h.id);
    const est = ctx.db.householdEstimate.householdId.find(h.id);
    if (!truth || !est) continue;
    const ySevere = truth.damage >= 2 ? 1 : 0;
    const yHelp = truth.safety === 'needs_help' ? 1 : 0;
    n++;
    brierSevere += (est.pSevere - ySevere) ** 2;
    brierHelp += (est.pNeedsHelp - yHelp) ** 2;
    if (ySevere) {
      severeN++;
      if (est.pSevere >= 0.5) severeCaught++;
    }
  }
  const m = getMetrics(ctx);
  m.holdoutN = n;
  m.holdoutBrierSevere = n ? brierSevere / n : 0;
  m.holdoutBrierHelp = n ? brierHelp / n : 0;
  m.holdoutSevereRecall = severeN ? severeCaught / severeN : 0;
  m.holdoutSimMinutes = getReplay(ctx).simMinutes;
  m.updatedAt = ctx.timestamp;
  ctx.db.metrics.id.update(m);
}

/** Delete every event, estimate and assignment; rewind the replay clock to t = 0. */
export function clearDemoState(ctx: Ctx) {
  ctx.db.smsSent.clear();
  ctx.db.smsReply.clear();
  ctx.db.claim.clear();
  ctx.db.fieldReport.clear();
  ctx.db.assignment.clear();
  ctx.db.householdEstimate.clear();
  ctx.db.inspectionCandidate.clear();
  ctx.db.replayTick.clear();

  const rs = getReplay(ctx);
  rs.running = false;
  rs.simMinutes = 0;
  rs.nextSeq = 0;
  rs.totalStaged = Number(ctx.db.stagedEvent.count());
  rs.lastTickAt = ctx.timestamp;
  rs.lastFullRecomputeMin = 0;
  rs.maxMinutes = worldCtxOf(ctx).horizonMinutes;
  ctx.db.replayState.id.update(rs);

  // Trust learning restarts from the model's calibrated values (or defaults).
  const ms = getModelState(ctx);
  const base = baseTrust(ms.paramsJson);
  ctx.db.modelState.id.update({
    ...ms,
    baseTrustHazard: base.hazard,
    baseTrustSms: base.sms,
    baseTrustClaims: base.claims,
    ...freshLearning(base),
    updatedAt: ctx.timestamp,
  });

  const m = getMetrics(ctx);
  m.trustHazard = base.hazard;
  m.trustSms = base.sms;
  m.trustClaims = base.claims;
  m.trustUpdates = 0;
  m.modelVersion = ms.loaded ? ms.version : 0;
  m.holdoutN = 0;
  ctx.db.metrics.id.update(m);
}

export function baseTrust(paramsJson: string) {
  try {
    const p = paramsJson ? JSON.parse(paramsJson) : null;
    if (p && p.sourceTrust) {
      const ok = (x: unknown) => typeof x === 'number' && x >= 0 && x <= 1;
      if (ok(p.sourceTrust.hazard) && ok(p.sourceTrust.sms) && ok(p.sourceTrust.claims))
        return { hazard: p.sourceTrust.hazard, sms: p.sourceTrust.sms, claims: p.sourceTrust.claims };
    }
  } catch {
    // fall through to defaults
  }
  return { ...DEFAULT_TRUST };
}
