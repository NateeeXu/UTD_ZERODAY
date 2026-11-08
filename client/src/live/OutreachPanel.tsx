// P2: collapsible tab panel under the unaccounted card.
//   Not heard from — unaccounted_queue, ranked across cells by risk × waiting time
//   Needs help     — household_estimate with P(needs help) > 0.1
//   Feed           — latest SMS replies, claims, field reports
// The P0 / P1 / P2 switch puts that priority's rows first.
import { useMemo, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings/index.ts';
import { actionEstimates, useHouseholdsById } from './hooks';
import { EscalationChip, fmtHM, riskFlags } from './accounting';
import { prio, type Priority } from './mapModel';
import type { HexStatsRow, HouseholdRow, MemberRow } from './rows';
import type { Labeler } from './labels';
import { fmtT, homeLabel, pct } from '../format';

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
  onAssign: (hex: string) => void;
  adjusters: readonly MemberRow[];
  pickedAdjuster: MemberRow | undefined;
  onPickAdjuster: (hex: string) => void;
  assignError: string | null;
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
  const [estimates] = useTable(actionEstimates);

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

  const helpRows = useMemo(() => {
    return estimates
      .filter((e) => !e.verified)
      .map((e) => ({ e, cell: p.cellBy.get(e.hex) }))
      .filter((x): x is { e: (typeof estimates)[number]; cell: HexStatsRow } => !!x.cell)
      .sort((a, b) => rankOf(a.cell.priority) - rankOf(b.cell.priority) || b.e.pNeedsHelp - a.e.pNeedsHelp)
      .slice(0, 30);
  }, [estimates, p.cellBy, rankOf]);

  const ids = useMemo(
    () => (open ? (tab === 'unacc' ? queueRows.map((q) => q.householdId) : tab === 'help' ? helpRows.map((x) => x.e.householdId) : []) : []),
    [open, tab, queueRows, helpRows],
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
            </button>
          ))}
        </div>
        <label className="p2-sort" title="Sort: show this priority first">
          <span className="sr-only">Show this priority first</span>
          <select value={first} onChange={(e) => { setFirst(e.target.value as Priority); setOpen(true); }} disabled={tab === 'feed'}>
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
          {tab === 'unacc' && p.adjusters.length > 0 && (
            <div className="p2-assign">
              <span className="small muted">Send adjusters as</span>
              <select value={p.pickedAdjuster?.identity.toHexString() ?? ''} onChange={(e) => p.onPickAdjuster(e.target.value)}>
                {p.adjusters.map((a) => <option key={a.identity.toHexString()} value={a.identity.toHexString()}>{a.name}</option>)}
              </select>
            </div>
          )}
          {p.assignError && <p className="form-error small p2-pad">{p.assignError}</p>}
          <ul className="p2-list">
            {tab === 'unacc' && queueRows.map((q) => {
              const hh = householdBy.get(q.householdId);
              const flags = riskFlags(hh);
              const kids = p.kidsNote(hh);
              const action = q.escalation === 'field_visit' ? 'Send adjuster' : q.escalation === 'recheck' ? 'Recheck visit' : null;
              return (
                <li key={q.householdId} className="p2-row">
                  <span className={`chip chip-${prio(q.cellPriority)}`}>{prio(q.cellPriority)}</span>
                  <button className="p2-main" onClick={() => p.onSelectHex(q.hex)}>
                    <b>{homeLabel(q.householdId, p.fictional)} <span className="muted small">· {p.labeler.cell(q.hex)}</span></b>
                    <span className="small muted">waiting {fmtHM(p.simMinutes - q.waitSinceMin)}{q.vulnerable ? ' · vulnerable' : ''}</span>
                    {flags.length > 0 && <span className="risk small">{flags.join(' · ')}</span>}
                    {kids && <span className="kids small">{kids}</span>}
                  </button>
                  {action
                    ? <button className="btn primary small-btn" onClick={() => p.onAssign(q.hex)}>{action}</button>
                    : <EscalationChip step={q.escalation} />}
                </li>
              );
            })}
            {tab === 'help' && helpRows.map(({ e, cell }) => {
              const flags = riskFlags(householdBy.get(e.householdId));
              return (
                <li key={e.householdId} className="p2-row">
                  <span className={`chip chip-${prio(cell.priority)}`}>{prio(cell.priority)}</span>
                  <button className="p2-main" onClick={() => p.onSelectHex(cell.hex)}>
                    <b>{homeLabel(e.householdId, p.fictional)} <span className="muted small">· {p.labeler.cell(cell.hex)}</span></b>
                    {flags.length > 0 && <span className="risk small">{flags.join(' · ')}</span>}
                  </button>
                  <span className="small num">help {pct(e.pNeedsHelp)}</span>
                </li>
              );
            })}
            {tab === 'feed' && p.feed.map((f) => (
              <li key={f.key}>
                <button className={`feed-item ${f.kind}`} onClick={() => p.onSelectHex(f.hex)}>
                  <span className="muted small num">{fmtT(f.t)}</span>
                  <span className="feed-main">
                    <span className={f.help ? 'danger-text' : ''}>{f.text}</span>
                    <span className="muted small">{p.labeler.cell(f.hex)}{f.live ? ' · live' : ''}</span>
                  </span>
                </button>
              </li>
            ))}
            {((tab === 'unacc' && !queueRows.length) || (tab === 'help' && !helpRows.length) || (tab === 'feed' && !p.feed.length)) && (
              <li className="muted empty">{tab === 'feed' ? 'No events yet. Press Start.' : tab === 'unacc' ? 'Everyone has been heard from.' : 'Nothing here yet.'}</li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
