// Requests (docs/SPACETIME_API.md 0b, "People vs property"):
//   ReferralList  life safety only: escalation emergency_referral / referral_*. One button per row from
//                 household_followup.referralStatus: '' → refer → acknowledged → resolved. Overdue in red.
//                 State Farm refers to 911 / the local agency; the agency responds.
//   RequestList   'assistance' (customer care) and 'inspection_request' (adjuster queue), kept separate.
import { useMemo, useState } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings/index.ts';
import { useHouseholdsById } from './hooks';
import { fmtHM, riskFlags } from './accounting';
import type { Labeler } from './labels';
import { homeLabel } from '../format';
import type { Priority } from './mapModel';
import type { SmsReplyRow } from './rows';
import { needsText } from './household';

const REFERRAL_STEPS = ['emergency_referral', 'referral_pending', 'referral_acknowledged', 'referral_overdue'];
const referralRows = tables.householdEstimate.where((r) =>
  REFERRAL_STEPS.map((s) => r.escalation.eq(s)).reduce((a, b) => a.or(b)),
);

const NEXT: Record<string, { status: 'referred' | 'acknowledged' | 'resolved'; label: string }> = {
  '': { status: 'referred', label: 'Refer to 911 / agency' },
  referred: { status: 'acknowledged', label: 'Agency acknowledged' },
  acknowledged: { status: 'resolved', label: 'Resolved' },
};
const STATUS_TEXT: Record<string, string> = {
  '': 'Not referred yet',
  referred: 'Referred to 911 / local agency · awaiting acknowledgement',
  acknowledged: 'Agency acknowledged',
};

export function ReferralList({ rankOf, cellPrio, simMinutes, labeler, fictional, canAct, onNeedJoin, onOpen }: {
  rankOf: (p: string) => number; // the P0/P1/P2 "show first" switch
  cellPrio: (hex: string) => Priority;
  simMinutes: number;
  labeler: Labeler;
  fictional: boolean;
  canAct: boolean;
  onNeedJoin: () => void;
  onOpen: (householdId: string, hex: string) => void;
}) {
  const [rows] = useTable(referralRows);
  const [followups] = useTable(tables.householdFollowup);
  const update = useReducer(reducers.updateReferral);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const followBy = useMemo(() => new Map(followups.map((f) => [f.householdId, f])), [followups]);
  const list = useMemo(() => {
    const rank = (esc: string, status: string) => (esc === 'referral_overdue' ? 0 : status === '' ? 1 : status === 'referred' ? 2 : 3);
    return [...rows]
      .map((e) => ({ e, f: followBy.get(e.householdId) }))
      .sort((a, b) => rankOf(cellPrio(a.e.hex)) - rankOf(cellPrio(b.e.hex))
        || rank(a.e.escalation, a.f?.referralStatus ?? '') - rank(b.e.escalation, b.f?.referralStatus ?? '')
        || (a.f?.reportedSimMinutes ?? 0) - (b.f?.reportedSimMinutes ?? 0))
      .slice(0, 40);
  }, [rows, followBy, rankOf, cellPrio]);
  const householdBy = useHouseholdsById(useMemo(() => list.map((x) => x.e.householdId), [list]));

  const act = async (householdId: string, status: 'referred' | 'acknowledged' | 'resolved') => {
    if (!canAct) return onNeedJoin();
    setBusy(householdId);
    setError(null);
    try {
      await update({ householdId, status });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {error && <p className="form-error small p2-pad">{error}</p>}
      <ul className="p2-list">
        {list.map(({ e, f }) => {
          const status = f?.referralStatus ?? '';
          const next = NEXT[status];
          const late = e.escalation === 'referral_overdue';
          const since = f?.reportedSimMinutes ? simMinutes - f.reportedSimMinutes : null;
          const flags = riskFlags(householdBy.get(e.householdId));
          return (
            <li key={e.householdId} className={`p2-row${late ? ' late' : ''}`}>
              <span className={`chip chip-${cellPrio(e.hex)}`}>{cellPrio(e.hex)}</span>
              <button className="p2-main" onClick={() => onOpen(e.householdId, e.hex)}>
                <b>{homeLabel(e.householdId, fictional)} <span className="muted small">· {labeler.cell(e.hex)}</span></b>
                <span className="small">
                  <span className={f?.memberMissing ? 'danger-text' : ''}>{f?.memberMissing ? 'Household member missing' : 'Life-safety report'}</span>
                  {since != null && since >= 0 && <span className="muted"> · {fmtHM(since)} ago</span>}
                </span>
                <span className={`small ${late ? 'danger-text' : 'muted'}`}>{late ? 'Overdue · ' : ''}{STATUS_TEXT[status] ?? status}</span>
                {flags.length > 0 && <span className="risk small">{flags.join(' · ')}</span>}
              </button>
              {next && (
                <button className={`btn small-btn ${status === '' ? 'danger' : 'primary'}`} disabled={busy === e.householdId} onClick={() => act(e.householdId, next.status)}>
                  {next.label}
                </button>
              )}
            </li>
          );
        })}
        {!list.length && <li className="muted empty">No life-safety reports. Danger replies, adjuster findings and missing-member reports appear here.</li>}
      </ul>
    </>
  );
}

// Customer care ('assistance') and inspection requests ('inspection_request').
const assistanceRows = tables.householdEstimate.where((r) => r.escalation.eq('assistance'));
const inspectionRows = tables.householdEstimate.where((r) => r.escalation.eq('inspection_request'));

export function RequestList({ kind, rankOf, cellPrio, simMinutes, labeler, fictional, latestReply, sentTo, canAssign, onAssign, onOpen }: {
  kind: 'assistance' | 'inspection_request';
  rankOf: (p: string) => number;
  cellPrio: (hex: string) => Priority;
  simMinutes: number;
  labeler: Labeler;
  fictional: boolean;
  latestReply: Map<string, SmsReplyRow>;
  sentTo: Map<string, string>;
  canAssign: boolean;
  onAssign: (householdId: string) => void;
  onOpen: (householdId: string, hex: string) => void;
}) {
  const [rows] = useTable(kind === 'assistance' ? assistanceRows : inspectionRows);
  const list = useMemo(() => [...rows]
    .map((e) => ({ e, r: latestReply.get(e.householdId) }))
    .sort((a, b) => rankOf(cellPrio(a.e.hex)) - rankOf(cellPrio(b.e.hex)) || (a.r?.t ?? 0) - (b.r?.t ?? 0))
    .slice(0, 40), [rows, latestReply, rankOf, cellPrio]);
  const householdBy = useHouseholdsById(useMemo(() => list.map((x) => x.e.householdId), [list]));

  return (
    <ul className="p2-list">
      <li className="p2-note small muted">
        {kind === 'assistance'
          ? 'Customer care follows up (shelter, medication, water, a ride). Not emergencies.'
          : 'Residents who asked for an adjuster to look at the home.'}
      </li>
      {list.map(({ e, r }) => {
        const flags = riskFlags(householdBy.get(e.householdId));
        const sent = sentTo.get(e.householdId);
        const asked = r?.needs ? needsText(r.needs.split(',').filter((n) => kind === 'assistance' ? n !== 'inspection' : true).join(',')) : '';
        return (
          <li key={e.householdId} className="p2-row">
            <span className={`chip chip-${cellPrio(e.hex)}`}>{cellPrio(e.hex)}</span>
            <button className="p2-main" onClick={() => onOpen(e.householdId, e.hex)}>
              <b>{homeLabel(e.householdId, fictional)} <span className="muted small">· {labeler.cell(e.hex)}</span></b>
              <span className="small">
                {kind === 'assistance' ? (asked ? `Asked for ${asked}` : 'Asked for help (not an emergency)') : 'Asked for an inspection'}
                {r && <span className="muted"> · {fmtHM(simMinutes - r.t)} ago</span>}
              </span>
              {flags.length > 0 && <span className="risk small">{flags.join(' · ')}</span>}
            </button>
            {kind === 'inspection_request' && (sent
              ? <span className="esc esc-green">Sent · {sent}</span>
              : canAssign && <button className="btn primary small-btn" onClick={() => onAssign(e.householdId)}>Send adjuster</button>)}
          </li>
        );
      })}
      {!list.length && <li className="muted empty">{kind === 'assistance' ? 'No customer-care requests yet.' : 'No inspection requests yet.'}</li>}
    </ul>
  );
}
