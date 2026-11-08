// P2: collapsible tab panel under the unaccounted card.
//   Not heard from — unaccounted_queue, ranked across cells by risk × waiting time
//   Needs help     — people who asked for help / reported a missing member (referrals)
//   Feed           — latest SMS replies, claims, field reports
// The P0 / P1 / P2 switch puts that priority's rows first, on every tab.
import { useCallback, useMemo, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings/index.ts';
import { useHouseholdsById } from './hooks';
import { ReferralList } from './ReferralsPanel';
import { EscalationChip, fmtHM, riskFlags } from './accounting';
import { prio, type Priority } from './mapModel';
import type { HexStatsRow, HouseholdRow, MemberRow, MetricsRow } from './rows';
import type { Labeler } from './labels';
import { fmtT, homeLabel } from '../format';

export type OutreachTab = 'unacc' | 'help' | 'feed';

export interface FeedItem {
  key: string;
  kind: 'sms_reply' | 'claim' | 'field_report';
  t: number;
  at: number;
  hex: string;
  householdId: string;
  live: boolean;
  text: string;
  help: boolean;
}

interface Props {
  simMinutes: number;
  cellBy: Map<string, HexStatsRow>;
  labeler: Labeler;
  fictional: boolean;
  feed: FeedItem[];
  kidsNote: (h: HouseholdRow | undefined) => string | null;
  onSelectHex: (hex: string) => void;
  onAssignHousehold: (householdId: string) => void;
  sentTo: Map<string, string>;          // householdId → adjuster name (open assignment)
  adjusterUrl: string;
  adjusters: readonly MemberRow[];
  pickedAdjuster: MemberRow | undefined;
  onPickAdjuster: (hex: string) => void;
  metrics: MetricsRow | undefined;
  canAct: boolean;
  onNeedJoin: () => void;
}

const TABS: { id: OutreachTab; label: string }[] = [
  { id: 'unacc', label: 'Not heard from' },
  { id: 'help', label: 'Needs help' },
  { id: 'feed', label: 'Feed' },
];
const ORDER: Priority[] = ['P0', 'P1', 'P2'];

export function OutreachPanel(p: Props) {
  const [open, setOpen] = useState(false); // collapsed by default
  const [tab, setTab] = useState<OutreachTab>('unacc');
  const [first, setFirst] = useState<Priority>('P0');
  const [queue] = useTable(tables.unaccountedQueue);

  // Rank of a priority given the chosen "first" priority: chosen first, then the usual P0 > P1 > P2.
  const rankOf = useMemo(() => {
    const order = [first, ...ORDER.filter((x) => x !== first)];
    return (x: string) => order.indexOf(prio(x));
  }, [first]);

  // Nate's score: weight × (1 + hours waited / 6), compared across cells.
  const queueRows = useMemo(() => {
    const score = (q: (typeof queue)[number]) => q.weight * (1 + (p.simMinutes - q.waitSinceMin) / 360);
    return [...queue]
      .sort((a, b) => rankOf(a.cellPriority) - rankOf(b.cellPriority) || score(b) - score(a))
      .slice(0, 40);
  }, [queue, p.simMinutes, rankOf]);

  // Feed: chosen priority first, newest first within it (sort is stable).
  const cellPrio = useCallback((hex: string) => prio(p.cellBy.get(hex)?.priority ?? 'P2'), [p.cellBy]);
  const feedRows = useMemo(
    () => [...p.feed].sort((a, b) => rankOf(cellPrio(a.hex)) - rankOf(cellPrio(b.hex))),
    [p.feed, cellPrio, rankOf],
  );

  const ids = useMemo(
    () => (open && tab === 'unacc' ? queueRows.map((q) => q.householdId) : []),
    [open, tab, queueRows],
  );
  const householdBy = useHouseholdsById(ids);

  const pick = (t: OutreachTab) => {
    if (t === tab) setOpen((o) => !o);
    else {
      setTab(t);
      setOpen(true);
    }
  };

  return (
    <section className={`glass p2${open ? ' open' : ''}`}>
      <div className="p2-bar">
        <div className="gseg p2-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={open && tab === t.id} className={open && tab === t.id ? 'on' : tab === t.id ? 'soft' : ''} onClick={() => pick(t.id)}>
              {t.label}
              {t.id === 'help' && (p.metrics?.openReferrals ?? 0) > 0 && (
                <span className={`tab-badge${(p.metrics?.overdueReferrals ?? 0) > 0 ? ' red' : ''}`}>{p.metrics?.openReferrals}</span>
              )}
            </button>
          ))}
        </div>
        <label className="p2-sort" title="Sort: show this priority first">
          <span className="sr-only">Show this priority first</span>
          <select value={first} onChange={(e) => { setFirst(e.target.value as Priority); setOpen(true); }}>
            {ORDER.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <button className="p2-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? 'Collapse list' : 'Expand list'}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s' }}>
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="p2-body">
          {tab === 'unacc' && (p.adjusters.length > 0 ? (
            <div className="p2-assign">
              <span className="small muted">Send adjusters as</span>
              <select value={p.pickedAdjuster?.identity.toHexString() ?? ''} onChange={(e) => p.onPickAdjuster(e.target.value)}>
                {p.adjusters.map((a) => <option key={a.identity.toHexString()} value={a.identity.toHexString()}>{a.name}</option>)}
              </select>
            </div>
          ) : (
            <div className="p2-assign">
              <span className="small muted">No adjuster online, so visits can't be sent yet.</span>
              <a className="link small" href={p.adjusterUrl} target="_blank" rel="noreferrer">Open adjuster screen ↗</a>
            </div>
          ))}
          {tab === 'help' && (
            <ReferralList rankOf={rankOf} cellPrio={cellPrio} simMinutes={p.simMinutes} labeler={p.labeler} fictional={p.fictional} canAct={p.canAct} onNeedJoin={p.onNeedJoin} onSelectHex={p.onSelectHex} />
          )}
          {tab !== 'help' && <ul className="p2-list">
            {tab === 'unacc' && queueRows.map((q) => {
              const hh = householdBy.get(q.householdId);
              const flags = riskFlags(hh);
              const kids = p.kidsNote(hh);
              const action = q.escalation === 'field_visit' ? 'Send adjuster' : q.escalation === 'recheck' ? 'Recheck visit' : null;
              const sent = p.sentTo.get(q.householdId);
              return (
                <li key={q.householdId} className="p2-row">
                  <span className={`chip chip-${prio(q.cellPriority)}`}>{prio(q.cellPriority)}</span>
                  <button className="p2-main" onClick={() => p.onSelectHex(q.hex)}>
                    <b>{homeLabel(q.householdId, p.fictional)} <span className="muted small">· {p.labeler.cell(q.hex)}</span></b>
                    <span className="small muted">waiting {fmtHM(p.simMinutes - q.waitSinceMin)}{q.vulnerable ? ' · vulnerable' : ''}</span>
                    {flags.length > 0 && <span className="risk small">{flags.join(' · ')}</span>}
                    {kids && <span className="kids small">{kids}</span>}
                  </button>
                  {sent
                    ? <span className="esc esc-green">Sent · {sent}</span>
                    : action && p.adjusters.length > 0
                      ? <button className="btn primary small-btn" onClick={() => p.onAssignHousehold(q.householdId)}>{action}</button>
                      : <EscalationChip step={q.escalation} />}
                </li>
              );
            })}
            {tab === 'feed' && feedRows.map((f) => (
              <li key={f.key}>
                <button className={`feed-item ${f.kind}`} onClick={() => p.onSelectHex(f.hex)}>
                  <span className="muted small num">{fmtT(f.t)}</span>
                  <span className="feed-main">
                    <span className={f.help ? 'danger-text' : ''}>{f.text}</span>
                    <span className="muted small"><span className={`chip mini chip-${cellPrio(f.hex)}`}>{cellPrio(f.hex)}</span>{p.labeler.cell(f.hex)}{f.live ? ' · live' : ''}</span>
                  </span>
                </button>
              </li>
            ))}
            {((tab === 'unacc' && !queueRows.length) || (tab === 'feed' && !p.feed.length)) && (
              <li className="muted empty">{tab === 'feed' ? 'No events yet. Press Start.' : 'Everyone has been heard from.'}</li>
            )}
          </ul>}
        </div>
      )}
    </section>
  );
}
