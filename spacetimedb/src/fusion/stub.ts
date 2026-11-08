// =============================================================================
// TEMPORARY rule-based estimator.
// Used until the real fusion engine (engine/src, logistic regression calibrated on backtests) is
// copied into spacetimedb/src/fusion/engine/ and wired in `fusion/index.ts`. It stays as the
// fallback when data/model.json has not been loaded.
//
// Product rules it implements (docs/BACKGROUND.md):
//  - High hazard + heavy outage + low reply rate  => suspected P0, needs_verification
//    ("silence is not safety": no reply never lowers the estimate).
//  - Any help reply (or high P(needs help))        => P0.
//  - Field reports override the household estimate (verified, near-zero uncertainty).
//  - Source trust weights how much each signal moves the estimate.
// =============================================================================
import type { Damage, HexCell, Priority, Verification } from './contract';
import type { CellEstimator, CellInput, CellOutput, HouseholdOutput, HouseholdSignals, PreparedCell } from './types';

const REPLY_GRACE_MIN = 180; // a text sent less than this long ago is not "due" a reply yet
const NORMAL_SIGNAL_RATE = 0.6; // share of texted households we would hear from with working networks

export const HIGH_WIND_MPH = 110;
export const HIGH_FLOOD_FT = 4;
export const HEAVY_OUTAGE_PCT = 70;
export const LOW_REPLY_RATE = 0.15;

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const entropy = (p: number) => {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return -(q * Math.log2(q) + (1 - q) * Math.log2(1 - q));
};

const hasIndex = (cell: HexCell) => typeof cell.hazardIndex === 'number' && Number.isFinite(cell.hazardIndex);

export function isHighHazard(cell: HexCell): boolean {
  if (hasIndex(cell)) return (cell.hazardIndex as number) >= 0.5;
  return cell.windMph >= HIGH_WIND_MPH || cell.floodDepthFt >= HIGH_FLOOD_FT;
}

/** Hazard-only log-odds of damage >= 2 for a household in this cell (hazardIndex when present). */
export function hazardLogit(cell: HexCell): number {
  if (hasIndex(cell)) return 6 * ((cell.hazardIndex as number) - 0.55) + 0.35 * (cell.analystZone - 1);
  const w = (cell.windMph - 60) / 26;
  const f = cell.floodDepthFt / 2.7;
  const hz = Math.max(w, f) + 0.25 * Math.min(Math.max(w, 0), Math.max(f, 0));
  return 2.4 * (hz - 1.9) + 0.35 * (cell.analystZone - 1);
}

const SMS_DAMAGE_SHIFT: Record<Damage, number> = { 0: -2.2, 1: -1.0, 2: 1.4, 3: 2.4 };
const CLAIM_DAMAGE_SHIFT: Record<Damage, number> = { 0: -1.0, 1: -0.6, 2: 1.2, 3: 2.0 };

function estimateHousehold(s: HouseholdSignals, input: CellInput): HouseholdOutput {
  const { cell, trust, nowMin } = input;
  const h = s.household;
  const silentDue =
    s.smsSentT !== null && nowMin - s.smsSentT >= REPLY_GRACE_MIN && !s.reply && !s.claim;
  const cutOff = cell.towerOutagePct >= 60 && isHighHazard(cell);

  if (s.field) {
    const pSevere = s.field.damage >= 2 ? 0.97 : 0.03;
    const pNeedsHelp =
      s.field.safety === 'needs_help' ? 0.97 : s.field.safety === 'unsure' ? 0.5 : 0.03;
    return {
      householdId: h.id,
      pSevere,
      pNeedsHelp,
      uncertainty: s.field.safety === 'unsure' ? 0.25 : 0.05,
      verified: true,
      inspectScore: 0,
    };
  }

  // P(severe): hazard prior + self-report + claim, each weighted by source trust.
  let logit = hazardLogit(cell) * (0.4 + 0.6 * trust.hazard);
  if (s.reply && s.reply.damage !== null) logit += SMS_DAMAGE_SHIFT[s.reply.damage] * (0.4 + 0.8 * trust.sms);
  if (s.claim) logit += CLAIM_DAMAGE_SHIFT[s.claim.reportedDamage] * (0.4 + 0.8 * trust.claims);
  const pSevere = sigmoid(logit);

  // P(needs help): vulnerability + severity, then the household's own answer.
  let help =
    -5.0 +
    2.6 * pSevere +
    (h.age65 ? 0.5 : 0) +
    (h.age65 && h.livesAlone ? 1.2 : 0) +
    (h.medicalDevice ? (cell.towerOutagePct > 60 ? 1.8 : 0.5) : 0) +
    (cell.floodDepthFt > 4 ? 0.6 : 0);
  if (s.reply?.safety === 'needs_help') help += 3.0 * (0.4 + 0.8 * trust.sms);
  else if (s.reply?.safety === 'safe') help -= 2.5 * (0.4 + 0.8 * trust.sms);
  else if (silentDue && cutOff) help += 0.4; // cannot reach them in a hard-hit, cut-off cell
  const pNeedsHelp = sigmoid(help);

  const info = s.reply && s.claim ? 0.35 : s.reply ? 0.45 : s.claim ? 0.55 : 0.9;
  const uncertainty = clamp01(info * (0.6 + 0.4 * entropy(pSevere)));
  const inspectScore = clamp01(uncertainty * Math.min(1, 0.25 + 0.6 * pSevere + 1.2 * pNeedsHelp));
  return { householdId: h.id, pSevere, pNeedsHelp, uncertainty, verified: false, inspectScore };
}

function fmt(n: number, digits = 0) {
  return n.toFixed(digits);
}

export function estimateCellStub(input: CellInput): CellOutput {
  const { cell, households, nowMin } = input;
  const outs = households.map(s => estimateHousehold(s, input));
  const n = outs.length;

  let expectedSevere = 0;
  let maxPNeedsHelp = 0;
  let sumUnc = 0;
  for (const o of outs) {
    expectedSevere += o.pSevere;
    maxPNeedsHelp = Math.max(maxPNeedsHelp, o.pNeedsHelp);
    sumUnc += o.uncertainty;
  }
  const severity = n ? expectedSevere / n : 0;
  const confidence = n ? clamp01(1 - sumUnc / n) : 0;

  let texted = 0;
  let replies = 0;
  let claims = 0;
  let fieldReports = 0;
  let due = 0;
  let dueReplied = 0;
  let dueHeard = 0;
  let heard = 0;
  let helpReplies = 0; // latest reply says needs_help and no field report cleared it
  let fieldHelp = 0;
  for (const s of households) {
    if (s.smsSentT !== null) texted++;
    if (s.reply) replies++;
    if (s.claim) claims++;
    if (s.field) fieldReports++;
    if (s.reply || s.claim || s.field) heard++;
    if (s.smsSentT !== null && nowMin - s.smsSentT >= REPLY_GRACE_MIN) {
      due++;
      if (s.reply) dueReplied++;
      if (s.reply || s.claim || s.field) dueHeard++;
    }
    if (s.field?.safety === 'needs_help') fieldHelp++;
    else if (!s.field && s.reply?.safety === 'needs_help') helpReplies++;
  }

  const silence = due > 0 ? clamp01(1 - dueHeard / (NORMAL_SIGNAL_RATE * due)) : 0;
  const verifiedFrac = n ? fieldReports / n : 0;
  const high = isHighHazard(cell);
  const heavyOutage = cell.towerOutagePct >= HEAVY_OUTAGE_PCT;
  const lowReply = due > 0 ? dueReplied / due < LOW_REPLY_RATE : true; // nothing due yet = no evidence of safety
  const suspectedSilent = high && (heavyOutage || hasIndex(cell)) && lowReply && verifiedFrac < 0.25;

  const reasons: string[] = [];
  let priority: Priority;
  if (fieldHelp > 0 || helpReplies > 0 || maxPNeedsHelp >= 0.5 || suspectedSilent) {
    priority = 'P0';
    if (fieldHelp > 0) reasons.push(`${fieldHelp} field report(s) say needs help`);
    if (helpReplies > 0) reasons.push(`${helpReplies} help repl${helpReplies === 1 ? 'y' : 'ies'}`);
    if (suspectedSilent)
      reasons.push(
        `suspected: wind ${fmt(cell.windMph)} mph, flood ${fmt(cell.floodDepthFt, 1)} ft, outage ${fmt(cell.towerOutagePct)}%, ${dueReplied}/${due} replied`
      );
    if (!fieldHelp && !helpReplies && !suspectedSilent)
      reasons.push(`vulnerable household, P(needs help) ${fmt(maxPNeedsHelp * 100)}%`);
  } else if (severity >= 0.3 || expectedSevere >= 3 || maxPNeedsHelp >= 0.2 || high) {
    priority = 'P1';
    reasons.push(`~${fmt(expectedSevere, 1)} of ${n} likely severe`);
    if (high) reasons.push('high hazard');
  } else {
    priority = 'P2';
    reasons.push(`low expected damage (~${fmt(expectedSevere, 1)} of ${n})`);
  }

  const signalFrac = n ? heard / n : 0;
  const verification: Verification =
    verifiedFrac >= 0.25 || (signalFrac >= 0.6 && silence < 0.3 && !suspectedSilent)
      ? 'verified'
      : 'needs_verification';
  if (fieldReports > 0) reasons.push(`${fieldReports}/${n} field-verified`);
  else if (verification === 'needs_verification' && silence >= 0.5)
    reasons.push(`silence ${fmt(silence * 100)}%`);

  return {
    households: outs,
    hex: {
      hex: cell.hex,
      households: n,
      expectedSevere,
      maxPNeedsHelp,
      severity,
      confidence,
      priority,
      verification,
      silence,
      counts: { smsSent: texted, smsReplies: replies, claims, fieldReports },
      hazard: hasIndex(cell) ? (cell.hazardIndex as number) : sigmoid(hazardLogit(cell)),
      reason: `TEMPORARY rules (no model loaded): ${reasons.join('; ')}`,
    },
  };
}

export const stubEstimator: CellEstimator = {
  name: 'stub',
  needsRefs: false,
  prepare: (input: CellInput): PreparedCell => ({ input }),
  refsCounters: () => null,
  estimate: (p: PreparedCell) => estimateCellStub(p.input),
};
