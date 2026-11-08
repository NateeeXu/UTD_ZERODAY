// Owner-only seeding reducers (called by scripts/seed.ts), plus reset / repair.
import { SenderError, t } from 'spacetimedb/server';
import spacetimedb, { FacilityInput, HexInput, HouseholdInput, StagedEventInput, TruthInput, WorldInput } from '../schema';
import { DEFAULT_CONFIG } from '../fusion/engine/config.ts';
import { worldContext } from '../fusion/engine/features.ts';
import {
  freshLearning,
  getMetrics,
  getModelState,
  getReplay,
  isOwner,
  memberOf,
  requireManager,
  requireOwner,
  MAX_MINUTES,
  SINGLETON,
  touchWorld,
} from '../state';
import { baseTrust, clearDemoState, emptyStats, rebuildAll, refreshHoldoutMetrics } from '../ingest';

const KINDS = new Set(['sms_sent', 'sms_reply', 'claim', 'field_report']);
const SAFETY = new Set(['safe', 'needs_help', 'unsure']);
const PERILS = new Set(['wind', 'flood', 'earthquake']);
const HAZARD_TYPES = new Set(['hurricane', 'earthquake']);
const FACILITY_KINDS = new Set(['school', 'university', 'hospital', 'shelter', 'fire_station', 'mast']);
const POLICY_TYPES = new Set(['homeowners', 'renters', 'condo']);

function checkDamage(d: number, what: string) {
  if (!Number.isInteger(d) || d < 0 || d > 3) throw new SenderError(`${what}: damage must be 0..3`);
}

export const setPasscodes = spacetimedb.reducer(
  { name: 'set_passcodes' },
  { staffPasscode: t.string(), replyPasscode: t.string() },
  (ctx, { staffPasscode, replyPasscode }) => {
    requireOwner(ctx);
    if (staffPasscode.length < 4 || replyPasscode.length < 4)
      throw new SenderError('passcodes must be at least 4 characters');
    const cfg = ctx.db.config.id.find(SINGLETON);
    if (!cfg) throw new SenderError('config missing');
    ctx.db.config.id.update({ ...cfg, staffPasscode, replyPasscode });
  }
);

/** Upsert the world row; derives the engine WorldContext (local hour, daytime, school hours) once here. */
export const seedWorld = spacetimedb.reducer({ name: 'seed_world' }, { world: WorldInput }, (ctx, { world: w }) => {
  requireOwner(ctx);
  const hazardType = w.hazardType ?? 'hurricane';
  if (!HAZARD_TYPES.has(hazardType)) throw new SenderError(`hazardType must be hurricane or earthquake`);
  if (w.eventLocalHour !== undefined && w.eventLocalHour > 23) throw new SenderError('eventLocalHour must be 0..23');
  const horizonMinutes = w.horizonMinutes && w.horizonMinutes > 0 ? w.horizonMinutes : MAX_MINUTES;
  const wc = worldContext(
    {
      eventId: w.eventId,
      name: w.name,
      landfallIso: w.landfallIso,
      center: { lat: w.centerLat, lng: w.centerLng },
      hexes: [],
      households: [],
      region: w.region,
      hazardType: hazardType as 'hurricane' | 'earthquake',
      horizonMinutes,
      eventLocalHour: w.eventLocalHour,
      eventWeekday: w.eventWeekday,
    },
    DEFAULT_CONFIG
  );
  const row = {
    id: SINGLETON,
    eventId: w.eventId,
    name: w.name,
    landfallIso: w.landfallIso,
    centerLat: w.centerLat,
    centerLng: w.centerLng,
    region: w.region,
    hazardType,
    horizonMinutes,
    eventLocalHour: w.eventLocalHour,
    eventWeekday: w.eventWeekday,
    dataSourcesJson: JSON.stringify(w.dataSources),
    localHour: wc.localHour,
    weekday: wc.weekday,
    daytime: wc.daytime,
    schoolHours: wc.schoolHours,
    timeSource: wc.timeSource,
  };
  if (ctx.db.world.id.find(SINGLETON)) ctx.db.world.id.update(row);
  else ctx.db.world.insert(row);
  const rs = getReplay(ctx);
  ctx.db.replayState.id.update({ ...rs, maxMinutes: horizonMinutes });
});

export const seedFacilities = spacetimedb.reducer(
  { name: 'seed_facilities' },
  { facilities: t.array(FacilityInput) },
  (ctx, { facilities }) => {
    requireOwner(ctx);
    for (const f of facilities) {
      if (!FACILITY_KINDS.has(f.kind)) throw new SenderError(`${f.id}: unknown facility kind ${f.kind}`);
      if (ctx.db.facility.id.find(f.id)) ctx.db.facility.id.update(f);
      else ctx.db.facility.insert(f);
    }
    touchWorld(ctx);
  }
);

export const seedHexes = spacetimedb.reducer(
  { name: 'seed_hexes' },
  { hexes: t.array(HexInput) },
  (ctx, { hexes }) => {
    requireOwner(ctx);
    for (const h of hexes) {
      if (!h.hex) throw new SenderError('hex id required');
      if (h.analystZone > 2) throw new SenderError(`${h.hex}: analystZone must be 0..2`);
      if (ctx.db.hex.hex.find(h.hex)) ctx.db.hex.hex.update(h);
      else ctx.db.hex.insert(h);
      const s = ctx.db.hexStats.hex.find(h.hex);
      if (!s) ctx.db.hexStats.insert(emptyStats(ctx, h.hex, h.displayOrder));
      else if (s.displayOrder !== h.displayOrder) ctx.db.hexStats.hex.update({ ...s, displayOrder: h.displayOrder });
    }
    touchWorld(ctx);
  }
);

export const seedHouseholds = spacetimedb.reducer(
  { name: 'seed_households' },
  { households: t.array(HouseholdInput) },
  (ctx, { households }) => {
    requireOwner(ctx);
    for (const h of households) {
      if (!ctx.db.hex.hex.find(h.hex)) throw new SenderError(`${h.id}: unknown hex ${h.hex} (seed hexes first)`);
      if (h.policyType !== undefined && !POLICY_TYPES.has(h.policyType))
        throw new SenderError(`${h.id}: unknown policyType ${h.policyType}`);
      if (ctx.db.household.id.find(h.id)) ctx.db.household.id.update(h);
      else ctx.db.household.insert(h);
    }
    touchWorld(ctx);
    // hex_stats.households / metrics.households are recounted by reset_demo / recompute_all.
  }
);

export const seedTruth = spacetimedb.reducer(
  { name: 'seed_truth' },
  { rows: t.array(TruthInput) },
  (ctx, { rows }) => {
    requireOwner(ctx);
    for (const r of rows) {
      checkDamage(r.damage, r.householdId);
      if (r.safety !== 'safe' && r.safety !== 'needs_help') throw new SenderError(`${r.householdId}: bad safety`);
      if (ctx.db.simTruth.householdId.find(r.householdId)) ctx.db.simTruth.householdId.update(r);
      else ctx.db.simTruth.insert(r);
    }
  }
);

export const seedStagedEvents = spacetimedb.reducer(
  { name: 'seed_staged_events' },
  { events: t.array(StagedEventInput) },
  (ctx, { events }) => {
    requireOwner(ctx);
    for (const e of events) {
      if (!KINDS.has(e.kind)) throw new SenderError(`seq ${e.seq}: unknown kind ${e.kind}`);
      if (e.kind === 'sms_reply' && e.safety !== 'safe' && e.safety !== 'needs_help')
        throw new SenderError(`seq ${e.seq}: bad sms_reply safety`);
      if (e.kind === 'field_report' && !SAFETY.has(e.safety)) throw new SenderError(`seq ${e.seq}: bad safety`);
      if (e.kind === 'claim' && !PERILS.has(e.peril)) throw new SenderError(`seq ${e.seq}: bad peril`);
      checkDamage(e.damage, `seq ${e.seq}`);
      checkDamage(e.reportedDamage, `seq ${e.seq}`);
      if (ctx.db.stagedEvent.seq.find(e.seq)) ctx.db.stagedEvent.seq.update(e);
      else ctx.db.stagedEvent.insert(e);
    }
    const rs = getReplay(ctx);
    rs.totalStaged = Number(ctx.db.stagedEvent.count());
    ctx.db.replayState.id.update(rs);
  }
);

/** Store data/model.json (ModelParams) as a JSON string; resets learned trust to its sourceTrust. */
export const loadModel = spacetimedb.reducer({ name: 'load_model' }, { json: t.string() }, (ctx, { json }) => {
  requireOwner(ctx);
  let p: any;
  try {
    p = JSON.parse(json);
  } catch {
    throw new SenderError('model json does not parse');
  }
  const isNum = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  if (!p || !isNum(p.version) || !Array.isArray(p.features)) throw new SenderError('model: version/features missing');
  for (const head of ['severe', 'needsHelp']) {
    const h = p[head];
    if (!h || !isNum(h.bias) || !Array.isArray(h.weights) || h.weights.length !== p.features.length)
      throw new SenderError(`model: ${head} must have bias and one weight per feature`);
  }
  const w = ctx.db.world.id.find(SINGLETON);
  if (w && typeof p.region === 'string' && w.region && p.region !== w.region)
    throw new SenderError(`model is for region ${p.region} but this database holds ${w.region}`);
  if (w && typeof p.hazardType === 'string' && p.hazardType !== w.hazardType)
    throw new SenderError(`model is for ${p.hazardType} but this world is ${w.hazardType}`);
  const ms = getModelState(ctx);
  const trust = baseTrust(json);
  ctx.db.modelState.id.update({
    ...ms,
    loaded: true,
    version: Math.max(0, Math.floor(p.version)),
    paramsJson: json,
    baseTrustHazard: trust.hazard,
    baseTrustSms: trust.sms,
    baseTrustClaims: trust.claims,
    ...freshLearning(trust),
    updatedAt: ctx.timestamp,
  });
  const m = getMetrics(ctx);
  ctx.db.metrics.id.update({
    ...m,
    modelVersion: Math.max(0, Math.floor(p.version)),
    trustHazard: trust.hazard,
    trustSms: trust.sms,
    trustClaims: trust.claims,
    trustUpdates: 0,
  });
  // Estimates change with the model: recompute everything that already exists.
  if (ctx.db.hex.count() > 0n) rebuildAll(ctx);
});

/** Clear all events, estimates and assignments, rewind to t = 0 and recompute every cell. Owner or manager. */
export const resetDemo = spacetimedb.reducer({ name: 'reset_demo' }, ctx => {
  requireManager(ctx);
  clearDemoState(ctx);
  rebuildAll(ctx);
  console.info(`reset_demo by ${isOwner(ctx) ? 'owner' : (memberOf(ctx)?.name ?? '?')}`);
});

/** Recount every counter from the tables and recompute every cell (repair tool). Owner or manager. */
export const recomputeAll = spacetimedb.reducer({ name: 'recompute_all' }, ctx => {
  requireManager(ctx);
  rebuildAll(ctx);
});

/** Recompute the holdout metrics now. Owner or manager. */
export const refreshMetrics = spacetimedb.reducer({ name: 'refresh_metrics' }, ctx => {
  requireManager(ctx);
  refreshHoldoutMetrics(ctx);
});

/** Delete the whole world (hexes, households, truth, staged events, stats). Owner only. */
export const wipeWorld = spacetimedb.reducer({ name: 'wipe_world' }, ctx => {
  requireOwner(ctx);
  clearDemoState(ctx);
  ctx.db.world.clear();
  ctx.db.facility.clear();
  ctx.db.cellAgg.clear();
  ctx.db.hex.clear();
  ctx.db.household.clear();
  ctx.db.simTruth.clear();
  ctx.db.stagedEvent.clear();
  ctx.db.hexStats.clear();
  touchWorld(ctx);
  const rs = getReplay(ctx);
  ctx.db.replayState.id.update({ ...rs, totalStaged: 0, nextSeq: 0 });
  rebuildAll(ctx);
});
