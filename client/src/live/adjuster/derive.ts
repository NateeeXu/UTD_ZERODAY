// Pure helpers for the adjuster phone (docs/ADJUSTER_APP.md section 2.0 "derived fields").
// Everything here is computed on the client from rows the phone already subscribes to.
import { cellToLatLng } from 'h3-js';
import type { Identity, Infer } from 'spacetimedb';
import type SmsSentRowDef from '../../module_bindings/sms_sent_table.ts';
import type {
  AssignmentRow, FieldReportRow, HexRow, HexStatsRow, HouseholdEstimateRow, HouseholdFollowupRow, HouseholdRow, SmsReplyRow,
} from '../rows';
import { fmtT } from '../../format';

export type SmsSentRow = Infer<typeof SmsSentRowDef>;
export type LatLng = [number, number];

// ---- Levels: no percentages on the phone ----
export type Level = 'High' | 'Med' | 'Low';
export const helpLevel = (p: number): Level => (p >= 0.5 ? 'High' : p >= 0.25 ? 'Med' : 'Low');
export const damageLevel = (p: number): Level => (p >= 0.5 ? 'High' : p >= 0.2 ? 'Med' : 'Low');

// ---- Task type ----
export type TaskType = 'Welfare check' | 'Property inspection';
const WELFARE_STEPS = new Set(['field_visit', 'locate', 'recheck', 'emergency_referral']);
export function taskType(est: HouseholdEstimateRow | undefined): TaskType {
  if (!est) return 'Welfare check';
  const s = est.escalation;
  return !est.accounted || WELFARE_STEPS.has(s) || s.startsWith('referral_') ? 'Welfare check' : 'Property inspection';
}

// ---- Silence ----
export function silentHours(est: HouseholdEstimateRow | undefined, simMinutes: number, replies: readonly SmsReplyRow[], sent: readonly SmsSentRow[]): number | null {
  if (!est || est.accounted) return null;
  const lastReply = replies.length ? Math.max(...replies.map((r) => r.t)) : null;
  const firstSent = sent.length ? Math.min(...sent.map((s) => s.t)) : null;
  const from = lastReply ?? firstSent ?? 0;
  return Math.max(0, Math.floor((simMinutes - from) / 60));
}

// ---- Needs (only what changes how you act) ----
export const mayNeedHelpLeaving = (h: HouseholdRow) => !!(h.age75 || h.disability || h.noVehicle || (h.age65 && h.livesAlone));
const LANG: Record<string, string> = {
  es: 'Spanish', zh: 'Chinese', vi: 'Vietnamese', tl: 'Tagalog', ko: 'Korean', fr: 'French', de: 'German', ru: 'Russian', ar: 'Arabic',
};
export function languageNeed(h: HouseholdRow): string | null {
  if (!h.limitedEnglish) return null;
  const code = (h.primaryLanguage ?? '').toLowerCase();
  if (!code || code === 'en') return null;
  return LANG[code] ? `Speaks ${LANG[code]}` : 'Needs interpreter';
}
/** The list shows at most 2 action needs (no age or living-alone labels: a lost phone must not leak them). */
export function listNeeds(h: HouseholdRow | undefined): string[] {
  if (!h) return [];
  return [h.medicalDevice ? 'Medical device' : null, languageNeed(h)].filter((x): x is string => !!x).slice(0, 2);
}
export function homeNeeds(h: HouseholdRow): string[] {
  return [mayNeedHelpLeaving(h) ? 'May need help leaving' : null, h.medicalDevice ? 'Medical device' : null, languageNeed(h)]
    .filter((x): x is string => !!x);
}

// ---- Policy ----
export type Policy = 'homeowners' | 'renters' | 'condo';
export function policyOf(h: HouseholdRow | undefined): Policy {
  const p = (h?.policyType ?? '').toLowerCase();
  return p.includes('rent') ? 'renters' : p.includes('condo') ? 'condo' : 'homeowners';
}
export const POLICY_LABEL: Record<Policy, string> = { homeowners: 'Homeowners policy', renters: 'Renters policy', condo: 'Condo policy' };

export const isQuake = (hazardType: string | undefined) => /quake/i.test(hazardType ?? '');

/** Perils the policy does not cover for this disaster. Shown when the adjuster records damage. */
export function coverageGaps(h: HouseholdRow, hazardType: string | undefined): string[] {
  if (isQuake(hazardType)) return h.earthquakeEndorsement ? [] : ['Quake damage not covered: refer to FEMA. Do not promise payment.'];
  const out: string[] = [];
  if (!h.floodPolicy) out.push('Flood damage not covered: refer to FEMA / NFIP. Do not promise payment.');
  if (!h.windCovered) out.push('Wind damage not covered: refer to FEMA. Do not promise payment.');
  return out;
}

// ---- "Why you're here" (built from a template, never the raw hex_stats.reason) ----
export function whyText(o: {
  hazardType?: string; hex?: HexRow; cell?: HexStatsRow; hh?: HouseholdRow; replies: readonly SmsReplyRow[]; silent: number | null; type: TaskType;
}): { title: string; body: string } {
  const { hex, cell, hh, replies, silent, type } = o;
  let hazard: string | null = null;
  if (hex) {
    if (isQuake(o.hazardType)) hazard = (hex.shakingMmi ?? 0) >= 8 ? 'Severe shaking here' : null;
    else hazard = hex.windMph >= 74 ? 'Hurricane-force winds here' : hex.floodDepthFt >= 1 ? 'Flooding here' : null;
  }
  const silence = replies.length === 0 && silent != null ? `no reply in ${silent} h` : null;
  const parts: string[] = [];
  if (hazard && silence) parts.push(`${hazard} and ${silence}.`);
  else if (hazard) parts.push(`${hazard}.`);
  else if (silence) parts.push(`No reply in ${silent} h.`);
  if (replies.length === 0) {
    const cause = cell?.silenceCause;
    if (cause === 'trapped') parts.push('Likely still home.');
    else if (cause === 'away') parts.push('Many here are at work and may be away.');
    else if (cause === 'outage') parts.push('Towers are down, so silence may just mean no signal.');
  }
  if (hh && mayNeedHelpLeaving(hh)) parts.push('May need help leaving.');
  if (type === 'Property inspection') parts.push('Note anyone you see.');
  return { title: type === 'Welfare check' ? 'Knock first' : 'Inspect the house', body: parts.join(' ') };
}

// ---- Status lines ----
export const CLOSURE_LABEL: Record<string, string> = {
  vacant: 'Vacant', not_in_area: 'Not in the area', unreachable_after_visit: 'Unreachable after visit',
};
export function peopleStatus(est: HouseholdEstimateRow | undefined, followup: HouseholdFollowupRow | undefined): string {
  if (followup?.closureReason) return `Closed · ${CLOSURE_LABEL[followup.closureReason] ?? followup.closureReason}`;
  const s = est?.escalation ?? '';
  if (s.startsWith('sms_') || s === 'agent_call' || s === 'field_visit') return 'Not heard from';
  if (s === 'locate') return 'Not seen at visit · locate';
  if (s === 'recheck') return 'Last heard over 24 h ago';
  if (s === 'emergency_referral' || s.startsWith('referral_')) return 'Needs help · referral open';
  if (s === 'assistance') return 'Asked for help (not urgent)';
  if (s === 'accounted' || s === 'verified') return 'Heard from';
  return est?.accounted ? 'Heard from' : 'Not heard from';
}
export function contactLine(replies: readonly SmsReplyRow[], sent: readonly SmsSentRow[]): string {
  const last = latest(replies);
  if (last) {
    const what = last.safety === 'needs_help' || last.lifeSafety ? 'needs help' : 'safe';
    return `${last.channel === 'call' ? 'Call' : 'Replied'} ${fmtT(last.t)} · ${what}${last.notHome ? ' · not home' : ''}`;
  }
  if (sent.length) return `Texted ${fmtT(Math.min(...sent.map((s) => s.t)))} · no reply`;
  return 'Not texted yet';
}
export function homeStatus(est: HouseholdEstimateRow | undefined): { head: string; tail: string | null } {
  if (est?.verified) return { head: 'Inspected', tail: null };
  return { head: 'Not inspected', tail: `damage likely ${damageLevel(est?.pSevere ?? 0)}` };
}

export function latest<T extends { t: number }>(rows: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const r of rows) if (!best || r.t >= best.t) best = r;
  return best;
}

// ---- Task update banners (section 2.6) ----
export type BannerKind = 'help' | 'visited' | 'safe' | 'closed';
export interface Banner { kind: BannerKind; key: string; title: string; detail: string }
const PEOPLE: Record<string, string> = { safe: 'Safe', needs_help: 'Needs help', unsure: 'Nobody seen' };

/** The newest news since the task was assigned, by priority. The task itself never disappears. */
export function taskBanner(o: {
  a: AssignmentRow; replies: readonly SmsReplyRow[]; reports: readonly FieldReportRow[]; followup?: HouseholdFollowupRow;
  me?: Identity; type: TaskType;
}): Banner | null {
  const since = o.a.createdAt.microsSinceUnixEpoch;
  const after = <T extends { ingestedAt: { microsSinceUnixEpoch: bigint } }>(rows: readonly T[]) => rows.filter((r) => r.ingestedAt.microsSinceUnixEpoch > since);
  const replies = after(o.replies);
  const help = latest(replies.filter((r) => r.safety === 'needs_help' || r.lifeSafety));
  if (help) return { kind: 'help', key: `r${help.id}`, title: 'Now needs help', detail: `Referral opened · ${fmtT(help.t)}` };
  const f = o.followup;
  if (f?.closureReason && f.updatedAt.microsSinceUnixEpoch > since) {
    return { kind: 'closed', key: `c${f.closureReason}`, title: `Closed: ${CLOSURE_LABEL[f.closureReason] ?? f.closureReason}`, detail: f.closedBy ? `by ${f.closedBy}` : '' };
  }
  const visit = latest(after(o.reports).filter((r) => !o.me || !r.ingestedBy.isEqual(o.me)));
  if (visit) return { kind: 'visited', key: `v${visit.id}`, title: `Visited by ${visit.adjusterId}`, detail: `${PEOPLE[visit.safety] ?? visit.safety} · ${fmtT(visit.t)}` };
  const safe = latest(replies.filter((r) => r.safety === 'safe'));
  if (safe) {
    return {
      kind: 'safe', key: `s${safe.id}`, title: `Replied safe${safe.notHome ? ' · not home' : ''}`,
      detail: o.type === 'Property inspection' ? `House not inspected · ${fmtT(safe.t)}` : fmtT(safe.t),
    };
  }
  return null;
}

// ---- Geography: areas, never house points ----
export const cellCenter = (hex: string): LatLng => cellToLatLng(hex) as LatLng;
export function milesBetween(a: LatLng, b: LatLng): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
export const fmtMiles = (m: number) => (m < 0.1 ? '<0.1 mi' : m < 10 ? `${m.toFixed(1)} mi` : `${Math.round(m)} mi`);

export function fmtRange(lo: number, hi: number): string {
  const a = Math.round(lo);
  const b = Math.round(hi);
  return a === b ? String(a) : `${a}–${b}`;
}
