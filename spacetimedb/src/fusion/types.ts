// Input/output types for the fusion adapter. Everything here is plain data (no ctx), so any
// estimator (the temporary stub or the real engine copied from engine/src) can be plugged in.
import type {
  Damage,
  HexCell,
  HexEstimate,
  Household,
  HouseholdEstimate,
  ModelParams,
  Peril,
  Safety,
} from './contract';

export interface SourceTrust {
  hazard: number;
  sms: number;
  claims: number;
}

/** Everything we know about one household at the current sim time (latest event of each kind). */
export interface HouseholdSignals {
  household: Household;
  smsSentT: number | null; // first time a text was sent
  reply: { t: number; safety: 'safe' | 'needs_help'; damage: Damage } | null;
  claim: { t: number; peril: Peril; reportedDamage: Damage } | null;
  field: { t: number; safety: Safety; damage: Damage; adjusterId: string } | null;
}

/** World-level reference rates at the current time (same meaning as engine WorldRefs). */
export interface WorldRefs {
  refReplyRate: number; // replies / texts among low-outage cells
  claimRatePerHazard: number; // claims / sum(households * hazard)
}

export interface CellInput {
  cell: HexCell;
  households: HouseholdSignals[];
  nowMin: number; // sim minutes after landfall
  trust: SourceTrust; // current (learned) source trust
  params: ModelParams | null; // data/model.json if loaded
  refs: WorldRefs | null; // only computed when the estimator needs it
}

export interface HouseholdOutput extends HouseholdEstimate {
  inspectScore: number; // 0..1, active-inspection ranking (severity x uncertainty)
}

export interface CellOutput {
  households: HouseholdOutput[];
  hex: HexEstimate;
  reason: string;
}

/** A pluggable estimator. `estimateCell` must be pure and deterministic. */
export interface CellEstimator extends RefsAware {
  name: 'stub' | 'engine';
  estimateCell(input: CellInput): CellOutput;
}

/** A pluggable estimator. `needsRefs` = compute WorldRefs before calling estimateCell. */
export interface RefsAware {
  needsRefs: boolean;
}
