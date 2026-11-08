// Input/output types for the fusion adapter. Everything here is plain data (no ctx), so any
// estimator (the real engine copied from engine/src, or the temporary stub) can be plugged in.
import type {
  Damage,
  Facility,
  HexCell,
  HexEstimate,
  Household,
  HouseholdEstimate,
  ModelParams,
  Peril,
  Safety,
} from './contract';
import type { WorldContext, WorldRefs } from './engine/features.ts';

export type { WorldContext, WorldRefs };

export interface SourceTrust {
  hazard: number;
  sms: number;
  claims: number;
}

/** Everything we know about one household at the current sim time (latest event of each kind). */
export interface HouseholdSignals {
  household: Household;
  smsSentT: number | null; // first time a text was sent
  /** Latest reply (SMS or agent call). damage null = the reply does not describe the home. */
  reply: {
    t: number;
    safety: 'safe' | 'needs_help';
    damage: Damage | null;
    lifeSafety: boolean;
    needs: string[];
    notHome: boolean;
    channel: 'sms' | 'call';
  } | null;
  claim: { t: number; peril: Peril; reportedDamage: Damage } | null;
  field: { t: number; safety: Safety; damage: Damage; adjusterId: string } | null;
}

export interface CellInput {
  cell: HexCell;
  households: HouseholdSignals[];
  facilities: Facility[]; // facilities located in this cell
  nowMin: number; // sim minutes after landfall
  world: WorldContext; // hazard type, horizon, daytime / school-hours flags
  trust: SourceTrust; // current (learned) source trust
  params: ModelParams | null; // model.json if loaded
}

/** The per-cell counters world reference rates are computed from (persisted in `cell_agg`). */
export interface RefsCounters {
  hex: string;
  outage: number;
  daytime: boolean;
  smsSent: number;
  replied: number;
  sentEnHome: number;
  repliedEnHome: number;
  sentLeHome: number;
  repliedLeHome: number;
  sentEnAway: number;
  repliedEnAway: number;
  sentLeAway: number;
  repliedLeAway: number;
  exposureOwner: number;
  exposureRenter: number;
  claimsOwner: number;
  claimsRenter: number;
}

export interface HouseholdOutput extends HouseholdEstimate {
  inspectScore: number; // 0..1, active-inspection ranking
}

export interface CellOutput {
  households: HouseholdOutput[];
  hex: HexEstimate; // includes hazard, reason, silenceCause (v2), severeLo / severeHi (v3)
  /** variance of the cell's severe-household count (engine only; region totals add these) */
  severeVar?: number;
}

/**
 * A pluggable estimator, run in three phases so world reference rates can be computed from the
 * up-to-date aggregates of every cell before any cell is estimated:
 *   prepare(input)        per cell: aggregate signals (pure)
 *   refsCounters(prepared) per cell: counters to persist for computeRefs (null = estimator needs no refs)
 *   estimate(prepared, refs)
 */
export interface CellEstimator {
  name: 'stub' | 'engine';
  needsRefs: boolean;
  prepare(input: CellInput): PreparedCell;
  refsCounters(p: PreparedCell): RefsCounters | null;
  estimate(p: PreparedCell, refs: WorldRefs | null): CellOutput;
}

/** Opaque per-estimator state between phases. */
export interface PreparedCell {
  input: CellInput;
  [k: string]: unknown;
}
