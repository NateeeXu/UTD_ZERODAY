// Type-only re-export of the shared data contract (shared/types.ts).
// `export type` is erased by the module bundler, so nothing outside spacetimedb/ is bundled.
export type {
  HexId,
  Minutes,
  Damage,
  Safety,
  Priority,
  Verification,
  Peril,
  HexCell,
  Household,
  World,
  TruthRow,
  SimEvent,
  EventBundle,
  ModelParams,
  HouseholdEstimate,
  HexEstimate,
} from '../../../shared/types';
