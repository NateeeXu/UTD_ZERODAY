// Singleton accessors and permission helpers shared by all reducers.
import { SenderError } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';
import type { Ctx } from './schema';
import { DEFAULT_TRUST } from './fusion/trust';

export const SINGLETON = 0;
export const MAX_MINUTES = 4320;

export type Role = 'manager' | 'adjuster' | 'policyholder_demo';
export const ROLES: readonly Role[] = ['manager', 'adjuster', 'policyholder_demo'];

// ----- singletons -----------------------------------------------------------

export function getReplay(ctx: Ctx) {
  const row = ctx.db.replayState.id.find(SINGLETON);
  if (row) return row;
  return ctx.db.replayState.insert({
    id: SINGLETON,
    running: false,
    simMinutes: 0,
    speed: 30,
    nextSeq: 0,
    totalStaged: 0,
    maxMinutes: MAX_MINUTES,
    lastTickAt: ctx.timestamp,
  });
}

export function getMetrics(ctx: Ctx) {
  const row = ctx.db.metrics.id.find(SINGLETON);
  if (row) return row;
  return ctx.db.metrics.insert({
    id: SINGLETON,
    hexes: 0,
    households: 0,
    smsSent: 0,
    smsReplies: 0,
    helpReplies: 0,
    claims: 0,
    fieldReports: 0,
    verifiedHouseholds: 0,
    verifiedCoverage: 0,
    p0Cells: 0,
    p1Cells: 0,
    p2Cells: 0,
    needsVerificationCells: 0,
    holdoutN: 0,
    holdoutBrierSevere: 0,
    holdoutBrierHelp: 0,
    holdoutSevereRecall: 0,
    holdoutSimMinutes: 0,
    trustHazard: DEFAULT_TRUST.hazard,
    trustSms: DEFAULT_TRUST.sms,
    trustClaims: DEFAULT_TRUST.claims,
    trustUpdates: 0,
    modelVersion: 0,
    engine: 'stub',
    updatedAt: ctx.timestamp,
  });
}

export function getModelState(ctx: Ctx) {
  const row = ctx.db.modelState.id.find(SINGLETON);
  if (row) return row;
  return ctx.db.modelState.insert({
    id: SINGLETON,
    loaded: false,
    version: 0,
    paramsJson: '',
    baseTrustHazard: DEFAULT_TRUST.hazard,
    baseTrustSms: DEFAULT_TRUST.sms,
    baseTrustClaims: DEFAULT_TRUST.claims,
    ...freshLearning(DEFAULT_TRUST),
    updatedAt: ctx.timestamp,
  });
}

/** Learning-loop columns of model_state reset to a given starting trust. */
export function freshLearning(trust: { hazard: number; sms: number; claims: number }) {
  return {
    trustHazard: trust.hazard,
    trustSms: trust.sms,
    trustClaims: trust.claims,
    trustUpdates: 0,
    lastScoreHazard: -1,
    lastScoreSms: -1,
    lastScoreClaims: -1,
    pendingFieldReports: 0,
    pendingHazardSse: 0,
    pendingHazardN: 0,
    pendingSmsSse: 0,
    pendingSmsN: 0,
    pendingClaimsSse: 0,
    pendingClaimsN: 0,
    holdoutReports: 0,
  };
}

export function ensureSingletons(ctx: Ctx) {
  getReplay(ctx);
  getMetrics(ctx);
  getModelState(ctx);
}

/** Current sim time as a whole minute (used as `t` for events submitted live). */
export function simNow(ctx: Ctx): number {
  return Math.floor(getReplay(ctx).simMinutes);
}

export function microsBetween(a: Timestamp, b: Timestamp): number {
  return Number(b.microsSinceUnixEpoch - a.microsSinceUnixEpoch);
}

// ----- permissions ----------------------------------------------------------

export function isOwner(ctx: Ctx): boolean {
  const cfg = ctx.db.config.id.find(SINGLETON);
  return !!cfg && cfg.owner.equals(ctx.sender);
}

export function requireOwner(ctx: Ctx) {
  if (!isOwner(ctx)) throw new SenderError('owner only');
}

export function memberOf(ctx: Ctx) {
  return ctx.db.member.identity.find(ctx.sender) ?? null;
}

/** Manager role, or the module owner (so the CLI / seed script can drive the replay). */
export function requireManager(ctx: Ctx) {
  if (isOwner(ctx)) return;
  if (memberOf(ctx)?.role !== 'manager') throw new SenderError('manager role required');
}

export function requireAdjuster(ctx: Ctx) {
  const m = memberOf(ctx);
  if (!m || m.role !== 'adjuster') throw new SenderError('only adjusters can submit field reports');
  return m;
}
