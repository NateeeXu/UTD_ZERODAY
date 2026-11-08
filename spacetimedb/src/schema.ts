// Triage Loop SpacetimeDB schema.
// All data is synthetic (fictional Harbor Bend, TX). See docs/SPACETIME_API.md for the client-facing reference.
import { schema, table, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';

// ---------------------------------------------------------------------------
// Private configuration and demo data
// ---------------------------------------------------------------------------

/** PRIVATE singleton (id = 0). Owner identity captured in `init`, demo passcodes set by the owner. */
export const config = table(
  { name: 'config' },
  {
    id: t.u32().primaryKey(),
    owner: t.identity(),
    staffPasscode: t.string(), // join_as('manager' | 'adjuster')
    replyPasscode: t.string(), // join_as('policyholder_demo') and submit_sms_reply without a role
    worldStamp: t.u64(), // micros of the last write to hex / household / facility (static-data cache key)
  }
);

/** PRIVATE: TruthRow for every household. Only used to score the holdout set. */
export const simTruth = table(
  { name: 'sim_truth' },
  {
    householdId: t.string().primaryKey(),
    damage: t.u8(),
    safety: t.string(), // 'safe' | 'needs_help'
    peril: t.string(), // 'wind' | 'flood' | 'earthquake' | 'none'
  }
);

/** PRIVATE: every live event from data/live.json, released in `seq` order by the replay clock. */
export const stagedEvent = table(
  { name: 'staged_event' },
  {
    seq: t.u32().primaryKey(), // 0..n-1, same order as EventBundle.events (sorted by t)
    t: t.u32(),
    kind: t.string(), // 'sms_sent' | 'sms_reply' | 'claim' | 'field_report'
    householdId: t.string(),
    safety: t.string(), // '' when not applicable
    damage: t.u8(), // sms_reply / field_report damage
    peril: t.string(), // claim peril, '' otherwise
    reportedDamage: t.u8(), // claim reportedDamage
    adjusterId: t.string(), // field_report adjusterId, '' otherwise
    text: t.string(), // sms_reply free text ('' when none)
    language: t.string(), // sms_reply language code ('' when none)
  }
);

/**
 * PRIVATE: per-cell aggregate counters that the engine's world reference rates (computeRefs) need.
 * Written by every recompute of the cell; a cell's aggregate only changes with its own events, so
 * the table is always exact. Read in full (one row per cell) whenever world refs are needed.
 */
export const cellAgg = table(
  { name: 'cell_agg' },
  {
    hex: t.string().primaryKey(),
    outage: t.f64(),
    daytime: t.bool(),
    smsSent: t.u32(),
    replied: t.u32(),
    sentEnHome: t.u32(),
    repliedEnHome: t.u32(),
    sentLeHome: t.u32(),
    repliedLeHome: t.u32(),
    sentEnAway: t.u32(),
    repliedEnAway: t.u32(),
    sentLeAway: t.u32(),
    repliedLeAway: t.u32(),
    exposureOwner: t.f64(),
    exposureRenter: t.f64(),
    claimsOwner: t.u32(),
    claimsRenter: t.u32(),
  }
);

/** PRIVATE scheduled table: one interval row exists while the replay is running. */
export const replayTick = table(
  { name: 'replay_tick' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

// ---------------------------------------------------------------------------
// Public world data
// ---------------------------------------------------------------------------

/** Singleton (id = 0): World metadata. */
export const world = table(
  { name: 'world', public: true },
  {
    id: t.u32().primaryKey(),
    eventId: t.string(),
    name: t.string(),
    landfallIso: t.string(),
    centerLat: t.f64(),
    centerLng: t.f64(),
    // v2 world fields (as in the bundle)
    region: t.option(t.string()), // 'tx-corpus-christi' | 'ca-bay-area' | undefined (Harbor Bend)
    hazardType: t.string(), // 'hurricane' | 'earthquake' (missing in the bundle = hurricane)
    horizonMinutes: t.u32(), // event length, default 4320
    eventLocalHour: t.option(t.u8()),
    eventWeekday: t.option(t.bool()),
    dataSourcesJson: t.string(), // JSON array of source/licence strings ('[]' when none)
    // engine WorldContext derived at seed time (engine worldContext())
    localHour: t.u8(),
    weekday: t.bool(),
    daytime: t.bool(), // weekday working hours: awayDaytime households are not home
    schoolHours: t.bool(), // weekday school hours: school-age children are at school
    timeSource: t.string(), // 'world' | 'landfallIso'
  }
);

/** Real facilities (schools, universities, hospitals, shelters, fire stations, masts). */
export const facility = table(
  { name: 'facility', public: true },
  {
    id: t.string().primaryKey(),
    kind: t.string(), // 'school' | 'university' | 'hospital' | 'shelter' | 'fire_station' | 'mast'
    name: t.string(),
    lat: t.f64(),
    lng: t.f64(),
    hex: t.string().index('btree'),
    enrollment: t.option(t.u32()),
    capacity: t.option(t.u32()),
    source: t.string(),
  }
);

/** One row per HexCell. */
export const hex = table(
  { name: 'hex', public: true },
  {
    hex: t.string().primaryKey(),
    displayOrder: t.u32(),
    lat: t.f64(),
    lng: t.f64(),
    windMph: t.f64(),
    floodDepthFt: t.f64(),
    towerOutagePct: t.f64(),
    analystZone: t.u8(),
    // v2 optional fields (real-geography worlds)
    hazardIndex: t.option(t.f64()), // 0-1, hazard-agnostic intensity; the engine prefers it
    shakingMmi: t.option(t.f64()),
    liquefaction: t.option(t.f64()),
    tractGeoid: t.option(t.string()),
    daytimeWorkers: t.option(t.f64()),
    residentWorkers: t.option(t.f64()),
    k12Enrollment: t.option(t.f64()),
    collegeEnrollment: t.option(t.f64()),
  }
);

/** One row per Household (synthetic, so it is public). */
export const household = table(
  { name: 'household', public: true },
  {
    id: t.string().primaryKey(),
    hex: t.string().index('btree'),
    lat: t.f64(),
    lng: t.f64(),
    age65: t.bool(),
    livesAlone: t.bool(),
    medicalDevice: t.bool(),
    windCovered: t.bool(),
    floodPolicy: t.bool(),
    earthquakeEndorsement: t.bool(),
    phoneOnFile: t.bool(),
    holdout: t.bool().index('btree'),
    // v2 optional fields (CMIST, tenure, students); undefined when the bundle has no value
    tractGeoid: t.option(t.string()),
    childrenUnder18: t.option(t.bool()),
    awayDaytime: t.option(t.bool()),
    age75: t.option(t.bool()),
    disability: t.option(t.bool()),
    noVehicle: t.option(t.bool()),
    limitedEnglish: t.option(t.bool()),
    primaryLanguage: t.option(t.string()),
    mobileHome: t.option(t.bool()),
    policyType: t.option(t.string()), // 'homeowners' | 'renters' | 'condo'
    schoolAgeChildren: t.option(t.u8()),
    collegeStudent: t.option(t.bool()),
    nearestSchoolId: t.option(t.string()),
  }
);

// ---------------------------------------------------------------------------
// Public event tables (written only by onEvent)
// ---------------------------------------------------------------------------

const eventColumns = {
  id: t.u64().primaryKey().autoInc(),
  householdId: t.string().index('btree'),
  hex: t.string().index('btree'),
  t: t.u32(), // minutes after landfall
  source: t.string(), // 'replay' (from data/live.json) | 'live' (submitted during the demo)
  ingestedBy: t.identity(),
  ingestedAt: t.timestamp(),
};

export const smsSent = table({ name: 'sms_sent', public: true }, { ...eventColumns });

export const smsReply = table(
  { name: 'sms_reply', public: true },
  {
    ...eventColumns,
    safety: t.string(), // 'safe' | 'needs_help'
    damage: t.u8(), // 0..3
    text: t.option(t.string()), // free-text reply (may be non-English); safety/damage are its parsed values
    language: t.option(t.string()), // language code of the reply, e.g. 'es', 'zh'
  }
);

export const claim = table(
  { name: 'claim', public: true },
  {
    ...eventColumns,
    peril: t.string(), // 'wind' | 'flood'
    reportedDamage: t.u8(),
  }
);

export const fieldReport = table(
  { name: 'field_report', public: true },
  {
    ...eventColumns,
    adjusterId: t.string(), // display name of the adjuster (or 'adj-xx' for replayed reports)
    safety: t.string(), // 'safe' | 'needs_help' | 'unsure'
    damage: t.u8(),
    note: t.string(),
  }
);

// ---------------------------------------------------------------------------
// Replay, statistics, fusion outputs
// ---------------------------------------------------------------------------

/** Singleton (id = 0): the replay clock. */
export const replayState = table(
  { name: 'replay_state', public: true },
  {
    id: t.u32().primaryKey(),
    running: t.bool(),
    simMinutes: t.f64(), // current sim time, minutes after landfall
    speed: t.f64(), // sim minutes per real second
    nextSeq: t.u32(), // next staged event to release
    totalStaged: t.u32(),
    maxMinutes: t.u32(), // world.horizonMinutes (4320 = 72 h)
    lastTickAt: t.timestamp(),
    fullRecomputeEveryMin: t.u32(), // full recompute + holdout scoring cadence in sim minutes (0 = only on jump/pause/end)
    lastFullRecomputeMin: t.f64(),
  }
);

/** Real-time statistics + fusion output per cell. Counters are updated incrementally by onEvent. */
export const hexStats = table(
  { name: 'hex_stats', public: true },
  {
    hex: t.string().primaryKey(),
    displayOrder: t.u32(),
    // incremental counters
    households: t.u32(),
    phones: t.u32(), // households with phoneOnFile
    smsSent: t.u32(), // distinct households texted
    smsReplies: t.u32(), // distinct households that replied
    replyRate: t.f64(), // smsReplies / smsSent
    severeReplies: t.u32(), // reply events with damage >= 2
    helpReplies: t.u32(), // reply events with safety = needs_help
    claims: t.u32(),
    fieldReports: t.u32(),
    verifiedHouseholds: t.u32(), // distinct households with a field report
    // fusion output (HexEstimate)
    severity: t.f64(),
    confidence: t.f64(),
    priority: t.string(), // 'P0' | 'P1' | 'P2' ('' before the first recompute)
    verification: t.string(), // 'verified' | 'needs_verification'
    silence: t.f64(),
    expectedSevere: t.f64(),
    maxPNeedsHelp: t.f64(),
    hazard: t.f64(), // 0-1 hazard score used by the verification rule (hazardIndex when present)
    silenceCause: t.string(), // 'away' | 'trapped' | 'outage' | 'unknown' | '' (not silent)
    reason: t.string(), // engine's one-line explanation of priority / verification
    updatedAt: t.timestamp(),
    updatedSimMinutes: t.f64(),
  }
);

/** HouseholdEstimate per household, plus an active-inspection score. */
export const householdEstimate = table(
  { name: 'household_estimate', public: true },
  {
    householdId: t.string().primaryKey(),
    hex: t.string().index('btree'),
    pSevere: t.f64(),
    pNeedsHelp: t.f64(),
    uncertainty: t.f64(),
    verified: t.bool(),
    inspectScore: t.f64(), // 0..1, higher = send an adjuster here first (severity x uncertainty)
    updatedAt: t.timestamp(),
  }
);

/**
 * Active-inspection shortlist: the top unverified households of every cell by inspectScore
 * (at most INSPECT_PER_CELL per cell, the engine's perCellCap). Sorting this small table by
 * inspectScore gives the engine's recommendInspections() order without subscribing to every
 * household_estimate row (30,000 in the Bay Area world).
 */
export const inspectionCandidate = table(
  { name: 'inspection_candidate', public: true },
  {
    householdId: t.string().primaryKey(),
    hex: t.string().index('btree'),
    rank: t.u8(), // 1 = best in its cell
    inspectScore: t.f64(),
    pSevere: t.f64(),
    pNeedsHelp: t.f64(),
    uncertainty: t.f64(),
    cellPriority: t.string(),
    cellVerification: t.string(),
  }
);

/** Singleton (id = 0): global dashboard metrics. */
export const metrics = table(
  { name: 'metrics', public: true },
  {
    id: t.u32().primaryKey(),
    hexes: t.u32(),
    households: t.u32(),
    smsSent: t.u32(),
    smsReplies: t.u32(),
    helpReplies: t.u32(),
    claims: t.u32(),
    fieldReports: t.u32(),
    verifiedHouseholds: t.u32(),
    verifiedCoverage: t.f64(), // verifiedHouseholds / households
    p0Cells: t.u32(),
    p1Cells: t.u32(),
    p2Cells: t.u32(),
    needsVerificationCells: t.u32(),
    holdoutN: t.u32(), // 0 = not computed yet
    holdoutBrierSevere: t.f64(), // mean (pSevere - [damage>=2])^2 over holdout households
    holdoutBrierHelp: t.f64(), // mean (pNeedsHelp - [needs_help])^2
    holdoutSevereRecall: t.f64(), // share of truly severe holdout households with pSevere >= 0.5
    holdoutSimMinutes: t.f64(),
    trustHazard: t.f64(),
    trustSms: t.f64(),
    trustClaims: t.f64(),
    trustUpdates: t.u32(),
    modelVersion: t.u32(),
    engine: t.string(), // which estimator produced the numbers: 'stub' | 'engine'
    updatedAt: t.timestamp(),
  }
);

/** Singleton (id = 0): ModelParams JSON + batched source-trust learning state. */
export const modelState = table(
  { name: 'model_state', public: true },
  {
    id: t.u32().primaryKey(),
    loaded: t.bool(),
    version: t.u32(),
    paramsJson: t.string(), // ModelParams (data/model.json) or '' when not loaded
    baseTrustHazard: t.f64(), // trust measured at calibration (ModelParams.sourceTrust)
    baseTrustSms: t.f64(),
    baseTrustClaims: t.f64(),
    trustHazard: t.f64(), // current (learned) trust
    trustSms: t.f64(),
    trustClaims: t.f64(),
    trustUpdates: t.u32(),
    lastScoreHazard: t.f64(), // 1 - Brier of each source in the last batch (-1 = too few opinions)
    lastScoreSms: t.f64(),
    lastScoreClaims: t.f64(),
    pendingFieldReports: t.u32(), // non-holdout reports waiting for the next batch (TRUST_BATCH = 10)
    pendingHazardSse: t.f64(),
    pendingHazardN: t.u32(),
    pendingSmsSse: t.f64(),
    pendingSmsN: t.u32(),
    pendingClaimsSse: t.f64(),
    pendingClaimsN: t.u32(),
    holdoutReports: t.u32(), // field reports on holdout households (never used for learning)
    updatedAt: t.timestamp(),
  }
);

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export const member = table(
  { name: 'member', public: true },
  {
    identity: t.identity().primaryKey(),
    role: t.string(), // 'manager' | 'adjuster' | 'policyholder_demo'
    name: t.string(),
    joinedAt: t.timestamp(),
  }
);

export const assignment = table(
  { name: 'assignment', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    householdId: t.string().index('btree'),
    hex: t.string(),
    adjuster: t.identity().index('btree'),
    assignedBy: t.identity(),
    status: t.string(), // 'assigned' | 'done' | 'cancelled'
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

// ---------------------------------------------------------------------------
// Reducer argument types (not tables)
// ---------------------------------------------------------------------------

export const WorldInput = t.object('WorldInput', {
  eventId: t.string(),
  name: t.string(),
  landfallIso: t.string(),
  centerLat: t.f64(),
  centerLng: t.f64(),
  region: t.option(t.string()),
  hazardType: t.option(t.string()),
  horizonMinutes: t.option(t.u32()),
  eventLocalHour: t.option(t.u8()),
  eventWeekday: t.option(t.bool()),
  dataSources: t.array(t.string()),
});

export const HexInput = t.object('HexInput', {
  hex: t.string(),
  displayOrder: t.u32(),
  lat: t.f64(),
  lng: t.f64(),
  windMph: t.f64(),
  floodDepthFt: t.f64(),
  towerOutagePct: t.f64(),
  analystZone: t.u8(),
  hazardIndex: t.option(t.f64()),
  shakingMmi: t.option(t.f64()),
  liquefaction: t.option(t.f64()),
  tractGeoid: t.option(t.string()),
  daytimeWorkers: t.option(t.f64()),
  residentWorkers: t.option(t.f64()),
  k12Enrollment: t.option(t.f64()),
  collegeEnrollment: t.option(t.f64()),
});

export const FacilityInput = t.object('FacilityInput', {
  id: t.string(),
  kind: t.string(),
  name: t.string(),
  lat: t.f64(),
  lng: t.f64(),
  hex: t.string(),
  enrollment: t.option(t.u32()),
  capacity: t.option(t.u32()),
  source: t.string(),
});

export const HouseholdInput = t.object('HouseholdInput', {
  id: t.string(),
  hex: t.string(),
  lat: t.f64(),
  lng: t.f64(),
  age65: t.bool(),
  livesAlone: t.bool(),
  medicalDevice: t.bool(),
  windCovered: t.bool(),
  floodPolicy: t.bool(),
  earthquakeEndorsement: t.bool(),
  phoneOnFile: t.bool(),
  holdout: t.bool(),
  tractGeoid: t.option(t.string()),
  childrenUnder18: t.option(t.bool()),
  awayDaytime: t.option(t.bool()),
  age75: t.option(t.bool()),
  disability: t.option(t.bool()),
  noVehicle: t.option(t.bool()),
  limitedEnglish: t.option(t.bool()),
  primaryLanguage: t.option(t.string()),
  mobileHome: t.option(t.bool()),
  policyType: t.option(t.string()),
  schoolAgeChildren: t.option(t.u8()),
  collegeStudent: t.option(t.bool()),
  nearestSchoolId: t.option(t.string()),
});

export const TruthInput = t.object('TruthInput', {
  householdId: t.string(),
  damage: t.u8(),
  safety: t.string(),
  peril: t.string(),
});

export const StagedEventInput = t.object('StagedEventInput', {
  seq: t.u32(),
  t: t.u32(),
  kind: t.string(),
  householdId: t.string(),
  safety: t.string(),
  damage: t.u8(),
  peril: t.string(),
  reportedDamage: t.u8(),
  adjusterId: t.string(),
  text: t.string(),
  language: t.string(),
});

const spacetimedb = schema({
  config,
  simTruth,
  stagedEvent,
  cellAgg,
  replayTick,
  world,
  facility,
  hex,
  household,
  smsSent,
  smsReply,
  claim,
  fieldReport,
  replayState,
  hexStats,
  householdEstimate,
  inspectionCandidate,
  metrics,
  modelState,
  member,
  assignment,
});
export default spacetimedb;

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
