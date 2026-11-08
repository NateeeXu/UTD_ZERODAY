// PLACEHOLDER fusion so the UI has something to render in local mode.
// A's engine/ owns the real model; once it exposes estimates (Spacetime
// hex_stats or a JS module), swap the call in state/TriageStore.tsx.
// Core output matches shared/types.ts; `HexView` adds UI-only extras
// (per-signal breakdown, expected claims) that the contract doesn't carry yet.
import type {
  HexCell, HexEstimate, HouseholdEstimate, ModelParams, Priority, SimEvent, World,
} from '@shared/types';

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export const DEFAULT_TRUST = { hazard: 0.7, sms: 0.6, claims: 0.5 };

export interface HexView extends HexEstimate {
  hazard: number;          // 0–1 prior from hazard + analyst zone
  helpReplies: number;     // SMS replies saying HELP
  expectedClaims: number;  // claims we'd expect to have arrived by now
  claimsGap: number;       // 0–1, how far claims lag what we'd expect
  replyRate: number;       // replies / sms sent
}

export interface EstimateResult {
  households: Map<string, HouseholdEstimate>;
  hexes: HexView[];
}

export function hazardOf(cell: HexCell): number {
  if (cell.hazardIndex != null) return clamp01(cell.hazardIndex);
  const wind = clamp01((cell.windMph - 60) / 70);
  const flood = clamp01(cell.floodDepthFt / 6);
  return clamp01(Math.max(wind, flood) + 0.25 * Math.min(wind, flood));
}

export function estimate(world: World, events: SimEvent[], t: number, model: ModelParams | null): EstimateResult {
  const trust = model?.sourceTrust ?? DEFAULT_TRUST;
  const hexById = new Map(world.hexes.map((h) => [h.hex, h]));

  const sent = new Set<string>();
  const reply = new Map<string, Extract<SimEvent, { kind: 'sms_reply' }>>();
  const claim = new Map<string, Extract<SimEvent, { kind: 'claim' }>>();
  const field = new Map<string, Extract<SimEvent, { kind: 'field_report' }>>();
  for (const e of events) {
    if (e.kind === 'sms_sent') sent.add(e.householdId);
    else if (e.kind === 'sms_reply') reply.set(e.householdId, e);
    else if (e.kind === 'claim') claim.set(e.householdId, e);
    else field.set(e.householdId, e);
  }

  // Share of eventual claims that should have arrived by t (median ~15 h).
  const claimArrived = t <= 30 ? 0 : 1 - Math.exp(-(t - 30) / (21 * 60));
  // Share of eventual replies that should have arrived by t (texts go out 60–180 min).
  const replyArrived = clamp01((t - 60) / 360);

  const households = new Map<string, HouseholdEstimate>();
  type Agg = {
    n: number; sumSevere: number; maxHelp: number; sumUnc: number; prior: number; expClaims: number;
    smsSent: number; smsReplies: number; helpReplies: number; claims: number; fieldReports: number; fieldHelp: number;
  };
  const agg = new Map<string, Agg>();

  for (const hh of world.households) {
    const cell = hexById.get(hh.hex);
    if (!cell) continue;
    const hz = hazardOf(cell);
    const priorSevere = sigmoid(-3 + 6 * hz + 0.5 * cell.analystZone);
    const vuln = (hh.age65 ? 0.5 : 0) + (hh.livesAlone && hh.age65 ? 1.0 : 0) + (hh.medicalDevice ? 1.2 : 0);
    const priorHelp = sigmoid(-5 + 3 * priorSevere + vuln + (cell.towerOutagePct > 60 && hh.medicalDevice ? 1 : 0));

    let pSevere = priorSevere;
    let pHelp = priorHelp;
    let uncertainty = 1; // hazard alone never counts as verified
    const r = reply.get(hh.id);
    if (r) {
      // v3 data: damage is null when the reply did not describe the home (sender not there).
      if (r.damage != null) pSevere = pSevere * (1 - trust.sms) + (r.damage >= 2 ? 0.9 : 0.1) * trust.sms;
      pHelp = r.safety === 'needs_help' ? Math.max(pHelp, 0.85) : pHelp * 0.3;
      uncertainty = Math.min(uncertainty, 1 - trust.sms * 0.8);
    }
    const c = claim.get(hh.id);
    if (c) {
      pSevere = pSevere * (1 - trust.claims) + (c.reportedDamage >= 2 ? 0.9 : 0.15) * trust.claims;
      uncertainty = Math.min(uncertainty, 1 - trust.claims * 0.8);
    }
    const f = field.get(hh.id);
    if (f) {
      // damage null = people checked, house not assessed: the property estimate stays as it was.
      if (f.damage != null) pSevere = f.damage >= 2 ? 0.98 : 0.02;
      pHelp = f.safety === 'needs_help' ? 0.98 : f.safety === 'unsure' ? 0.5 : 0.02;
      uncertainty = f.safety === 'unsure' ? 0.3 : 0.05;
    }
    households.set(hh.id, { householdId: hh.id, pSevere, pNeedsHelp: pHelp, uncertainty, verified: !!f && f.damage != null });

    const a = agg.get(hh.hex) ?? {
      n: 0, sumSevere: 0, maxHelp: 0, sumUnc: 0, prior: 0, expClaims: 0,
      smsSent: 0, smsReplies: 0, helpReplies: 0, claims: 0, fieldReports: 0, fieldHelp: 0,
    };
    a.n++;
    a.sumSevere += pSevere;
    a.maxHelp = Math.max(a.maxHelp, pHelp);
    a.sumUnc += uncertainty;
    a.prior += priorSevere;
    a.expClaims += (0.05 + 0.75 * priorSevere) * claimArrived;
    if (sent.has(hh.id)) a.smsSent++;
    if (r) a.smsReplies++;
    if (r?.safety === 'needs_help') a.helpReplies++;
    if (c) a.claims++;
    if (f) a.fieldReports++;
    if (f?.safety === 'needs_help') a.fieldHelp++;
    agg.set(hh.hex, a);
  }

  const hexes: HexView[] = [];
  for (const cell of world.hexes) {
    const a = agg.get(cell.hex);
    if (!a) continue;
    const meanSevere = a.sumSevere / a.n;
    const hazardPrior = a.prior / a.n;
    const severity = clamp01(0.6 * meanSevere + 0.4 * a.maxHelp);
    const confidence = clamp01(1 - a.sumUnc / a.n);
    const replyRate = a.smsSent ? a.smsReplies / a.smsSent : 0;
    // Silence: we expected to hear back by now (given hazard) and didn't.
    const expectedReply = 0.55 * replyArrived;
    const silence = a.smsSent && expectedReply > 0.05
      ? clamp01(hazardPrior * (1 - replyRate / expectedReply) * 1.3)
      : 0;
    const claimsGap = a.expClaims >= 0.5 ? clamp01((a.expClaims - a.claims) / (a.expClaims + 1)) : 0;

    let priority: Priority = 'P2';
    if (a.fieldHelp > 0 || (a.helpReplies > 0 && hazardPrior >= 0.5) || meanSevere >= 0.85 || (silence >= 0.7 && hazardPrior >= 0.75)) {
      priority = 'P0';
    } else if (meanSevere >= 0.4 || a.helpReplies > 0 || silence >= 0.4) {
      priority = 'P1';
    }

    hexes.push({
      hex: cell.hex,
      households: a.n,
      expectedSevere: a.sumSevere,
      maxPNeedsHelp: a.maxHelp,
      severity,
      confidence,
      priority,
      verification: a.fieldReports > 0 || confidence >= 0.3 ? 'verified' : 'needs_verification',
      silence,
      counts: { smsSent: a.smsSent, smsReplies: a.smsReplies, claims: a.claims, fieldReports: a.fieldReports },
      hazard: hazardOf(cell),
      helpReplies: a.helpReplies,
      expectedClaims: a.expClaims,
      claimsGap,
      replyRate,
    });
  }
  return { households, hexes };
}
