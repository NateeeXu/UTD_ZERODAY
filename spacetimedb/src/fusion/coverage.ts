// Coverage-aware property inspection queue (pure, no ctx; scripts/parity.ts uses it too).
// An adjuster inspects a house only if State Farm insures that structure against this event's peril,
// or the household already filed a claim. Everyone still gets estimates, accounting and escalation, and
// counts in hex_stats and the severe-count intervals: the map shows the disaster itself.
import type { HazardType, Household } from './contract';

/**
 * Eligible for inspection_candidate: a claim was filed, or the policy covers the structure (homeowners,
 * condo, or no policy type in the bundle) against the peril: hurricane -> wind or flood policy,
 * earthquake -> earthquake endorsement. Renters (contents only; the landlord insures the building)
 * only via a claim.
 */
export function inspectionEligible(
  h: Pick<Household, 'policyType' | 'windCovered' | 'floodPolicy' | 'earthquakeEndorsement'>,
  hazardType: HazardType,
  hasClaim: boolean
): boolean {
  if (hasClaim) return true;
  if (h.policyType === 'renters') return false;
  return hazardType === 'earthquake' ? h.earthquakeEndorsement : h.windCovered || h.floodPolicy;
}
