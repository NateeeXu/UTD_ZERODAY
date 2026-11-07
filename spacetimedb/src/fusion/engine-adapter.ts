// Adapter for the real fusion engine (copied from engine/src into ./engine by scripts/sync-engine.ts).
// For one cell it builds the engine's Snapshot (only that cell + world reference rates), then calls
// the engine's own estimateHousehold / classifyCell, so results match engine/scripts replay.
import type { HexCell, ModelParams } from './contract';
import type { CellEstimator, CellInput, CellOutput, HouseholdSignals, SourceTrust, WorldRefs } from './types';
import { DEFAULT_CONFIG } from './engine/config.ts';
import {
  aggregateCellCounts,
  computeRefs,
  fillExpected,
  newAggregate,
  type CellAggregate,
  type HouseholdSignals as EngineSignals,
  type Snapshot,
} from './engine/features.ts';
import { classifyCell, estimateCellHouseholds, resolveModels, validateParams, type ResolvedModels } from './engine/infer.ts';

export type EngineEstimator = CellEstimator & { supports(params: ModelParams): boolean };

const cfg = DEFAULT_CONFIG;

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

function toEngineSignals(s: HouseholdSignals): EngineSignals {
  return {
    smsSent: s.smsSentT !== null ? 1 : 0,
    firstSmsT: s.smsSentT,
    reply: s.reply,
    replies: s.reply ? 1 : 0,
    claim: s.claim,
    claims: s.claim ? 1 : 0,
    fieldReport: s.field,
    fieldReports: s.field ? 1 : 0,
  };
}

/** World reference rates from per-cell distinct-household counters (same formula as engine computeRefs). */
export function engineWorldRefs(
  cells: Iterable<{ cell: HexCell; households: number; smsSent: number; replied: number; claimed: number }>
): WorldRefs {
  const aggs: CellAggregate[] = [];
  for (const c of cells) {
    const agg = newAggregate(c.cell, cfg);
    agg.households = c.households;
    agg.smsSent = c.smsSent;
    agg.replied = c.replied;
    agg.claimed = c.claimed;
    aggs.push(agg);
  }
  return computeRefs(aggs, cfg);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function describe(cell: HexCell, agg: CellAggregate, out: CellOutput['hex']): string {
  const th = cfg.thresholds;
  const parts: string[] = [];
  if (agg.fieldHelp > 0) parts.push(`${agg.fieldHelp} field report(s) say needs help`);
  if (agg.helpReplies > 0) parts.push(`${agg.helpReplies} help repl${agg.helpReplies === 1 ? 'y' : 'ies'}`);
  if (out.maxPNeedsHelp >= th.p1HelpProb) parts.push(`max P(needs help) ${pct(out.maxPNeedsHelp)}`);
  parts.push(`~${out.expectedSevere.toFixed(1)} of ${out.households} likely severe`);
  if (out.silence >= 0.3)
    parts.push(`silence ${pct(out.silence)}: ${agg.replied}/${agg.smsSent} replied, outage ${Math.round(cell.towerOutagePct)}%`);
  if (agg.fieldReported > 0) parts.push(`${agg.fieldReported}/${out.households} field-verified`);
  if (out.verification === 'needs_verification') parts.push(`confidence ${pct(out.confidence)}`);
  return parts.join('; ');
}

// ----- estimator ---------------------------------------------------------------

function estimateCellEngine(input: CellInput): CellOutput {
  if (!input.params) throw new Error('engine estimator needs ModelParams');
  const { cell } = input;
  const members = input.households.map(s => s.household);
  const signals = new Map(input.households.map(s => [s.household.id, toEngineSignals(s)] as const));
  const refs = input.refs ?? { refReplyRate: 0, claimRatePerHazard: 0 };
  const agg = aggregateCellCounts(cell, members, signals, cfg);
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
    cellById: new Map([[cell.hex, cell]]),
    householdById: new Map(members.map(h => [h.id, h] as const)),
    householdsByHex: new Map([[cell.hex, members]]),
    signals,
    cells: new Map([[cell.hex, agg]]),
    refs,
    cfg,
  };
  const m = models(input.params, input.trust);
  const ests = estimateCellHouseholds(members, snap, m, cfg); // includes the engine's neighbour update
  const hex = classifyCell(agg, ests, cfg);

  // Active inspection score (engine active.ts formula), normalised to 0..1.
  const w = cfg.active;
  const wSum = w.wSevere + w.wHelp + w.wUncertainty + w.wSilence + w.wNeedsVerification;
  const nv = hex.verification === 'needs_verification' ? 1 : 0;
  const households = ests.map(e => ({
    ...e,
    inspectScore: e.verified
      ? 0
      : (w.wSevere * e.pSevere +
          w.wHelp * e.pNeedsHelp +
          w.wUncertainty * e.uncertainty +
          w.wSilence * hex.silence +
          w.wNeedsVerification * nv) /
        wSum,
  }));
  return { households, hex, reason: describe(cell, agg, hex) };
}

export const engineEstimator: EngineEstimator | null = {
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
  estimateCell: estimateCellEngine,
};
