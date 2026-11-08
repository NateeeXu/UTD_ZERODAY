// All tunable thresholds of the fusion engine live in this one object so the
// rules behind P0/P1/P2 and verified/needs_verification can be read, shown in
// the UI and changed in a single place. Nothing in src/ hard-codes a cutoff.

import type { Priority } from '../../shared/types.ts';

export interface TriageConfig {
  /** How raw hazard numbers map to the 0-1 hazard score used by silence,
   *  expected-claims and the "high hazard" rule. */
  hazard: {
    /** Wind below this contributes nothing. */
    windMinMph: number;
    /** Wind at or above this saturates windNorm at 1. */
    windMaxMph: number;
    /** floodNorm = 1 - exp(-depthFt / floodScaleFt); 2 ft -> 0.63, 4 ft -> 0.86. */
    floodScaleFt: number;
    /** hazard = intensityWeight * max(windNorm, floodNorm) + zoneWeight * analystZone/2. */
    intensityWeight: number;
    zoneWeight: number;
  };
  /** Beta-prior smoothing for cell-level shares (counts + mean*strength) / (n + strength). */
  smoothing: {
    severePriorMean: number;
    helpPriorMean: number;
    priorStrength: number;
    /** Pseudo-count added to numerator and denominator of the claims ratio. */
    claimPseudo: number;
    /** log claims ratio is clipped to [-clip, clip]. */
    claimLogClip: number;
  };
  /** Silence = hazard * max(0, 1 - heardFrom / expectedHeard) * (1 - exp(-expectedHeard / expectedHeardScale)). */
  silence: {
    /** Cells with tower outage at or below this % define the reference reply rate. */
    lowOutageRefPct: number;
    /** Attenuates silence while few signals are expected yet (1 expected signal -> 63%, 3 -> 95%). */
    expectedHeardScale: number;
    /** Data-driven multipliers that condition the expected baselines (shrunk toward 1 with pseudo-observations, then clamped). */
    factors: {
      /** Pseudo SMS sends at the base rate when estimating the limited-English / away reply factors. */
      pseudoSends: number;
      minReplyFactor: number;
      maxReplyFactor: number;
      /** Pseudo exposure units at the owner rate when estimating the renter claim factor. */
      pseudoExposure: number;
      minClaimFactor: number;
      maxClaimFactor: number;
    };
  };
  /** Which silent households are counted as 'away' / 'trapped' and when a cause is assigned. */
  silenceCause: {
    /** Below this silence no cause is assigned (field left undefined). */
    minSilence: number;
    /** Tower outage at or above this share explains the silence by itself. */
    outageExplains: number;
    /** A group (away / vulnerable) must be at least this share of the silent households ... */
    dominantShare: number;
    /** ... and over-represented among them by this factor relative to the whole cell. */
    overRepresentation: number;
  };
  /** Insurance coverage conditioning for the expected-claims baseline. */
  coverage: {
    /** Claims multiplier for a peril the household is not insured for (flood w/o flood policy, quake w/o endorsement). */
    uninsuredClaimFactor: number;
  };
  /** Event time of day (local hours, weekday only). */
  daytime: {
    /** awayDaytime households are away when the event falls in [workStartHour, workEndHour). */
    workStartHour: number;
    workEndHour: number;
    /** School-age children are at school when the event falls in [schoolStartHour, schoolEndHour]. */
    schoolStartHour: number;
    schoolEndHour: number;
  };
  /** Cell confidence. */
  confidence: {
    /** Coverage (share of households heard from) needed for full evidence score at hazard 0 ... */
    minRequiredCoverage: number;
    /** ... plus this much more per unit of hazard (hazard 1 -> min + slope). */
    hazardCoverageSlope: number;
    /** Multiplicative penalty: confidence *= 1 - outagePenalty * outage * (1 - coverageScore). */
    outagePenalty: number;
  };
  /** Household uncertainty = pWeight * 2*sqrt(p(1-p)) + evidenceWeight * (1 - evidenceScore). */
  uncertainty: {
    pWeight: number;
    evidenceWeight: number;
    /** Neighbour coverage at which a household without its own signal counts as fully evidenced. */
    neighbourCoverageForFullEvidence: number;
    /** Uncertainty assigned to a field-verified household. */
    verified: number;
    /** Uncertainty when the field report left safety as 'unsure'. */
    verifiedUnsureSafety: number;
  };
  /** Probabilities assigned to field-verified households (never exactly 0/1 so Brier/log-loss stay finite). */
  verifiedValues: { high: number; low: number };
  /**
   * How a field report moves the UNVERIFIED neighbours in the same cell:
   *   logit_i += gain * sum_j (y_j - pHat_j) / (k + shrinkageCount)
   * over the k verified households j of the cell, where pHat_j is the model's
   * own prediction for j (without its report). Findings that match the model
   * change nothing; surprises shift the cell, more so the more reports agree.
   * gain 0 disables the update.
   */
  neighbourUpdate: { gainSevere: number; gainHelp: number; shrinkageCount: number };
  thresholds: {
    /** P0 if any household in the cell has pNeedsHelp >= this ... */
    p0HelpProb: number;
    /** ... or the expected severe share (expectedSevere / households) >= this. */
    p0SevereShare: number;
    /** P1 if any pNeedsHelp >= this ... */
    p1HelpProb: number;
    /** ... or expected severe share >= this. */
    p1SevereShare: number;
    /** needs_verification if confidence < this ... */
    confidence: number;
    /** ... or (hazard >= highHazard AND silence >= highSilence). */
    highHazard: number;
    highSilence: number;
    /** A high-hazard silent cell is raised to at least this tier ("suspected P0") and always needs verification. */
    silentHighHazardFloor: Priority;
  };
  /** Global source-trust learning loop. */
  trust: {
    /** Trust is only updated after this many NON-holdout field reports have accumulated. */
    batchSize: number;
    /** Each batch moves trust at most learningRate * |batchScore - trust|. */
    learningRate: number;
    min: number;
    max: number;
    /** A source needs at least this many opinions in a batch to be scored. */
    minOpinionsPerSource: number;
    /** Multiplier on a source's learned weights, clamped: trust / calibrationTrust. */
    effectClamp: { min: number; max: number };
    /**
     * If false (default), trust is display-only and never touches inference.
     * Off by default because field reports are chosen by active inspection
     * (the most extreme, silent cells), where the hazard signal is trivially
     * right; feeding that back into the weights is a selection bias and made
     * holdout Brier slightly worse in replay. The mechanism is kept, tested,
     * and can be switched on once reports are sampled more evenly.
     */
    applyToInference: boolean;
  };
  /** Active inspection scoring. */
  active: {
    wSevere: number;
    wHelp: number;
    wUncertainty: number;
    wSilence: number;
    /** Bonus for households in cells flagged needs_verification. */
    wNeedsVerification: number;
    /** At most this many recommendations per cell in one batch (spreads adjusters). */
    perCellCap: number;
  };
  /** Horizon used to normalise time since landfall (minutes). */
  horizonMinutes: number;
}

export const DEFAULT_CONFIG: TriageConfig = {
  hazard: {
    windMinMph: 50,
    windMaxMph: 130,
    floodScaleFt: 2,
    intensityWeight: 0.75,
    zoneWeight: 0.25,
  },
  smoothing: {
    severePriorMean: 0.3,
    helpPriorMean: 0.1,
    priorStrength: 2,
    claimPseudo: 0.5,
    claimLogClip: 3,
  },
  silence: {
    lowOutageRefPct: 20,
    expectedHeardScale: 1,
    factors: {
      pseudoSends: 20,
      minReplyFactor: 0.2,
      maxReplyFactor: 1.5,
      pseudoExposure: 20,
      minClaimFactor: 0.1,
      maxClaimFactor: 1.5,
    },
  },
  silenceCause: {
    minSilence: 0.2,
    outageExplains: 0.5,
    dominantShare: 0.5,
    overRepresentation: 1.2,
  },
  coverage: {
    uninsuredClaimFactor: 0.1,
  },
  daytime: {
    workStartHour: 8,
    workEndHour: 18,
    schoolStartHour: 8,
    schoolEndHour: 15,
  },
  confidence: {
    minRequiredCoverage: 0.15,
    hazardCoverageSlope: 0.35,
    outagePenalty: 0.5,
  },
  uncertainty: {
    pWeight: 0.6,
    evidenceWeight: 0.4,
    neighbourCoverageForFullEvidence: 0.5,
    verified: 0.02,
    verifiedUnsureSafety: 0.1,
  },
  verifiedValues: { high: 0.98, low: 0.02 },
  neighbourUpdate: { gainSevere: 2, gainHelp: 2, shrinkageCount: 2 },
  thresholds: {
    p0HelpProb: 0.5,
    p0SevereShare: 0.5,
    p1HelpProb: 0.25,
    p1SevereShare: 0.2,
    confidence: 0.5,
    highHazard: 0.5,
    highSilence: 0.5,
    silentHighHazardFloor: 'P0',
  },
  trust: {
    batchSize: 10,
    learningRate: 0.1,
    min: 0.3,
    max: 1,
    minOpinionsPerSource: 3,
    effectClamp: { min: 0.6, max: 1.4 },
    applyToInference: false,
  },
  active: {
    wSevere: 1,
    wHelp: 1,
    wUncertainty: 0.8,
    wSilence: 0.5,
    wNeedsVerification: 0.2,
    perCellCap: 3,
  },
  horizonMinutes: 4320,
};

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
