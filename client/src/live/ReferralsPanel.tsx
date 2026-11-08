// Life-safety referrals: needs-help replies and missing-member reports (docs/SPACETIME_API.md 0b).
// Button by household_followup.referralStatus:
//   '' → "Refer to 911 / agency" (referred) → "Agency acknowledged" (acknowledged) → "Resolved" (resolved)
// escalation = referral_overdue (not referred in 30 min / not acknowledged in 60 min) shows in red.
import { useMemo, useState } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings/index.ts';
import { useHouseholdsById } from './hooks';
import { fmtHM, riskFlags } from './accounting';
import type { MetricsRow } from './rows';
import type { Labeler } from './labels';
import { homeLabel } from '../format';

const REFERRAL_STEPS = ['emergency_referral', 'referral_pending', 'referral_acknowledged', 'referral_overdue'];
const referralRows = tables.householdEstimate.where((r) =>
  REFERRAL_STEPS.map((s) => r.escalation.eq(s)).reduce((a, b) => a.or(b)),
);

const NEXT: Record<string, { status: 'referred' | 'acknowledged' | 'resolved'; label: string }> = {
  '': { status: 'referred', label: 'Refer to 911 / agency' },
  referred: { status: 'acknowledged', label: 'Agency acknowledged' },
  acknowledged: { status: 'resolved', label: 'Resolved' },
};
const STATUS_TEXT: Record<string, string> = { '': 'Not referred yet', referred: 'Referred · waiting for agency', acknowledged: 'Agency acknowledged' };

export function ReferralsPanel({ metrics, simMinutes, labeler, fictional, canAct, onNeedJoin, onSelectHex }: {
  metrics: MetricsRow | undefined;
  simMinutes: number;
  labeler: Labeler;
  fictional: boolean;
  canAct: boolean;
  onNeedJoin: () => void;
  onSelectHex: (hex: string) => void;
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
      .sort((a, b) => rank(a.e.escalation, a.f?.referralStatus ?? '') - rank(b.e.escalation, b.f?.referralStatus ?? '')
        || (a.f?.reportedSimMinutes ?? 0) - (b.f?.reportedSimMinutes ?? 0));
  }, [rows, followBy]);
  const householdBy = useHouseholdsById(useMemo(() => list.slice(0, 30).map((x) => x.e.householdId), [list]));

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

  const overdue = metrics?.overdueReferrals ?? 0;
  return (
    <section className="glass referrals">
      <div className="ref-head">
        <b>Referrals</b>
        <span className="small muted">{metrics?.openReferrals ?? list.length} open{metrics?.membersMissing ? ` · ${metrics.membersMissing} missing members` : ''}</span>
        {overdue > 0 && <span className="ref-overdue">{overdue} overdue</span>}
      </div>
      {error && <p className="form-error small ref-pad">{error}</p>}
      <ul className="ref-list">
        {list.slice(0, 30).map(({ e, f }) => {
          const status = f?.referralStatus ?? '';
          const next = NEXT[status];
          const late = e.escalation === 'referral_overdue';
          const since = f?.reportedSimMinutes ? simMinutes - f.reportedSimMinutes : null;
          const flags = riskFlags(householdBy.get(e.householdId));
          return (
            <li key={e.householdId} className={`ref-row${late ? ' late' : ''}`}>
              <button className="p2-main" onClick={() => onSelectHex(e.hex)}>
                <b>{homeLabel(e.householdId, fictional)} <span className="muted small">· {labeler.cell(e.hex)}</span></b>
                <span className="small">
                  <span className={f?.memberMissing ? 'danger-text' : ''}>{f?.memberMissing ? 'Household member missing' : 'Asked for help'}</span>
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
        {!list.length && <li className="muted empty">No open referrals. Needs-help replies and missing-member reports land here.</li>}
      </ul>
    </section>
  );
}
