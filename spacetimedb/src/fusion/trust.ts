// Batched source-trust learning (learning loop, step 2 in docs/BACKGROUND.md), using the engine's
// rules (engine/src/learning.ts): every field report on a NON-holdout household records each
// source's opinion of P(damage >= 2) before the report; after `batchSize` reports each source's
// trust moves a capped step toward 1 - Brier of its opinions. Holdout reports never count.
// The running sums live in model_state so this works across reducer calls.
import type { HexCell } from './contract';
import type { HouseholdSignals, SourceTrust } from './types';
import { DEFAULT_CONFIG } from './engine/config.ts';
import { hazardScore } from './engine/features.ts';
import { stepTrust, type BatchScores } from './engine/learning.ts';

const cfg = DEFAULT_CONFIG;
export const TRUST_BATCH = cfg.trust.batchSize;
/** Used when no model is loaded (the stub estimator). */
export const DEFAULT_TRUST: SourceTrust = { hazard: 0.6, sms: 0.7, claims: 0.65 };

/** Each source's own P(severe) for a household, before its field report (engine sourceOpinions). */
export function sourceOpinions(cell: HexCell, before: HouseholdSignals) {
  return {
    hazard: hazardScore(cell, cfg),
    sms: before.reply ? before.reply.damage / 3 : null,
    claims: before.claim ? before.claim.reportedDamage / 3 : null,
  };
}

export interface PendingSums {
  hazardSse: number;
  hazardN: number;
  smsSse: number;
  smsN: number;
  claimsSse: number;
  claimsN: number;
}

/** 1 - Brier per source over the batch; null when a source voiced too few opinions. */
export function batchScores(p: PendingSums): BatchScores {
  const score = (sse: number, n: number) => (n >= cfg.trust.minOpinionsPerSource ? 1 - sse / n : null);
  return {
    hazard: score(p.hazardSse, p.hazardN),
    sms: score(p.smsSse, p.smsN),
    claims: score(p.claimsSse, p.claimsN),
  };
}

export function nextTrust(trust: SourceTrust, scores: BatchScores): SourceTrust {
  return stepTrust(trust, scores, cfg);
}
