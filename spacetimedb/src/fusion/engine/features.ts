// COPIED from engine/src/features.ts by spacetimedb/scripts/sync-engine.ts. Do not edit here; edit engine/src and re-sync.
// Feature construction (v2: hazard-agnostic).
//
// A Snapshot is everything the engine is allowed to know at time t: the world
// (static) plus every event with event.t <= t. Truth never enters here.
// From a snapshot we derive a fixed, named feature vector per household.
// FEATURE_NAMES is the single source of truth for the order; ModelParams.features
// stores the same names so weights can be aligned by name, never by position.
//
// Hazard: HexCell.hazardIndex (0-1, same meaning for hurricanes and quakes)
// when present, else the v1 wind/flood formula (Harbor Bend data).
// Expected baselines used by the silence score are conditioned on what the
// data says about each household: insurance coverage and policy type for
// claims, limited English and being away from home for SMS replies.

import type { Facility, HazardType, HexCell, HexId, Household, Peril, Safety, SimEvent, World, Damage } from '../contract.ts';
import type { TriageConfig } from './config.ts';
import { clamp, clamp01 } from './config.ts';

export const FEATURE_NAMES = [
  // --- hazard / map layer (source: hazard) ---
  'windNorm',
  'floodNorm',
  'hazardIndex',
  'liquefaction',
  'outage',
  'analystZone',
  'floodNoPolicy',
  'uncoveredHazard',
  'mobileHomeHazard',
  // --- static household attributes (source: static) ---
  'age65',
  'livesAlone',
  'medicalDevice',
  'age65Alone',
  'medicalDeviceOutage',
  'age75',
  'disability',
  'noVehicle',
  'limitedEnglish',
  'mobileHome',
  'childrenUnder18',
  'awayDaytime',
  'awayNow',
  'renter',
  'collegeStudent',
  'schoolAgeChildren',
  'schoolHours',
  'schoolHoursChildren',
  'timeNorm',
  // --- own SMS signal (source: sms) ---
  'smsReplied',
  'smsReplyDamage',
  'smsReplyDamageUnknown',
  'smsReplyNeedsHelp',
  'smsNoReply',
  'smsNoReplyOutage',
  'smsNoReplyLowOutageTime',
  'smsNoReplyLimitedEnglish',
  'smsNoReplyAway',
  // --- cell-level SMS aggregates, excluding the household itself (source: sms) ---
  'cellSevereReplyShare',
  'cellHelpReplyShare',
  'cellReplyRate',
  // --- own claim signal (source: claims) ---
  'claimFiled',
  'claimDamage',
  // --- cell-level claim aggregates, excluding the household itself (source: claims) ---
  'cellClaimRate',
  'cellClaimLogRatio',
  'cellClaimSevereShare',
] as const;
// Neighbours' field reports are deliberately NOT features: in backtests they
// are sampled at random, but live they are chosen by active inspection, so a
// learned weight would overstate them. They enter through the explicit
// residual update in infer.ts instead.

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type SourceGroup = 'hazard' | 'static' | 'sms' | 'claims';

export const FEATURE_SOURCE: Record<FeatureName, SourceGroup> = {
  windNorm: 'hazard',
  floodNorm: 'hazard',
  hazardIndex: 'hazard',
  liquefaction: 'hazard',
  outage: 'hazard',
  analystZone: 'hazard',
  floodNoPolicy: 'hazard',
  uncoveredHazard: 'hazard',
  mobileHomeHazard: 'hazard',
  age65: 'static',
  livesAlone: 'static',
  medicalDevice: 'static',
  age65Alone: 'static',
  medicalDeviceOutage: 'static',
  age75: 'static',
  disability: 'static',
  noVehicle: 'static',
  limitedEnglish: 'static',
  mobileHome: 'static',
  childrenUnder18: 'static',
  awayDaytime: 'static',
  awayNow: 'static',
  renter: 'static',
  collegeStudent: 'static',
  schoolAgeChildren: 'static',
  schoolHours: 'static',
  schoolHoursChildren: 'static',
  timeNorm: 'static',
  smsReplied: 'sms',
  smsReplyDamage: 'sms',
  smsReplyDamageUnknown: 'sms',
  smsReplyNeedsHelp: 'sms',
  smsNoReply: 'sms',
  smsNoReplyOutage: 'sms',
  smsNoReplyLowOutageTime: 'sms',
  smsNoReplyLimitedEnglish: 'sms',
  smsNoReplyAway: 'sms',
  cellSevereReplyShare: 'sms',
  cellHelpReplyShare: 'sms',
  cellReplyRate: 'sms',
  claimFiled: 'claims',
  claimDamage: 'claims',
  cellClaimRate: 'claims',
  cellClaimLogRatio: 'claims',
  cellClaimSevereShare: 'claims',
};

/** Features available before any SMS reply or claim exists: the "maps + policy file" baseline. */
export const HAZARD_BASELINE_FEATURES: FeatureName[] = FEATURE_NAMES.filter(
  (n) => FEATURE_SOURCE[n] === 'hazard' || FEATURE_SOURCE[n] === 'static',
);

// ---------------------------------------------------------------------------
// World context: hazard type, event time of day, horizon.
// ---------------------------------------------------------------------------

export interface WorldContext {
  hazardType: HazardType;
  horizonMinutes: number;
  /** Local hour (0-23) of the event. */
  localHour: number;
  weekday: boolean;
  /** Weekday working hours: awayDaytime households are not at home. */
  daytime: boolean;
  /** Weekday school hours: school-age children are at school. */
  schoolHours: boolean;
  /** Where localHour/weekday came from: 'world' (eventLocalHour/eventWeekday) or 'landfallIso'. */
  timeSource: 'world' | 'landfallIso';
}

/** Standard UTC offsets (hours) by region prefix; the fictional Harbor Bend is in Texas. */
function regionStandardOffsetHours(region: string | undefined): number {
  if (region && region.startsWith('ca-')) return -8;
  return -6;
}

/** nth (1-based) Sunday of a month, as day of month, in UTC calendar terms. */
function nthSundayUtc(year: number, month0: number, n: number): number {
  const first = new Date(Date.UTC(year, month0, 1)).getUTCDay(); // 0 = Sunday
  const firstSunday = 1 + ((7 - first) % 7);
  return firstSunday + 7 * (n - 1);
}

/** US daylight saving time: 2:00 second Sunday of March to 2:00 first Sunday of November (local). */
export function usDstActive(utcMs: number, stdOffsetHours: number): boolean {
  const year = new Date(utcMs).getUTCFullYear();
  const start = Date.UTC(year, 2, nthSundayUtc(year, 2, 2), 2 - stdOffsetHours);
  const end = Date.UTC(year, 10, nthSundayUtc(year, 10, 1), 2 - (stdOffsetHours + 1));
  return utcMs >= start && utcMs < end;
}

/** Local hour and weekday derived from an ISO timestamp and a region's US time zone (pure; no host time zone). */
export function localTimeFromIso(iso: string, region: string | undefined): { hour: number; weekday: boolean } | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const std = regionStandardOffsetHours(region);
  const offset = std + (usDstActive(ms, std) ? 1 : 0);
  const local = new Date(ms + offset * 3600_000);
  const dow = local.getUTCDay();
  return { hour: local.getUTCHours(), weekday: dow >= 1 && dow <= 5 };
}

/**
 * Derive the world context. awayDaytime only matters when the event happens
 * in weekday working hours (the simulator's `daytime` flag). World.eventLocalHour /
 * eventWeekday are used when present; otherwise both are derived from
 * landfallIso in the region's time zone, which reproduces the simulator's
 * scenario flags (CA live 16:18 Fri and CA backtest-2 12:05 Thu are daytime;
 * every hurricane and the other quakes happen at night).
 */
export function worldContext(world: World, cfg: TriageConfig): WorldContext {
  const hazardType: HazardType = world.hazardType ?? 'hurricane';
  const horizonMinutes = world.horizonMinutes ?? cfg.horizonMinutes;
  let localHour: number;
  let weekday: boolean;
  let timeSource: WorldContext['timeSource'];
  if (typeof world.eventLocalHour === 'number' && Number.isFinite(world.eventLocalHour)) {
    localHour = world.eventLocalHour;
    const derived = localTimeFromIso(world.landfallIso, world.region);
    weekday = typeof world.eventWeekday === 'boolean' ? world.eventWeekday : (derived?.weekday ?? false);
    timeSource = 'world';
  } else {
    const derived = localTimeFromIso(world.landfallIso, world.region);
    localHour = derived ? derived.hour : 0;
    weekday = typeof world.eventWeekday === 'boolean' ? world.eventWeekday : (derived?.weekday ?? false);
    timeSource = 'landfallIso';
  }
  const dt = cfg.daytime;
  const daytime = weekday && localHour >= dt.workStartHour && localHour < dt.workEndHour;
  const schoolHours = weekday && localHour >= dt.schoolStartHour && localHour <= dt.schoolEndHour;
  return { hazardType, horizonMinutes, localHour, weekday, daytime, schoolHours, timeSource };
}

// ---------------------------------------------------------------------------
// Hazard score and per-household traits.
// ---------------------------------------------------------------------------

export function windNorm(cell: HexCell, cfg: TriageConfig): number {
  const { windMinMph, windMaxMph } = cfg.hazard;
  return clamp01((cell.windMph - windMinMph) / (windMaxMph - windMinMph));
}

export function floodNorm(cell: HexCell, cfg: TriageConfig): number {
  if (!(cell.floodDepthFt > 0)) return 0;
  return clamp01(1 - Math.exp(-cell.floodDepthFt / cfg.hazard.floodScaleFt));
}

export function hasHazardIndex(cell: HexCell): boolean {
  return typeof cell.hazardIndex === 'number' && Number.isFinite(cell.hazardIndex);
}

/** 0-1 hazard score: HexCell.hazardIndex when present, else the v1 wind/flood/zone formula. */
export function hazardScore(cell: HexCell, cfg: TriageConfig): number {
  if (hasHazardIndex(cell)) return clamp01(cell.hazardIndex as number);
  const intensity = Math.max(windNorm(cell, cfg), floodNorm(cell, cfg));
  return clamp01(cfg.hazard.intensityWeight * intensity + cfg.hazard.zoneWeight * (cell.analystZone / 2));
}

export function liquefactionOf(cell: HexCell): number {
  return typeof cell.liquefaction === 'number' && Number.isFinite(cell.liquefaction) ? clamp01(cell.liquefaction) : 0;
}

/** Household attributes resolved against the world context (optional fields -> 0/false when absent). */
export interface HouseholdTraits {
  /** Share of the cell's hazard that is NOT insured (0 = fully covered, 1 = uninsured). */
  uncoveredShare: number;
  /** Multiplier on expected claims from coverage alone (uninsured -> cfg.coverage.uninsuredClaimFactor). */
  coverageFactor: number;
  renter: boolean;
  limitedEnglish: boolean;
  awayDaytime: boolean;
  /** awayDaytime during a weekday working-hours event. */
  awayNow: boolean;
  /** CMIST-vulnerable: age75, disability, noVehicle, medicalDevice or livesAlone. */
  vulnerable: boolean;
  age75: boolean;
  disability: boolean;
  noVehicle: boolean;
  mobileHome: boolean;
  childrenUnder18: boolean;
  collegeStudent: boolean;
  schoolAgeChildren: number;
}

export function householdTraits(h: Household, cell: HexCell, ctx: WorldContext, cfg: TriageConfig): HouseholdTraits {
  const uf = cfg.coverage.uninsuredClaimFactor;
  let uncoveredShare: number;
  if (ctx.hazardType === 'earthquake') {
    uncoveredShare = h.earthquakeEndorsement ? 0 : 1;
  } else {
    const w = windNorm(cell, cfg);
    const f = floodNorm(cell, cfg);
    const sum = w + f;
    const wWind = sum > 0 ? w / sum : 1;
    const wFlood = sum > 0 ? f / sum : 0;
    uncoveredShare = wWind * (h.windCovered ? 0 : 1) + wFlood * (h.floodPolicy ? 0 : 1);
  }
  const coverageFactor = (1 - uncoveredShare) + uncoveredShare * uf;
  const awayDaytime = h.awayDaytime === true;
  const age75 = h.age75 === true;
  const disability = h.disability === true;
  const noVehicle = h.noVehicle === true;
  return {
    uncoveredShare,
    coverageFactor,
    renter: h.policyType === 'renters',
    limitedEnglish: h.limitedEnglish === true,
    awayDaytime,
    awayNow: awayDaytime && ctx.daytime,
    vulnerable: age75 || disability || noVehicle || h.medicalDevice || h.livesAlone,
    age75,
    disability,
    noVehicle,
    mobileHome: h.mobileHome === true,
    childrenUnder18: h.childrenUnder18 === true,
    collegeStudent: h.collegeStudent === true,
    schoolAgeChildren: typeof h.schoolAgeChildren === 'number' && h.schoolAgeChildren > 0 ? h.schoolAgeChildren : 0,
  };
}

// ---------------------------------------------------------------------------
// Signals, aggregates, references.
// ---------------------------------------------------------------------------

export interface ReplySignal {
  t: number;
  safety: 'safe' | 'needs_help';
  /** null = the reply does not describe the home (e.g. the person is not there) */
  damage: Damage | null;
}
export interface ClaimSignal {
  t: number;
  peril: Peril;
  reportedDamage: Damage;
}
export interface FieldSignal {
  t: number;
  adjusterId: string;
  safety: Safety;
  damage: Damage;
}

/** Everything observed for one household up to the snapshot time (structured fields only; free text is ignored). */
export interface HouseholdSignals {
  smsSent: number;
  firstSmsT: number | null;
  /** Latest reply at or before t (later t wins; ties: later in the event list wins). */
  reply: ReplySignal | null;
  replies: number;
  claim: ClaimSignal | null;
  claims: number;
  fieldReport: FieldSignal | null;
  fieldReports: number;
}

/** Per-cell counts of DISTINCT households (one household never counts twice per column). */
export interface CellAggregate {
  hex: HexId;
  households: number;
  hazard: number;
  outage: number;
  /** Event happens in weekday working hours (copied from the world context). */
  daytime: boolean;
  smsSent: number;
  replied: number;
  severeReplies: number;
  helpReplies: number;
  claimed: number;
  severeClaims: number;
  fieldReported: number;
  fieldSevere: number;
  /** Field reports whose safety is not 'unsure'. */
  fieldSafetyKnown: number;
  fieldHelp: number;
  /** Households with at least one reply, claim or field report. */
  heardFrom: number;
  // SMS sent / replied split by (limited English) x (away now), for the reply baseline.
  sentEnHome: number;
  repliedEnHome: number;
  sentLeHome: number;
  repliedLeHome: number;
  sentEnAway: number;
  repliedEnAway: number;
  sentLeAway: number;
  repliedLeAway: number;
  /** Claims exposure: sum of hazard * coverageFactor over owner-type and renter households. */
  exposureOwner: number;
  exposureRenter: number;
  claimsOwner: number;
  claimsRenter: number;
  // Who is silent (SMS sent, no reply, no claim, no field report) and why it might be.
  silent: number;
  silentAway: number;
  silentVulnerable: number;
  away: number;
  vulnerable: number;
  /** Expected replies / claims / households heard from, from the world refs at time t. */
  expectedReplies: number;
  expectedClaims: number;
  expectedHeard: number;
}

/** World-level reference rates at time t, derived only from observed events. */
export interface WorldRefs {
  /** Reply rate of English-speaking, at-home households in low-outage cells (fallbacks: all such cells, all households). */
  refReplyRate: number;
  /** Reply-rate multiplier for limited-English households (data-driven, shrunk toward 1, clamped). */
  limitedEnglishReplyFactor: number;
  /** Reply-rate multiplier for away-from-home households during a daytime event (1 otherwise). */
  awayReplyFactor: number;
  /** Claims per unit of insured hazard exposure (owner-type policies). */
  claimRatePerExposure: number;
  /** Claims multiplier for renters relative to owner-type policies (data-driven, shrunk toward 1, clamped). */
  renterClaimFactor: number;
}

export interface Snapshot {
  t: number;
  world: World;
  ctx: WorldContext;
  cellById: Map<HexId, HexCell>;
  householdById: Map<string, Household>;
  /** Households per hex, in world.households order (every hex present, possibly empty). */
  householdsByHex: Map<HexId, Household[]>;
  signals: Map<string, HouseholdSignals>;
  cells: Map<HexId, CellAggregate>;
  refs: WorldRefs;
  /** Facilities per hex (empty map when the world has none). */
  facilitiesByHex: Map<HexId, Facility[]>;
  /** Config the snapshot was built with (needed to rebuild a cell exactly). */
  cfg: TriageConfig;
}

export function emptySignals(): HouseholdSignals {
  return {
    smsSent: 0,
    firstSmsT: null,
    reply: null,
    replies: 0,
    claim: null,
    claims: 0,
    fieldReport: null,
    fieldReports: 0,
  };
}

/** Apply one event to a household's signal record (mutates `s`). Free-text reply fields are ignored. */
export function applyEventToSignals(s: HouseholdSignals, e: SimEvent): void {
  switch (e.kind) {
    case 'sms_sent':
      s.smsSent += 1;
      if (s.firstSmsT === null || e.t < s.firstSmsT) s.firstSmsT = e.t;
      break;
    case 'sms_reply':
      s.replies += 1;
      if (s.reply === null || e.t >= s.reply.t) s.reply = { t: e.t, safety: e.safety, damage: e.damage };
      break;
    case 'claim':
      s.claims += 1;
      if (s.claim === null || e.t >= s.claim.t) s.claim = { t: e.t, peril: e.peril, reportedDamage: e.reportedDamage };
      break;
    case 'field_report':
      s.fieldReports += 1;
      if (s.fieldReport === null || e.t >= s.fieldReport.t) {
        s.fieldReport = { t: e.t, adjusterId: e.adjusterId, safety: e.safety, damage: e.damage };
      }
      break;
  }
}

function hasAnySignal(s: HouseholdSignals): boolean {
  return s.reply !== null || s.claim !== null || s.fieldReport !== null;
}

export function newAggregate(cell: HexCell, cfg: TriageConfig, ctx: WorldContext): CellAggregate {
  return {
    hex: cell.hex,
    households: 0,
    hazard: hazardScore(cell, cfg),
    outage: clamp01(cell.towerOutagePct / 100),
    daytime: ctx.daytime,
    smsSent: 0,
    replied: 0,
    severeReplies: 0,
    helpReplies: 0,
    claimed: 0,
    severeClaims: 0,
    fieldReported: 0,
    fieldSevere: 0,
    fieldSafetyKnown: 0,
    fieldHelp: 0,
    heardFrom: 0,
    sentEnHome: 0,
    repliedEnHome: 0,
    sentLeHome: 0,
    repliedLeHome: 0,
    sentEnAway: 0,
    repliedEnAway: 0,
    sentLeAway: 0,
    repliedLeAway: 0,
    exposureOwner: 0,
    exposureRenter: 0,
    claimsOwner: 0,
    claimsRenter: 0,
    silent: 0,
    silentAway: 0,
    silentVulnerable: 0,
    away: 0,
    vulnerable: 0,
    expectedReplies: 0,
    expectedClaims: 0,
    expectedHeard: 0,
  };
}

/** Add a household's signals into its cell aggregate (counts distinct households). */
export function addToAggregate(agg: CellAggregate, s: HouseholdSignals, tr: HouseholdTraits): void {
  agg.households += 1;
  const sent = s.smsSent > 0;
  const replied = s.reply !== null;
  if (sent) {
    agg.smsSent += 1;
    if (tr.limitedEnglish) {
      if (tr.awayNow) {
        agg.sentLeAway += 1;
        if (replied) agg.repliedLeAway += 1;
      } else {
        agg.sentLeHome += 1;
        if (replied) agg.repliedLeHome += 1;
      }
    } else if (tr.awayNow) {
      agg.sentEnAway += 1;
      if (replied) agg.repliedEnAway += 1;
    } else {
      agg.sentEnHome += 1;
      if (replied) agg.repliedEnHome += 1;
    }
  }
  if (s.reply) {
    agg.replied += 1;
    if (s.reply.damage !== null && s.reply.damage >= 2) agg.severeReplies += 1;
    if (s.reply.safety === 'needs_help') agg.helpReplies += 1;
  }
  const exposure = agg.hazard * tr.coverageFactor;
  if (tr.renter) {
    agg.exposureRenter += exposure;
    if (s.claim) agg.claimsRenter += 1;
  } else {
    agg.exposureOwner += exposure;
    if (s.claim) agg.claimsOwner += 1;
  }
  if (s.claim) {
    agg.claimed += 1;
    if (s.claim.reportedDamage >= 2) agg.severeClaims += 1;
  }
  if (s.fieldReport) {
    agg.fieldReported += 1;
    if (s.fieldReport.damage >= 2) agg.fieldSevere += 1;
    if (s.fieldReport.safety !== 'unsure') {
      agg.fieldSafetyKnown += 1;
      if (s.fieldReport.safety === 'needs_help') agg.fieldHelp += 1;
    }
  }
  if (hasAnySignal(s)) agg.heardFrom += 1;
  else if (sent) {
    agg.silent += 1;
    if (tr.awayNow) agg.silentAway += 1;
    if (tr.vulnerable) agg.silentVulnerable += 1;
  }
  if (tr.awayNow) agg.away += 1;
  if (tr.vulnerable) agg.vulnerable += 1;
}

/** Aggregate one cell from scratch (raw counts only; expected* filled separately by fillExpected). */
export function aggregateCellCounts(
  cell: HexCell,
  members: readonly Household[],
  signals: ReadonlyMap<string, HouseholdSignals>,
  cfg: TriageConfig,
  ctx: WorldContext,
): CellAggregate {
  const agg = newAggregate(cell, cfg, ctx);
  for (const h of members) {
    const s = signals.get(h.id);
    if (!s) throw new Error(`no signals for household ${h.id}`);
    addToAggregate(agg, s, householdTraits(h, cell, ctx, cfg));
  }
  return agg;
}

/** Shrunk rate ratio: rate of a subgroup relative to a base rate, with k pseudo-observations at the base rate. */
function shrunkFactor(count: number, n: number, baseRate: number, k: number, lo: number, hi: number): number {
  if (!(baseRate > 0)) return 1;
  const rate = (count + k * baseRate) / (n + k);
  return clamp(rate / baseRate, lo, hi);
}

/** Compute world reference rates from the raw aggregates (depends only on observed events). */
export function computeRefs(cells: Iterable<CellAggregate>, cfg: TriageConfig): WorldRefs {
  const lowPct = cfg.silence.lowOutageRefPct / 100 + 1e-9;
  let lowSentEnHome = 0;
  let lowRepliedEnHome = 0;
  let lowSentLe = 0;
  let lowRepliedLe = 0;
  let lowSentEnAway = 0;
  let lowRepliedEnAway = 0;
  let allSentEnHome = 0;
  let allRepliedEnHome = 0;
  let allSent = 0;
  let allReplied = 0;
  let expOwner = 0;
  let expRenter = 0;
  let clOwner = 0;
  let clRenter = 0;
  let daytime = false;
  for (const c of cells) {
    allSent += c.smsSent;
    allReplied += c.replied;
    allSentEnHome += c.sentEnHome;
    allRepliedEnHome += c.repliedEnHome;
    if (c.outage <= lowPct) {
      lowSentEnHome += c.sentEnHome;
      lowRepliedEnHome += c.repliedEnHome;
      lowSentLe += c.sentLeHome;
      lowRepliedLe += c.repliedLeHome;
      lowSentEnAway += c.sentEnAway;
      lowRepliedEnAway += c.repliedEnAway;
    }
    expOwner += c.exposureOwner;
    expRenter += c.exposureRenter;
    clOwner += c.claimsOwner;
    clRenter += c.claimsRenter;
    daytime = daytime || c.daytime;
  }
  const refReplyRate =
    lowSentEnHome > 0 ? lowRepliedEnHome / lowSentEnHome : allSentEnHome > 0 ? allRepliedEnHome / allSentEnHome : allSent > 0 ? allReplied / allSent : 0;
  const f = cfg.silence.factors;
  const limitedEnglishReplyFactor = shrunkFactor(lowRepliedLe, lowSentLe, refReplyRate, f.pseudoSends, f.minReplyFactor, f.maxReplyFactor);
  const awayReplyFactor = daytime ? shrunkFactor(lowRepliedEnAway, lowSentEnAway, refReplyRate, f.pseudoSends, f.minReplyFactor, f.maxReplyFactor) : 1;
  const ownerRate = expOwner > 0 ? clOwner / expOwner : 0;
  const renterClaimFactor = shrunkFactor(clRenter, expRenter, ownerRate, f.pseudoExposure, f.minClaimFactor, f.maxClaimFactor);
  // Overall rate per exposure unit, with renters weighted by their factor.
  const totalExposure = expOwner + renterClaimFactor * expRenter;
  const claimRatePerExposure = totalExposure > 0 ? (clOwner + clRenter) / totalExposure : 0;
  return { refReplyRate, limitedEnglishReplyFactor, awayReplyFactor, claimRatePerExposure, renterClaimFactor };
}

/** Fill expectedReplies / expectedClaims / expectedHeard of one aggregate from the world refs (mutates). */
export function fillExpected(agg: CellAggregate, refs: WorldRefs): void {
  const le = refs.limitedEnglishReplyFactor;
  const aw = refs.awayReplyFactor;
  agg.expectedReplies = refs.refReplyRate * (agg.sentEnHome + le * agg.sentLeHome + aw * agg.sentEnAway + le * aw * agg.sentLeAway);
  agg.expectedClaims = refs.claimRatePerExposure * (agg.exposureOwner + refs.renterClaimFactor * agg.exposureRenter);
  if (agg.households === 0) {
    agg.expectedHeard = 0;
    return;
  }
  const pReply = clamp01(agg.expectedReplies / agg.households);
  const pClaim = clamp01(agg.expectedClaims / agg.households);
  agg.expectedHeard = agg.households * (1 - (1 - pReply) * (1 - pClaim));
}

/**
 * Build the snapshot at time t. Only events with e.t <= t are used.
 * Throws on contract violations (unknown household / hex, duplicates) rather
 * than silently dropping data.
 */
export function buildSnapshot(world: World, events: readonly SimEvent[], t: number, cfg: TriageConfig): Snapshot {
  const ctx = worldContext(world, cfg);
  const cellById = new Map<HexId, HexCell>();
  const householdsByHex = new Map<HexId, Household[]>();
  const facilitiesByHex = new Map<HexId, Facility[]>();
  for (const c of world.hexes) {
    if (cellById.has(c.hex)) throw new Error(`hex ${c.hex} appears twice in world.hexes`);
    cellById.set(c.hex, c);
    householdsByHex.set(c.hex, []);
    facilitiesByHex.set(c.hex, []);
  }
  for (const f of world.facilities ?? []) {
    const list = facilitiesByHex.get(f.hex);
    if (list) list.push(f); // facilities outside the study cells are ignored
  }

  const householdById = new Map<string, Household>();
  const signals = new Map<string, HouseholdSignals>();
  for (const h of world.households) {
    const members = householdsByHex.get(h.hex);
    if (!members) throw new Error(`household ${h.id} references unknown hex ${h.hex}`);
    if (householdById.has(h.id)) throw new Error(`household id ${h.id} appears twice`);
    householdById.set(h.id, h);
    members.push(h);
    signals.set(h.id, emptySignals());
  }

  for (const e of events) {
    if (e.t > t) continue;
    const s = signals.get(e.householdId);
    if (!s) throw new Error(`event ${e.kind}@${e.t} references unknown household ${e.householdId}`);
    applyEventToSignals(s, e);
  }

  const cells = new Map<HexId, CellAggregate>();
  for (const c of world.hexes) cells.set(c.hex, aggregateCellCounts(c, householdsByHex.get(c.hex)!, signals, cfg, ctx));

  const refs = computeRefs(cells.values(), cfg);
  for (const agg of cells.values()) fillExpected(agg, refs);

  return { t, world, ctx, cellById, householdById, householdsByHex, signals, cells, refs, facilitiesByHex, cfg };
}

/** Beta-smoothed share: (count + mean*strength) / (n + strength). */
export function betaMean(count: number, n: number, priorMean: number, strength: number): number {
  return (count + priorMean * strength) / (n + strength);
}

export function timeNorm(t: number, horizonMinutes: number): number {
  return clamp01(t / horizonMinutes);
}

/** Full named feature record for one household at the snapshot time. */
export function householdFeatureRecord(h: Household, snap: Snapshot, cfg: TriageConfig): Record<FeatureName, number> {
  const cell = snap.cellById.get(h.hex);
  const agg = snap.cells.get(h.hex);
  const s = snap.signals.get(h.id);
  if (!cell || !agg || !s) throw new Error(`household ${h.id} not part of snapshot`);
  const ctx = snap.ctx;
  const tr = householdTraits(h, cell, ctx, cfg);

  const wind = windNorm(cell, cfg);
  const flood = floodNorm(cell, cfg);
  const hazard = agg.hazard;
  const outage = agg.outage;
  const tn = timeNorm(snap.t, ctx.horizonMinutes);

  const sent = s.smsSent > 0 ? 1 : 0;
  const replied = s.reply ? 1 : 0;
  const replyDamage = s.reply && s.reply.damage !== null ? s.reply.damage / 3 : 0;
  const replyDamageUnknown = s.reply && s.reply.damage === null ? 1 : 0;
  const replySevere = s.reply && s.reply.damage !== null && s.reply.damage >= 2 ? 1 : 0;
  const replyHelp = s.reply && s.reply.safety === 'needs_help' ? 1 : 0;
  const noReply = sent === 1 && replied === 0 ? 1 : 0;

  const claimed = s.claim ? 1 : 0;
  const claimDamage = s.claim ? s.claim.reportedDamage / 3 : 0;
  const claimSevere = s.claim && s.claim.reportedDamage >= 2 ? 1 : 0;

  // Cell aggregates with this household removed, so a household never
  // "confirms itself" through the cell features.
  const n1 = Math.max(agg.households - 1, 0);
  const sentEx = agg.smsSent - sent;
  const repliedEx = agg.replied - replied;
  const severeRepliesEx = agg.severeReplies - replySevere;
  const helpRepliesEx = agg.helpReplies - replyHelp;
  const claimedEx = agg.claimed - claimed;
  const severeClaimsEx = agg.severeClaims - claimSevere;
  const ownExposure = hazard * tr.coverageFactor * (tr.renter ? snap.refs.renterClaimFactor : 1);
  const expectedClaimsEx = Math.max(0, agg.expectedClaims - snap.refs.claimRatePerExposure * ownExposure);

  const sm = cfg.smoothing;
  const claimLogRatio = clamp(
    Math.log((claimedEx + sm.claimPseudo) / (expectedClaimsEx + sm.claimPseudo)),
    -sm.claimLogClip,
    sm.claimLogClip,
  );
  const schoolHours = ctx.schoolHours ? 1 : 0;
  const schoolKids = clamp01(tr.schoolAgeChildren / 3);

  return {
    windNorm: wind,
    floodNorm: flood,
    hazardIndex: hazard,
    liquefaction: liquefactionOf(cell),
    outage,
    analystZone: cell.analystZone / 2,
    floodNoPolicy: h.floodPolicy ? 0 : flood,
    uncoveredHazard: hazard * tr.uncoveredShare,
    mobileHomeHazard: tr.mobileHome ? hazard : 0,
    age65: h.age65 ? 1 : 0,
    livesAlone: h.livesAlone ? 1 : 0,
    medicalDevice: h.medicalDevice ? 1 : 0,
    age65Alone: h.age65 && h.livesAlone ? 1 : 0,
    medicalDeviceOutage: h.medicalDevice ? outage : 0,
    age75: tr.age75 ? 1 : 0,
    disability: tr.disability ? 1 : 0,
    noVehicle: tr.noVehicle ? 1 : 0,
    limitedEnglish: tr.limitedEnglish ? 1 : 0,
    mobileHome: tr.mobileHome ? 1 : 0,
    childrenUnder18: tr.childrenUnder18 ? 1 : 0,
    awayDaytime: tr.awayDaytime ? 1 : 0,
    awayNow: tr.awayNow ? 1 : 0,
    renter: tr.renter ? 1 : 0,
    collegeStudent: tr.collegeStudent ? 1 : 0,
    schoolAgeChildren: schoolKids,
    schoolHours,
    schoolHoursChildren: schoolHours * (tr.schoolAgeChildren > 0 ? 1 : 0),
    timeNorm: tn,
    smsReplied: replied,
    smsReplyDamage: replyDamage,
    smsReplyDamageUnknown: replyDamageUnknown,
    smsReplyNeedsHelp: replyHelp,
    smsNoReply: noReply,
    smsNoReplyOutage: noReply * outage,
    smsNoReplyLowOutageTime: noReply * (1 - outage) * tn,
    smsNoReplyLimitedEnglish: noReply * (tr.limitedEnglish ? 1 : 0),
    smsNoReplyAway: noReply * (tr.awayNow ? 1 : 0),
    cellSevereReplyShare: betaMean(severeRepliesEx, repliedEx, sm.severePriorMean, sm.priorStrength),
    cellHelpReplyShare: betaMean(helpRepliesEx, repliedEx, sm.helpPriorMean, sm.priorStrength),
    cellReplyRate: sentEx > 0 ? repliedEx / sentEx : 0,
    claimFiled: claimed,
    claimDamage,
    cellClaimRate: n1 > 0 ? claimedEx / n1 : 0,
    cellClaimLogRatio: claimLogRatio,
    cellClaimSevereShare: betaMean(severeClaimsEx, claimedEx, sm.severePriorMean, sm.priorStrength),
  };
}

/** Feature vector in FEATURE_NAMES order. */
export function householdFeatures(h: Household, snap: Snapshot, cfg: TriageConfig): number[] {
  const rec = householdFeatureRecord(h, snap, cfg);
  return FEATURE_NAMES.map((n) => rec[n]);
}

/** Select features by name from a full record; throws on an unknown name. */
export function selectFeatures(rec: Record<FeatureName, number>, names: readonly string[]): number[] {
  const out = new Array<number>(names.length);
  for (let i = 0; i < names.length; i++) {
    const n = names[i] as FeatureName;
    const v = rec[n];
    if (v === undefined) throw new Error(`unknown feature name "${names[i]}"`);
    out[i] = v;
  }
  return out;
}

export function isFeatureName(name: string): name is FeatureName {
  return (FEATURE_SOURCE as Record<string, SourceGroup>)[name] !== undefined;
}

/**
 * Value a feature takes when its source has produced no evidence at all.
 * Source-trust modulation scales a source's contribution *relative to this
 * neutral point*, so trust changes never shift households with no evidence.
 */
export function neutralValue(name: FeatureName, cfg: TriageConfig): number {
  switch (name) {
    case 'cellSevereReplyShare':
    case 'cellClaimSevereShare':
      return cfg.smoothing.severePriorMean;
    case 'cellHelpReplyShare':
      return cfg.smoothing.helpPriorMean;
    default:
      return 0;
  }
}
