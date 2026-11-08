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
    needType: t.string(), // 'life_safety' | 'assistance' | 'none'
    location: t.string(), // where the people are: 'home' | 'away' (not home when it hit) | 'displaced'
    returnMin: t.f64(), // away people get home at this sim minute (-1 = never); then 'displaced' if damage >= 2, else 'home'
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
    damageKnown: t.bool(), // sms_reply: false = the reply does not describe the home (damage is then 0)
    lifeSafety: t.bool(), // sms_reply: danger now (911 / local agency referral)
    needs: t.string(), // sms_reply: comma-separated needs ('' when none)
    notHome: t.bool(), // sms_reply: the person replying is not at the house
    channel: t.string(), // sms_reply: 'sms' | 'call'
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
  source: t.string(), // 'replay' (from data/live.json) | 'live' (submitted during the demo) | 'staff_sim'
  ingestedBy: t.identity(),
  ingestedAt: t.timestamp(),
};

export const smsSent = table({ name: 'sms_sent', public: true }, { ...eventColumns });

export const smsReply = table(
  { name: 'sms_reply', public: true },
  {
    ...eventColumns,
    safety: t.string(), // 'safe' | 'needs_help'
    damage: t.u8(), // 0..3 (0 when damageKnown is false)
    text: t.option(t.string()), // free-text reply (may be non-English); safety/damage are its parsed values
    language: t.option(t.string()), // language code of the reply, e.g. 'es', 'zh'
    damageKnown: t.bool(), // false = the reply does not describe the home (e.g. the person is not there)
    lifeSafety: t.bool(), // danger now: opens a 911 / local agency referral
    needs: t.string(), // comma-separated: medical,power_for_device,shelter,water_food,transport,inspection,other
    notHome: t.bool(), // the person replying is not at the house (people and property tracked separately)
    channel: t.string(), // 'sms' | 'call' (an agent reached them by phone)
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
    severeLo: t.f64(), // 90% interval for the number of severe households (engine/src/interval.ts)
    severeHi: t.f64(),
    severeVar: t.f64(), // variance of that count (region totals add these)
    maxPNeedsHelp: t.f64(),
    hazard: t.f64(), // 0-1 hazard score used by the verification rule (hazardIndex when present)
    silenceCause: t.string(), // 'away' | 'trapped' | 'outage' | 'unknown' | '' (not silent)
    reason: t.string(), // engine's one-line explanation of priority / verification
    // "no one overlooked": a household is accounted for once it replied, filed a claim or got a field report
    accounted: t.u32(),
    unaccounted: t.u32(),
    vulnerable: t.u32(), // CMIST-vulnerable households (75+, disability, no vehicle, limited English, medical device, 65+ alone)
    unaccountedVulnerable: t.u32(),
    highRiskUnaccounted: t.u32(), // unaccounted and (vulnerable, pNeedsHelp >= 0.3 or P0 cell)
    longestWaitMin: t.f64(), // longest time a high-risk household has gone unaccounted (sim minutes)
    openReferrals: t.u32(), // needs help / member missing, not resolved yet
    overdueReferrals: t.u32(), // referred but not acknowledged within REFERRAL_ACK_MIN
    membersMissing: t.u32(), // households reporting someone unaccounted for
    closedNoContact: t.u32(), // closed with a documented reason instead of contact
    recheckDue: t.u32(), // heard from, but a vulnerable household's last contact is older than RECHECK_MIN
    callContacts: t.u32(), // households reached by an agent phone call
    assistanceRequests: t.u32(), // needs help, not life safety (State Farm customer care)
    inspectionRequests: t.u32(), // asked for someone to look at the house
    locateDue: t.u32(), // property inspected, occupants not seen, not heard from: find their whereabouts
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
    accounted: t.bool(), // replied, filed a claim or has a field report
    escalation: t.string().index('btree'), // next contact step, see ESCALATION in fusion/index.ts
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
    accounted: t.bool(),
    escalation: t.string(),
  }
);

/**
 * Follow-up state per household ("no one overlooked"): a reported missing household member,
 * the referral lifecycle for people who need help, and a documented closure reason.
 */
export const householdFollowup = table(
  { name: 'household_followup', public: true },
  {
    householdId: t.string().primaryKey(),
    hex: t.string().index('btree'),
    memberMissing: t.bool(),
    referralStatus: t.string(), // '' | 'referred' | 'acknowledged' | 'resolved'
    referralSimMinutes: t.f64(), // sim minute it was referred
    reportedSimMinutes: t.f64(), // sim minute a missing member was reported (starts the referral timer)
    closureReason: t.string(), // '' | 'vacant' | 'not_in_area' | 'unreachable_after_visit'
    closedBy: t.string(),
    updatedAt: t.timestamp(),
  }
);

/**
 * Outreach queue ("no one overlooked"): the top QUEUE_PER_CELL households of every cell that still need
 * contact (not heard from yet, or a high-risk "safe" that has expired). Rows are time-independent so they
 * are rewritten only when the ranking changes; the client ranks across cells with
 *   score = weight * (1 + (replay_state.simMinutes - waitSinceMin) / QUEUE_AGING_MIN)
 * so every hour of silence raises a household (aging: low-risk households cannot starve).
 * The cell's full list is household_estimate where hex = X and (accounted = false or escalation = 'recheck').
 */
export const unaccountedQueue = table(
  { name: 'unaccounted_queue', public: true },
  {
    householdId: t.string().primaryKey(),
    hex: t.string().index('btree'),
    rank: t.u8(), // 1 = first in this cell
    weight: t.f64(), // risk x vulnerability x cell priority (time-independent part of the score)
    waitSinceMin: t.f64(), // sim minute the wait started (outreach text, landfall, or "safe" expiry)
    escalation: t.string(), // next action: sms_sent | sms_resend | agent_call | field_visit | recheck
    vulnerable: t.bool(),
    cellPriority: t.string(),
  }
);

/**
 * Singleton (id = 0): simulated staff working the outreach queue during the replay (demo only).
 * Every STAFF_STEP_MIN sim minutes: the referral desk refers new needs-help reports (the agency
 * acknowledges and resolves on a timer), agents call the top of unaccounted_queue, adjusters visit
 * households that calls could not reach. Outcomes come from the private sim truth.
 */
export const staffSim = table(
  { name: 'staff_sim', public: true },
  {
    id: t.u32().primaryKey(),
    enabled: t.bool(),
    callsPerHour: t.u32(),
    visitsPerHour: t.u32(),
    inspectionsPerHour: t.u32(), // property track: adjusters inspect the top of inspection_candidate
    lastRunMin: t.f64(),
    callsMade: t.u32(),
    callsReached: t.u32(),
    visitsMade: t.u32(),
    referralsMade: t.u32(),
    referralsResolved: t.u32(),
    helpFound: t.u32(), // households that needed help and were found by a staff call or visit
    visitsNobodyHome: t.u32(), // visits that inspected the property but found no occupants
    inspectionsMade: t.u32(), // property inspections (inspection_candidate), separate from welfare visits
    updatedAt: t.timestamp(),
  }
);

/** Private: staff call attempts per household. */
export const staffContact = table(
  { name: 'staff_contact' },
  {
    householdId: t.string().primaryKey(),
    failedCalls: t.u8(), // consecutive unanswered calls (reset when reached)
    lastCallMin: t.f64(),
    locateTries: t.u8(), // emergency-contact attempts after a visit found nobody home
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
    accounted: t.u32(), // households we have heard from (reply, claim or field report)
    unaccounted: t.u32(), // the number to drive to zero
    accountedRate: t.f64(),
    vulnerable: t.u32(),
    vulnerableAccounted: t.u32(),
    vulnerableAccountedRate: t.f64(), // equity check: compare with accountedRate
    highRiskUnaccounted: t.u32(),
    longestWaitMin: t.f64(), // the longest wait among high-risk unaccounted households
    openReferrals: t.u32(),
    overdueReferrals: t.u32(),
    membersMissing: t.u32(),
    closedNoContact: t.u32(),
    recheckDue: t.u32(),
    callContacts: t.u32(),
    assistanceRequests: t.u32(),
    inspectionRequests: t.u32(),
    locateDue: t.u32(),
    // Region total of severely damaged households with its 90% interval (sum of cell means, sd = sqrt of summed
    // cell variances, rounded outward and clipped to [sum of cell lo, sum of cell hi]); severeIntervalWidth = sum of cell widths.
    expectedSevereTotal: t.f64(),
    severeTotalLo: t.f64(),
    severeTotalHi: t.f64(),
    severeIntervalWidth: t.f64(),
    intervalCoverageLive: t.f64(), // share of cells whose 90% severe-count interval contains the simulated true count (demo honesty check)
    intervalCellsLive: t.u32(),
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
  needType: t.string(),
  location: t.string(),
  returnMin: t.f64(),
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
  damageKnown: t.bool(),
  lifeSafety: t.bool(),
  needs: t.string(),
  notHome: t.bool(),
  channel: t.string(),
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
  householdFollowup,
  unaccountedQueue,
  staffSim,
  staffContact,
  metrics,
  modelState,
  member,
  assignment,
});
export default spacetimedb;

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
