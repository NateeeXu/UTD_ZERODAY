// One household, people and property kept apart (docs/DATA.md section 3, docs/SPACETIME_API.md 0b):
//   People:   reached by text / call / emergency contact, wherever they are → accounted + escalation.
//   Property: seen by an adjuster visit (nobody needs to be home), a claim, or a resident who is there.
// Shared by the manager's household panel and the adjuster's household card.
import { useMemo, useState } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings/index.ts';
import { ESCALATION, EscalationChip, riskFlags } from './accounting';
import type { ClaimRow, FieldReportRow, HouseholdEstimateRow, HouseholdFollowupRow, HouseholdRow, SmsReplyRow } from './rows';
import { fmtT, homeLabel, pct } from '../format';

export const DAMAGE = ['None', 'Minor', 'Severe', 'Uninhabitable'] as const;
export const CLOSURES = [
  { value: 'vacant', label: 'Vacant / no one lives here' },
  { value: 'not_in_area', label: 'Household not in the area' },
  { value: 'unreachable_after_visit', label: 'Unreachable after a visit' },
] as const;
const NEEDS: Record<string, string> = {
  medical: 'medical', power_for_device: 'power for a medical device', shelter: 'shelter', water_food: 'water / food',
  transport: 'a ride', inspection: 'an inspection', other: 'other help',
};

export const needsText = (needs: string) =>
  needs.split(',').map((n) => n.trim()).filter(Boolean).map((n) => NEEDS[n] ?? n).join(', ');

const latest = <T extends { t: number }>(rows: readonly T[]): T | undefined =>
  rows.reduce<T | undefined>((a, b) => (!a || b.t >= a.t ? b : a), undefined);

export interface HouseholdSignals {
  est?: HouseholdEstimateRow;
  replies: readonly SmsReplyRow[];
  reports: readonly FieldReportRow[];
  claims: readonly ClaimRow[];
  followup?: HouseholdFollowupRow;
}

export function peopleLine({ est, replies, reports, followup }: HouseholdSignals): { status: string; detail: string | null; tone: 'ok' | 'warn' | 'bad' } {
  const reply = latest(replies);
  const report = latest(reports);
  const step = est?.escalation ?? '';
  let detail: string | null = null;
  // The newest contact decides what we know about where the people are.
  if (report && report.safety === 'unsure' && (!reply || report.t >= reply.t)) detail = 'House inspected, nobody seen';
  else if (reply?.notHome) detail = 'Not at home (replied from elsewhere)';
  else if (reply) detail = `${reply.channel === 'call' ? 'Reached by phone' : 'Replied by text'} ${fmtT(reply.t)}`;
  if (followup?.closureReason) detail = `Closed: ${CLOSURES.find((c) => c.value === followup.closureReason)?.label ?? followup.closureReason}`;
  if (!est) return { status: '—', detail, tone: 'warn' };
  const lifeSafety = step === 'emergency_referral' || step.startsWith('referral_');
  return {
    status: `${est.accounted ? 'Accounted' : 'Not heard from'} · ${ESCALATION[step]?.label ?? step}`,
    detail,
    tone: lifeSafety ? 'bad' : est.accounted ? 'ok' : 'warn',
  };
}

export function propertyLine({ est, replies, reports, claims }: HouseholdSignals): { status: string; detail: string | null } {
  const report = latest(reports);
  if (report) return { status: `Inspected · ${DAMAGE[report.damage] ?? report.damage}`, detail: `${report.adjusterId} · ${fmtT(report.t)}` };
  const model = est ? `Model estimate: ${pct(est.pSevere)} chance of severe damage` : null;
  const reply = latest(replies);
  if (reply && !reply.damageKnown) return { status: 'Damage unknown', detail: model ? `Reply didn't describe the home · ${model}` : "Reply didn't describe the home" };
  if (reply) return { status: `Resident reported: ${DAMAGE[reply.damage] ?? reply.damage}`, detail: model };
  const claim = latest(claims);
  if (claim) return { status: `Claim reported: ${DAMAGE[claim.reportedDamage] ?? claim.reportedDamage}`, detail: model };
  return { status: 'Not inspected', detail: model };
}

// The two lines, as shown on both cards.
export function PeopleProperty(s: HouseholdSignals) {
  const people = peopleLine(s);
  const property = propertyLine(s);
  return (
    <div className="pp">
      <div className={`pp-row ${people.tone}`}>
        <span className="pp-k">People</span>
        <span className="pp-v"><b>{people.status}</b>{people.detail && <span className="muted small">{people.detail}</span>}</span>
      </div>
      <div className="pp-row">
        <span className="pp-k">Home</span>
        <span className="pp-v"><b>{property.status}</b>{property.detail && <span className="muted small">{property.detail}</span>}</span>
      </div>
    </div>
  );
}

export function contactHistory(s: HouseholdSignals) {
  return [
    ...s.replies.map((r) => ({
      t: r.t,
      text: `${r.channel === 'call' ? 'Call' : 'Text reply'}: ${r.lifeSafety ? 'DANGER' : r.safety === 'needs_help' ? 'needs help' : 'safe'}`
        + `${r.notHome ? ' · not at home' : ''} · ${r.damageKnown ? `damage ${DAMAGE[r.damage] ?? r.damage}` : 'damage unknown'}`
        + `${r.needs ? ` · asked for ${needsText(r.needs)}` : ''}${r.text ? ` · “${r.text}”` : ''}`,
    })),
    ...s.claims.map((c) => ({ t: c.t, text: `Claim: ${c.peril} · damage ${DAMAGE[c.reportedDamage] ?? c.reportedDamage}` })),
    ...s.reports.map((f) => ({ t: f.t, text: `Visit (${f.adjusterId}): ${f.safety === 'unsure' ? 'nobody seen' : f.safety.replace('_', ' ')} · ${DAMAGE[f.damage] ?? f.damage}` })),
  ].sort((a, b) => a.t - b.t);
}

// A manager records a contact made outside the text system (phone, emergency contact) with
// submit_parsed_reply. damage 255 = the contact did not describe the home.
type Outcome = { label: string; safety: 'safe' | 'needs_help'; lifeSafety: boolean; notHome: boolean; needs: string; danger?: boolean };
const OUTCOMES: Outcome[] = [
  { label: 'Reached · safe at home', safety: 'safe', lifeSafety: false, notHome: false, needs: '' },
  { label: 'Reached · safe, not at home', safety: 'safe', lifeSafety: false, notHome: true, needs: '' },
  { label: 'Needs customer care', safety: 'needs_help', lifeSafety: false, notHome: false, needs: 'other' },
  { label: 'Danger now → refer to 911', safety: 'needs_help', lifeSafety: true, notHome: false, needs: '', danger: true },
];

export function useLogContact(onDone: (msg: string) => void, onError: (msg: string) => void) {
  const submit = useReducer(reducers.submitParsedReply);
  return async (householdId: string, o: Outcome, how: string) => {
    try {
      await submit({
        householdId, safety: o.safety, damage: 255, lifeSafety: o.lifeSafety, needs: o.needs, notHome: o.notHome,
        text: `[${how}, logged by manager] ${o.label}`, language: 'en', passcode: '',
      });
      onDone(o.label);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
}

// Inline actions under a queue row or on the household panel.
export function ContactActions({ householdId, how, prompt, canAssign, adjusterUrl, onAssign, onLog }: {
  householdId: string;
  how: string; // "agent call", "emergency contact", ... (stored with the logged contact)
  prompt?: string;
  canAssign: boolean;
  adjusterUrl: string;
  onAssign: (householdId: string) => void;
  onLog: (householdId: string, o: Outcome, how: string) => void;
}) {
  return (
    <div className="contact-actions">
      <span className="small muted">{prompt ?? `Log the result of the ${how}:`}</span>
      <div className="ca-buttons">
        {OUTCOMES.map((o) => (
          <button key={o.label} className={`btn small-btn${o.danger ? ' danger' : ''}`} onClick={() => onLog(householdId, o, how)}>{o.label}</button>
        ))}
      </div>
      <span className="small muted">
        Or send someone:{' '}
        {canAssign
          ? <button className="link small" onClick={() => onAssign(householdId)}>Send adjuster</button>
          : <a className="link small" href={adjusterUrl} target="_blank" rel="noreferrer">Open adjuster screen ↗</a>}
      </span>
    </div>
  );
}

// Manager: one household in the right rail (opened from a queue or request row).
export function HouseholdPanel({ householdId, household, est, replies, reports, claims, label, fictional, sentTo, canAssign, adjusterUrl, onAssign, onLog, onClose, noteFor }: {
  householdId: string;
  household: HouseholdRow | undefined;
  est: HouseholdEstimateRow | undefined;
  replies: readonly SmsReplyRow[];
  reports: readonly FieldReportRow[];
  claims: readonly ClaimRow[];
  label: string;
  fictional: boolean;
  sentTo: string | undefined;
  canAssign: boolean;
  adjusterUrl: string;
  onAssign: (householdId: string) => void;
  onLog: (householdId: string, o: Outcome, how: string) => void;
  onClose: () => void;
  noteFor?: (h: HouseholdRow | undefined) => string | null;
}) {
  const [followRows] = useTable(useMemo(() => tables.householdFollowup.where((r) => r.householdId.eq(householdId)), [householdId]));
  const followup = followRows[0];
  const closeHousehold = useReducer(reducers.closeHousehold);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);
  const signals: HouseholdSignals = { est, replies, reports, claims, followup };
  const history = contactHistory(signals);
  const flags = riskFlags(household);
  const kids = noteFor?.(household);
  const closure = followup?.closureReason ?? '';
  const step = est?.escalation ?? '';

  return (
    <aside className="card detail hh-panel">
      <div className="detail-head">
        <div className="detail-nav">
          <button className="link muted" onClick={onClose}>← Back</button>
          <button className="link muted close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="detail-title">
          <h2>{homeLabel(householdId, fictional)}</h2>
          {step && <EscalationChip step={step} />}
        </div>
        <span className="muted small">{label}</span>
        {flags.length > 0 && <span className="risk small">{flags.join(' · ')}</span>}
        {kids && <span className="kids small">{kids}</span>}
      </div>
      <div className="detail-body">
        <PeopleProperty {...signals} />
        {sentTo && <p className="small"><span className="esc esc-green">Adjuster sent · {sentTo}</span></p>}
        <h3 className="eyebrow divider">Contact history</h3>
        {history.length ? (
          <ul className="history small">{history.map((h, i) => <li key={i}><span className="muted">{fmtT(h.t)}</span> {h.text}</li>)}</ul>
        ) : (
          <p className="muted small">{household?.phoneOnFile === false ? 'No phone on file.' : 'Texted, no reply yet.'}</p>
        )}
        {est && !est.accounted && (
          <>
            <button className="btn small-btn" onClick={() => setLogging((v) => !v)}>{logging ? 'Hide' : 'Log a contact'}</button>
            {logging && <ContactActions householdId={householdId} how="contact" canAssign={canAssign} adjusterUrl={adjusterUrl} onAssign={onAssign} onLog={onLog} />}
          </>
        )}
        <h3 className="eyebrow divider">Close without contact</h3>
        <select
          className="hh-close"
          value={closure}
          onChange={async (e) => {
            setCloseError(null);
            try {
              await closeHousehold({ householdId, reason: e.target.value });
            } catch (err) {
              setCloseError(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          <option value="">{closure ? 'Reopen (not closed)' : 'Open · choose a documented reason…'}</option>
          {CLOSURES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        {closure && followup?.closedBy && <p className="small muted">Closed by {followup.closedBy}</p>}
        {closeError && <p className="form-error small">{closeError}</p>}
      </div>
    </aside>
  );
}

export type { Outcome };
