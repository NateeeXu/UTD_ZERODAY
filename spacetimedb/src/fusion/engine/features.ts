// COPIED from engine/src/features.ts by spacetimedb/scripts/sync-engine.ts. Do not edit here; edit engine/src and re-sync.
// Feature construction.
//
// A Snapshot is everything the engine is allowed to know at time t: the world
// (static) plus every event with event.t <= t. Truth never enters here.
// From a snapshot we derive a fixed, named feature vector per household.
// FEATURE_NAMES is the single source of truth for the order; ModelParams.features
// stores the same names so weights can be aligned by name, never by position.

import type { Damage, HexCell, HexId, Household, Peril, Safety, SimEvent, World } from '../contract.ts';
import type { TriageConfig } from './config.ts';
import { clamp, clamp01 } from './config.ts';

export const FEATURE_NAMES = [
  // --- hazard / map layer (source: hazard) ---
  'windNorm',
  'floodNorm',
  'floodNoPolicy',
  'outage',
  'analystZone',
  // --- static household attributes (source: static) ---
  'age65',
  'livesAlone',
  'medicalDevice',
  'age65Alone',
  'medicalDeviceOutage',
  'timeNorm',
  // --- own SMS signal (source: sms) ---
  'smsReplied',
  'smsReplyDamage',
  'smsReplyNeedsHelp',
  'smsNoReply',
  'smsNoReplyOutage',
  'smsNoReplyLowOutageTime',
  // --- own claim signal (source: claims) ---
  'claimFiled',
  'claimDamage',
  // --- cell-level SMS aggregates, excluding the household itself (source: sms) ---
  'cellSevereReplyShare',
  'cellHelpReplyShare',
  'cellReplyRate',
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
  floodNoPolicy: 'hazard',
  outage: 'hazard',
  analystZone: 'hazard',
  age65: 'static',
  livesAlone: 'static',
  medicalDevice: 'static',
  age65Alone: 'static',
  medicalDeviceOutage: 'static',
  timeNorm: 'static',
  smsReplied: 'sms',
  smsReplyDamage: 'sms',
  smsReplyNeedsHelp: 'sms',
  smsNoReply: 'sms',
  smsNoReplyOutage: 'sms',
  smsNoReplyLowOutageTime: 'sms',
  claimFiled: 'claims',
  claimDamage: 'claims',
  cellSevereReplyShare: 'sms',
  cellHelpReplyShare: 'sms',
  cellReplyRate: 'sms',
  cellClaimRate: 'claims',
  cellClaimLogRatio: 'claims',
  cellClaimSevereShare: 'claims',
};

/** Features available before any SMS reply or claim exists: the "maps only" baseline. */
export const HAZARD_BASELINE_FEATURES: FeatureName[] = [
  'windNorm',
  'floodNorm',
  'floodNoPolicy',
  'outage',
  'analystZone',
  'age65',
  'livesAlone',
  'medicalDevice',
  'age65Alone',
  'medicalDeviceOutage',
  'timeNorm',
];

export interface ReplySignal {
  t: number;
  safety: 'safe' | 'needs_help';
  damage: Damage;
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

/** Everything observed for one household up to the snapshot time. */
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
  /** households * hazard * claimRatePerHazard (world reference at time t). */
  expectedClaims: number;
  /** Households we would expect to have heard from by now if towers were up. */
  expectedHeard: number;
}

/** World-level reference rates at time t, derived only from observed events. */
export interface WorldRefs {
  /** replies / smsSent among households in low-outage cells (fallback: all cells). */
  refReplyRate: number;
  /** claims / sum(households * hazard) over the world. */
  claimRatePerHazard: number;
}

export interface Snapshot {
  t: number;
  world: World;
  cellById: Map<HexId, HexCell>;
  householdById: Map<string, Household>;
  /** Households per hex, in world.households order (every hex present, possibly empty). */
  householdsByHex: Map<HexId, Household[]>;
  signals: Map<string, HouseholdSignals>;
  cells: Map<HexId, CellAggregate>;
  refs: WorldRefs;
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

export function windNorm(cell: HexCell, cfg: TriageConfig): number {
  const { windMinMph, windMaxMph } = cfg.hazard;
  return clamp01((cell.windMph - windMinMph) / (windMaxMph - windMinMph));
}

export function floodNorm(cell: HexCell, cfg: TriageConfig): number {
  if (!(cell.floodDepthFt > 0)) return 0;
  return clamp01(1 - Math.exp(-cell.floodDepthFt / cfg.hazard.floodScaleFt));
}

/** 0-1 hazard score of a cell from wind, flood and the analyst's impact zone. */
export function hazardScore(cell: HexCell, cfg: TriageConfig): number {
  const intensity = Math.max(windNorm(cell, cfg), floodNorm(cell, cfg));
  return clamp01(cfg.hazard.intensityWeight * intensity + cfg.hazard.zoneWeight * (cell.analystZone / 2));
}

/** Apply one event to a household's signal record (mutates `s`). */
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

/** Add a household's signals into its cell aggregate (counts distinct households). */
function addToAggregate(agg: CellAggregate, s: HouseholdSignals): void {
  if (s.smsSent > 0) agg.smsSent += 1;
  if (s.reply) {
    agg.replied += 1;
    if (s.reply.damage >= 2) agg.severeReplies += 1;
    if (s.reply.safety === 'needs_help') agg.helpReplies += 1;
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
}

export function newAggregate(cell: HexCell, cfg: TriageConfig): CellAggregate {
  return {
    hex: cell.hex,
    households: 0,
    hazard: hazardScore(cell, cfg),
    outage: clamp01(cell.towerOutagePct / 100),
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
    expectedClaims: 0,
    expectedHeard: 0,
  };
}

/** Compute world reference rates from the raw aggregates. */
export function computeRefs(cells: Iterable<CellAggregate>, cfg: TriageConfig): WorldRefs {
  let lowSent = 0;
  let lowReplied = 0;
  let allSent = 0;
  let allReplied = 0;
  let claims = 0;
  let hazardMass = 0;
  for (const c of cells) {
    allSent += c.smsSent;
    allReplied += c.replied;
    if (c.outage <= cfg.silence.lowOutageRefPct / 100 + 1e-9) {
      lowSent += c.smsSent;
      lowReplied += c.replied;
    }
    claims += c.claimed;
    hazardMass += c.households * c.hazard;
  }
  const refReplyRate = lowSent > 0 ? lowReplied / lowSent : allSent > 0 ? allReplied / allSent : 0;
  const claimRatePerHazard = hazardMass > 0 ? claims / hazardMass : 0;
  return { refReplyRate, claimRatePerHazard };
}

/** Fill expectedClaims / expectedHeard of one aggregate from the world refs (mutates). */
export function fillExpected(agg: CellAggregate, refs: WorldRefs): void {
  agg.expectedClaims = agg.households * agg.hazard * refs.claimRatePerHazard;
  if (agg.households === 0) {
    agg.expectedHeard = 0;
    return;
  }
  const pReply = (agg.smsSent / agg.households) * refs.refReplyRate;
  const pClaim = clamp01(agg.hazard * refs.claimRatePerHazard);
  agg.expectedHeard = agg.households * (1 - (1 - pReply) * (1 - pClaim));
}

/** Aggregate one cell from scratch (raw counts only; expected* filled separately). */
export function aggregateCellCounts(
  cell: HexCell,
  members: readonly Household[],
  signals: ReadonlyMap<string, HouseholdSignals>,
  cfg: TriageConfig,
): CellAggregate {
  const agg = newAggregate(cell, cfg);
  for (const h of members) {
    const s = signals.get(h.id);
    if (!s) throw new Error(`no signals for household ${h.id}`);
    agg.households += 1;
    addToAggregate(agg, s);
  }
  return agg;
}

/**
 * Build the snapshot at time t. Only events with e.t <= t are used.
 * Throws on contract violations (unknown household / hex) rather than
 * silently dropping data.
 */
export function buildSnapshot(world: World, events: readonly SimEvent[], t: number, cfg: TriageConfig): Snapshot {
  const cellById = new Map<HexId, HexCell>();
  const householdsByHex = new Map<HexId, Household[]>();
  for (const c of world.hexes) {
    if (cellById.has(c.hex)) throw new Error(`hex ${c.hex} appears twice in world.hexes`);
    cellById.set(c.hex, c);
    householdsByHex.set(c.hex, []);
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
  for (const c of world.hexes) cells.set(c.hex, aggregateCellCounts(c, householdsByHex.get(c.hex)!, signals, cfg));

  const refs = computeRefs(cells.values(), cfg);
  for (const agg of cells.values()) fillExpected(agg, refs);

  return { t, world, cellById, householdById, householdsByHex, signals, cells, refs, cfg };
}

/** Beta-smoothed share: (count + mean*strength) / (n + strength). */
export function betaMean(count: number, n: number, priorMean: number, strength: number): number {
  return (count + priorMean * strength) / (n + strength);
}

export function timeNorm(t: number, cfg: TriageConfig): number {
  return clamp01(t / cfg.horizonMinutes);
}

/** Full named feature record for one household at the snapshot time. */
export function householdFeatureRecord(h: Household, snap: Snapshot, cfg: TriageConfig): Record<FeatureName, number> {
  const cell = snap.cellById.get(h.hex);
  const agg = snap.cells.get(h.hex);
  const s = snap.signals.get(h.id);
  if (!cell || !agg || !s) throw new Error(`household ${h.id} not part of snapshot`);

  const wind = windNorm(cell, cfg);
  const flood = floodNorm(cell, cfg);
  const outage = agg.outage;
  const tn = timeNorm(snap.t, cfg);

  const sent = s.smsSent > 0 ? 1 : 0;
  const replied = s.reply ? 1 : 0;
  const replyDamage = s.reply ? s.reply.damage / 3 : 0;
  const replySevere = s.reply && s.reply.damage >= 2 ? 1 : 0;
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
  const expectedClaimsEx = agg.households > 0 ? agg.expectedClaims * (n1 / agg.households) : 0;

  const sm = cfg.smoothing;
  const claimLogRatio = clamp(
    Math.log((claimedEx + sm.claimPseudo) / (expectedClaimsEx + sm.claimPseudo)),
    -sm.claimLogClip,
    sm.claimLogClip,
  );

  return {
    windNorm: wind,
    floodNorm: flood,
    floodNoPolicy: h.floodPolicy ? 0 : flood,
    outage,
    analystZone: cell.analystZone / 2,
    age65: h.age65 ? 1 : 0,
    livesAlone: h.livesAlone ? 1 : 0,
    medicalDevice: h.medicalDevice ? 1 : 0,
    age65Alone: h.age65 && h.livesAlone ? 1 : 0,
    medicalDeviceOutage: h.medicalDevice ? outage : 0,
    timeNorm: tn,
    smsReplied: replied,
    smsReplyDamage: replyDamage,
    smsReplyNeedsHelp: replyHelp,
    smsNoReply: noReply,
    smsNoReplyOutage: noReply * outage,
    smsNoReplyLowOutageTime: noReply * (1 - outage) * tn,
    claimFiled: claimed,
    claimDamage,
    cellSevereReplyShare: betaMean(severeRepliesEx, repliedEx, sm.severePriorMean, sm.priorStrength),
    cellHelpReplyShare: betaMean(helpRepliesEx, repliedEx, sm.helpPriorMean, sm.priorStrength),
    cellReplyRate: sentEx > 0 ? repliedEx / sentEx : 0,
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
