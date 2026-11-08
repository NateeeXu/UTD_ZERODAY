// Adapter for the real fusion engine (copied from engine/src into ./engine by scripts/sync-engine.ts).
// For one cell it builds the engine's Snapshot (that cell + world reference rates + world context +
// the cell's facilities) and calls the engine's own aggregateCellCounts / estimateCellHouseholds /
// classifyCell / attachInspectScores, so results match the engine's whole-world estimateAll.
import type { ModelParams } from './contract';
import { isCallbackOnly } from './reply';
import type { CellEstimator, CellInput, CellOutput, HouseholdSignals, PreparedCell, RefsCounters, SourceTrust } from './types';
import { DEFAULT_CONFIG } from './engine/config.ts';
import {
  aggregateCellCounts,
  computeRefs,
  fillExpected,
  newAggregate,
  type CellAggregate,
  type HouseholdSignals as EngineSignals,
  type Snapshot,
  type WorldContext,
  type WorldRefs,
} from './engine/features.ts';
import {
  attachInspectScores,
  classifyCell,
  estimateCellHouseholds,
  resolveModels,
  severeIntervalFor,
  validateParams,
  type ResolvedModels,
} from './engine/infer.ts';

export type EngineEstimator = CellEstimator & { supports(params: ModelParams): boolean };

const cfg = DEFAULT_CONFIG;
export const INSPECT_PER_CELL = cfg.active.perCellCap;

// ----- caches (derived data only; safe across reducer calls) ------------------

const validCache = new Map<string, boolean>();
let modelsCache: { key: string; models: ResolvedModels } | null = null;

const paramsKey = (p: ModelParams) => `${p.version}|${p.features.length}|${p.severe.bias}|${p.needsHelp.bias}`;

function models(params: ModelParams, trust: SourceTrust): ResolvedModels {
  const key = `${paramsKey(params)}|${trust.hazard}|${trust.sms}|${trust.claims}`;
  if (!modelsCache || modelsCache.key !== key) modelsCache = { key, models: resolveModels(params, cfg, trust) };
  return modelsCache.models;
}

// ----- conversions -----------------------------------------------------------

/**
 * What the model sees of the replies. A call-back-only reply that describes damage still counts for the
 * damage; the model has no "safety unknown", so its safety is the earlier reply's, or "no help requested".
 */
function engineReply(s: HouseholdSignals): HouseholdSignals['reply'] {
  const r = s.reply;
  if (!r || !isCallbackOnly(r) || r.damage === null) return s.evidenceReply;
  return { ...r, safety: s.evidenceReply?.safety ?? 'safe' };
}

function toEngineSignals(s: HouseholdSignals): EngineSignals {
  const reply = engineReply(s);
  return {
    smsSent: s.smsSentT !== null ? 1 : 0,
    firstSmsT: s.smsSentT,
    reply,
    replies: reply ? 1 : 0,
    claim: s.claim,
    claims: s.claim ? 1 : 0,
    fieldReport: s.field,
    fieldReports: s.field ? 1 : 0,
  };
}

const REFS_KEYS = [
  'smsSent',
  'replied',
  'sentEnHome',
  'repliedEnHome',
  'sentLeHome',
  'repliedLeHome',
  'sentEnAway',
  'repliedEnAway',
  'sentLeAway',
  'repliedLeAway',
  'exposureOwner',
  'exposureRenter',
  'claimsOwner',
  'claimsRenter',
] as const;

/** World reference rates from the persisted per-cell counters (engine computeRefs). */
export function engineWorldRefs(rows: Iterable<RefsCounters>, world: WorldContext): WorldRefs {
  const aggs: CellAggregate[] = [];
  for (const r of rows) {
    // computeRefs only reads the counters below plus outage/daytime; the rest stays zero.
    const agg = newAggregate(
      { hex: r.hex, lat: 0, lng: 0, windMph: 0, floodDepthFt: 0, towerOutagePct: 0, analystZone: 0 },
      cfg,
      world
    );
    agg.outage = r.outage;
    agg.daytime = r.daytime;
    for (const k of REFS_KEYS) agg[k] = r[k];
    aggs.push(agg);
  }
  return computeRefs(aggs, cfg);
}

// ----- estimator ---------------------------------------------------------------

interface EnginePrepared extends PreparedCell {
  members: CellInput['households'][number]['household'][];
  signals: Map<string, EngineSignals>;
  agg: CellAggregate;
}

function prepare(input: CellInput): EnginePrepared {
  const members = input.households.map(s => s.household);
  const signals = new Map(input.households.map(s => [s.household.id, toEngineSignals(s)] as const));
  const agg = aggregateCellCounts(input.cell, members, signals, cfg, input.world);
  return { input, members, signals, agg };
}

function refsCounters(p: PreparedCell): RefsCounters {
  const { agg } = p as EnginePrepared;
  const out = { hex: agg.hex, outage: agg.outage, daytime: agg.daytime } as RefsCounters;
  for (const k of REFS_KEYS) out[k] = agg[k];
  return out;
}

function estimate(p: PreparedCell, refs: WorldRefs | null): CellOutput {
  const { input, members, signals, agg } = p as EnginePrepared;
  if (!input.params) throw new Error('engine estimator needs ModelParams');
  if (!refs) throw new Error('engine estimator needs world refs');
  const { cell } = input;
  fillExpected(agg, refs);
  const snap: Snapshot = {
    t: input.nowMin,
    world: {
      eventId: 'spacetime',
      name: '',
      landfallIso: '',
      center: { lat: cell.lat, lng: cell.lng },
      hexes: [cell],
      households: members,
    },
    ctx: input.world,
    cellById: new Map([[cell.hex, cell]]),
    householdById: new Map(members.map(h => [h.id, h] as const)),
    householdsByHex: new Map([[cell.hex, members]]),
    signals,
    cells: new Map([[cell.hex, agg]]),
    refs,
    facilitiesByHex: new Map([[cell.hex, input.facilities]]),
    cfg,
  };
  const m = models(input.params, input.trust);
  const raw = estimateCellHouseholds(members, snap, m, cfg); // includes the neighbour update
  const hex = classifyCell(agg, raw, cfg, { cell, facilities: input.facilities, schoolHours: input.world.schoolHours, tau2: m.overdispersion, tail: m.intervalTail });
  const households = attachInspectScores(raw, hex, cfg).map(e => ({ ...e, inspectScore: e.inspectScore ?? 0 }));
  // Same interval as hex.severeLo / severeHi; the variance lets the database add cells into a region total.
  const severeVar = severeIntervalFor(agg, raw, cfg, m.overdispersion, m.intervalTail).variance;
  return { households, hex, severeVar };
}

export const engineEstimator: EngineEstimator = {
  name: 'engine',
  needsRefs: true,
  supports(params: ModelParams) {
    const key = paramsKey(params);
    let ok = validCache.get(key);
    if (ok === undefined) {
      try {
        validateParams(params);
        ok = true;
      } catch (e) {
        console.warn(`model rejected by engine, using stub: ${String(e)}`);
        ok = false;
      }
      validCache.set(key, ok);
    }
    return ok;
  },
  prepare,
  refsCounters,
  estimate,
};
