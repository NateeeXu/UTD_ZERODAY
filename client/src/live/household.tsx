// One household, people and property kept apart (docs/DATA.md section 3, docs/SPACETIME_API.md 0b):
//   People:   reached by text / call / emergency contact, wherever they are → accounted + escalation.
//   Property: seen by an adjuster visit (nobody needs to be home), a claim, or a resident who is there.
// Shared by the manager's household panel and the adjuster's household card.
import { useMemo, useState } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings/index.ts';
import { ESCALATION, riskFlags } from './accounting';
import type { ClaimRow, FieldReportRow, HouseholdEstimateRow, HouseholdFollowupRow, HouseholdRow, SmsReplyRow } from './rows';
import type { Priority } from './mapModel';
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
  const head = est.accounted ? 'Accounted' : 'Not heard from';
  const stepLabel = ESCALATION[step]?.label ?? step;
  return {
    // Skip the step when it is empty or repeats the head ("Accounted · Accounted").
    status: stepLabel && stepLabel !== head ? `${head} · ${stepLabel}` : head,
    detail,
    tone: lifeSafety ? 'bad' : est.accounted ? 'ok' : 'warn',
  };
}

export function propertyLine({ est, replies, reports, claims }: HouseholdSignals): { status: string; detail: string | null } {
  const report = latest(reports);
  // A visit that could not assess the house (damage 255, damageKnown = false) leaves it uninspected.
  const assessed = latest(reports.filter((r) => r.damageKnown));
  if (assessed) return { status: `Inspected · ${DAMAGE[assessed.damage] ?? assessed.damage}`, detail: `${assessed.adjusterId} · ${fmtT(assessed.t)}` };
  const why = report ? `Visit ${fmtT(report.t)}: house not assessed${report.note ? ` (${report.note})` : ''}` : null;
  const withWhy = (d: string | null) => [why, d].filter(Boolean).join(' · ') || null;
  const model = est ? `Model estimate: ${pct(est.pSevere)} chance of severe damage` : null;
  const reply = latest(replies);
  if (reply && !reply.damageKnown) return { status: 'Damage unknown', detail: withWhy(model ? `Reply didn't describe the home · ${model}` : "Reply didn't describe the home") };
  if (reply) return { status: `Resident reported: ${DAMAGE[reply.damage] ?? reply.damage}`, detail: withWhy(model) };
  const claim = latest(claims);
  if (claim) return { status: `Claim reported: ${DAMAGE[claim.reportedDamage] ?? claim.reportedDamage}`, detail: withWhy(model) };
  return { status: report ? 'Not assessed' : 'Not inspected', detail: withWhy(model) };
}

// The Home panel's readout, in the area panel's format (a short value over a short label):
// people | home damage | model chance of severe damage. Same precedence as peopleLine / propertyLine.
function homeReadout(s: HouseholdSignals): { v: string; l: string; title?: string }[] {
  const { est, replies, reports, claims } = s;
  const detail = peopleLine(s).detail;
  const people = {
    v: est ? (est.accounted ? 'Accounted' : 'Not heard from') : '—',
    l: detail ? detail.charAt(0).toLowerCase() + detail.slice(1) : 'people',
  };
  const assessed = latest(reports.filter((r) => r.damageKnown));
  const reply = latest(replies);
  const claim = latest(claims);
  const dmg = (d: number) => DAMAGE[d] ?? String(d);
  const home = assessed ? { v: dmg(assessed.damage), l: 'home damage (inspected)' }
    : reply && !reply.damageKnown ? { v: 'Unknown', l: 'home damage' }
    : reply ? { v: dmg(reply.damage), l: 'home damage (resident)' }
    : claim ? { v: dmg(claim.reportedDamage), l: 'home damage (claim)' }
    : { v: '—', l: latest(reports) ? 'home not assessed' : 'home not inspected' };
  const model = { v: est ? pct(est.pSevere) : '—', l: 'chance of severe damage', title: 'Model estimate' };
  return [people, home, model];
}

// Field report damage as text ("not assessed" when the visit could not look at the house).
export const reportDamage = (f: Pick<FieldReportRow, 'damage' | 'damageKnown'>) =>
  f.damageKnown ? `damage ${DAMAGE[f.damage] ?? f.damage}` : 'house not assessed';

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
    ...s.reports.map((f) => ({ t: f.t, text: `Visit (${f.adjusterId}): ${f.safety === 'unsure' ? 'nobody seen' : f.safety.replace('_', ' ')} · ${reportDamage(f)}${f.note ? ` · “${f.note}”` : ''}` })),
  ].sort((a, b) => a.t - b.t);
}

// The manager never contacts policyholders: every next step is a task for an adjuster, and the result
// comes back with the adjuster's report. The recommended step follows the household's escalation.
export type Channel = 'resend' | 'call' | 'locate';
const CHANNELS: { key: Channel; label: string }[] = [
  { key: 'resend', label: 'Resend text' },
  { key: 'call', label: 'Call' },
  { key: 'locate', label: 'Locate' },
];
export function channelFor(escalation: string | undefined): Channel | null {
  if (escalation === 'sms_resend') return 'resend';
  if (escalation === 'agent_call' || escalation === 'recheck') return 'call'; // re-checks are phone first
  if (escalation === 'locate') return 'locate';
  return null;
}

// Inline "send an adjuster" choices under a queue row or on the household panel.
export function ContactActions({ householdId, note, recommended, canAssign, adjusterUrl, onSend }: {
  householdId: string;
  note?: string; // context before the choices, e.g. "No reply yet."
  recommended: Channel | null;
  canAssign: boolean;
  adjusterUrl: string;
  onSend: (householdId: string, channel: Channel) => void;
}) {
  return (
    <div className="contact-actions">
      <span className="small muted">{note ? `${note} ` : ''}Send an adjuster to:</span>
      {canAssign ? (
        <div className="ca-steps">
          {CHANNELS.map((c) => (
            <button key={c.key} type="button" className={`btn small-btn ca-step${c.key === recommended ? ' on' : ''}`} onClick={() => onSend(householdId, c.key)}>
              {c.label}{c.key === recommended && <span className="ca-rec">Recommended</span>}
            </button>
          ))}
        </div>
      ) : (
        <span className="small muted">
          No adjuster online yet. <a className="link small" href={adjusterUrl} target="_blank" rel="noreferrer">Open adjuster screen ↗</a>
        </span>
      )}
      <span className="small muted">The result fills in from their report.</span>
    </div>
  );
}

// Manager: one household in the right rail (opened from a queue or request row).
export function HouseholdPanel({ householdId, household, est, replies, reports, claims, label, priority, unverified, fictional, sentTo, canAssign, adjusterUrl, onAssign, onClose, noteFor }: {
  householdId: string;
  priority?: Priority;      // the household's cell, shown like the area panel's chip
  unverified?: boolean;
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
  onClose: () => void;
  noteFor?: (h: HouseholdRow | undefined) => string | null;
}) {
  const [followRows] = useTable(useMemo(() => tables.householdFollowup.where((r) => r.householdId.eq(householdId)), [householdId]));
  const followup = followRows[0];
  const signals: HouseholdSignals = { est, replies, reports, claims, followup };
  const history = contactHistory(signals);
  const flags = riskFlags(household);
  const kids = noteFor?.(household);
  const step = est?.escalation ?? '';
  const stepInfo = step ? ESCALATION[step] ?? { label: step, tone: 'muted' as const } : null;

  return (
    <aside className="card detail hh-panel">
      <div className="detail-head">
        <div className="detail-nav">
          <button className="link muted" onClick={onClose}>← Back</button>
          <button className="link muted close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {/* Same layout as the area panel (CellDetail): chip, title, status pill; one muted line; the readout. */}
        <div className="detail-title">
          {priority && (
            <span className={`chip chip-${priority}`} style={{ opacity: unverified ? 0.55 : 1 }} title={unverified ? `${priority}, needs check` : priority}>{priority}</span>
          )}
          <h2>{homeLabel(householdId, fictional)}</h2>
          {stepInfo && <span className={`pill tone-${stepInfo.tone}`}>{stepInfo.label}</span>}
        </div>
        <span className="muted small">
          {label}{flags.length > 0 && <> · <span className="risk">{flags.join(' · ')}</span></>}
        </span>
        {kids && <span className="kids small">{kids}</span>}
      </div>
      <div className="detail-body">
        <div className="readout">
          {homeReadout(signals).map((r) => <span key={r.l} title={r.title}><b>{r.v}</b>{r.l}</span>)}
        </div>
        {sentTo && <p className="small"><span className="esc esc-green">Adjuster sent · {sentTo}</span></p>}
        <h3 className="eyebrow divider">Contact history</h3>
        {history.length ? (
          <ul className="history small">{history.map((h, i) => <li key={i}><span className="muted">{fmtT(h.t)}</span> {h.text}</li>)}</ul>
        ) : (
          <p className="muted small">{household?.phoneOnFile === false ? 'No phone on file.' : 'Texted, no reply yet.'}</p>
        )}
        {est && !est.accounted && !sentTo && (
          <ContactActions householdId={householdId} recommended={channelFor(est.escalation)} canAssign={canAssign} adjusterUrl={adjusterUrl}
            onSend={(id) => onAssign(id)} />
        )}
        <h3 className="eyebrow divider">Close without contact</h3>
        <CloseHousehold householdId={householdId} followup={followup} reports={reports} />
      </div>
    </aside>
  );
}

// Close a household nobody could reach, with a documented reason and a note saying what was tried
// (backend: note of at least 3 characters; "unreachable after a visit" needs a visit report with
// nobody seen first). Closing also completes the household's open assignment. Reopening needs no note.
export function CloseHousehold({ householdId, followup, reports }: {
  householdId: string;
  followup: HouseholdFollowupRow | undefined;
  reports: readonly FieldReportRow[];
}) {
  const closeHousehold = useReducer(reducers.closeHousehold);
  const closure = followup?.closureReason ?? '';
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visitedNobodySeen = reports.some((r) => r.safety === 'unsure');

  const run = async (r: string, n: string) => {
    setBusy(true);
    setError(null);
    try {
      await closeHousehold({ householdId, reason: r, note: n.trim() });
      setReason('');
      setNote('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (closure) {
    return (
      <div className="close-hh">
        <p className="small">
          <b>Closed: {CLOSURES.find((c) => c.value === closure)?.label ?? closure}</b>
          {followup?.closedBy ? <span className="muted"> · by {followup.closedBy}</span> : null}
        </p>
        {followup?.closureNote && <p className="small muted">“{followup.closureNote}”</p>}
        <button className="btn small-btn" onClick={() => run('', '')} disabled={busy}>{busy ? 'Reopening…' : 'Reopen'}</button>
        {error && <p className="form-error small">{error}</p>}
      </div>
    );
  }
  return (
    <div className="close-hh">
      <select className="hh-close" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for closing">
        <option value="">Choose a documented reason…</option>
        {CLOSURES.map((c) => {
          const blocked = c.value === 'unreachable_after_visit' && !visitedNobodySeen;
          return <option key={c.value} value={c.value} disabled={blocked}>{c.label}{blocked ? ' (needs a visit with nobody seen)' : ''}</option>;
        })}
      </select>
      {reason && (
        <>
          <textarea className="hh-close-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500}
            placeholder="What was tried (required)" aria-label="Note: what was tried" />
          <button className="btn small-btn" onClick={() => run(reason, note)} disabled={busy || note.trim().length < 3}>
            {busy ? 'Closing…' : 'Close household'}
          </button>
          <span className="small muted">Closing also completes its open assignment.</span>
        </>
      )}
      {error && <p className="form-error small">{error}</p>}
    </div>
  );
}

