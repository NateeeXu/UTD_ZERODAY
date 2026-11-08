// P2: collapsible tab panel under the KPI card.
//   Not heard from — unaccounted_queue, ranked across cells by score = weight × (1 + hours waited / 6)
//                    (docs/SPACETIME_API.md 0b); one button per row from its escalation step.
//   Requests       — 911 / local agency referrals (life safety only), customer care, inspection requests.
//   Feed           — latest replies, claims, field reports.
// The P0 / P1 / P2 switch puts that priority's rows first, on every tab.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings/index.ts';
import { useHouseholdsById } from './hooks';
import { ReferralList, RequestList } from './ReferralsPanel';
import { ESCALATION, fmtHM, riskFlags } from './accounting';
import { ContactActions, type Outcome } from './household';
import { prio, type Priority } from './mapModel';
import type { HexStatsRow, HouseholdRow, MemberRow, MetricsRow, SmsReplyRow } from './rows';
import type { Labeler } from './labels';
import { fmtT, homeLabel } from '../format';

export type OutreachTab = 'unacc' | 'requests' | 'feed';
type RequestTab = 'referral' | 'assistance' | 'inspection_request';

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
  latestReply: Map<string, SmsReplyRow>;
  kidsNote: (h: HouseholdRow | undefined) => string | null;
  onSelectHex: (hex: string) => void;
  onOpen: (householdId: string, hex: string) => void;
  onAssignHousehold: (householdId: string) => void;
  onLog: (householdId: string, o: Outcome, how: string) => void;
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
  { id: 'requests', label: 'Requests' },
  { id: 'feed', label: 'Feed' },
];
const ORDER: Priority[] = ['P0', 'P1', 'P2'];

// One button per escalation step. Texts, calls and emergency-contact calls happen outside this app,
// so their button records the result; a visit is sent from here.
const STEP_ACTION: Record<string, { label: string; how: string; prompt: string; visit?: boolean }> = {
  sms_sent: { label: 'Text sent', how: 'contact', prompt: 'Check-in text sent. Log a contact made another way:' },
  sms_resend: { label: 'Resend text', how: 'resent text', prompt: 'No reply yet. Resend the text, then log the result:' },
  agent_call: { label: 'Call', how: 'agent call', prompt: 'Log the result of the agent call:' },
  field_visit: { label: 'Send adjuster', how: 'visit', prompt: 'A visit is due:', visit: true },
  recheck: { label: 'Re-check', how: 'welfare check', prompt: 'Daily welfare check (last contact over 24 h ago). Log the result:' },
  locate: { label: 'Locate', how: 'emergency-contact call', prompt: 'House inspected, nobody seen. Log the emergency-contact call:' },
};

// Per-viewer memory of the panel (tab, sub-tab, sort, open): a convenience, so it may be missing.
const UI_KEY = 'triage-outreach-ui';
type UiState = { open: boolean; tab: OutreachTab; reqTab: RequestTab; first: Priority };
function loadUi(): Partial<UiState> {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) ?? '{}') as Partial<UiState>;
  } catch {
    return {};
  }
}

export function OutreachPanel(p: Props) {
  const [saved] = useState(loadUi);
  const [open, setOpen] = useState(saved.open ?? false); // collapsed by default
  const [tab, setTab] = useState<OutreachTab>(saved.tab ?? 'unacc');
  const [reqTab, setReqTab] = useState<RequestTab>(saved.reqTab ?? 'referral');
  const [first, setFirst] = useState<Priority>(saved.first ?? 'P0');
  useEffect(() => {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({ open, tab, reqTab, first }));
    } catch {
      /* ignore */
    }
  }, [open, tab, reqTab, first]);

  // Every list mounts (hidden) the first time the panel opens and stays mounted, so tab switches show
  // rows from the first frame instead of unmounting, resubscribing and flashing empty. The lists that
  // are not on screen load in the background meanwhile.
  const [everOpened, setEverOpened] = useState(open);
  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);
  const live = everOpened || open;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [queue] = useTable(tables.unaccountedQueue);

  // Rank of a priority given the chosen "first" priority: chosen first, then the usual P0 > P1 > P2.
  const rankOf = useMemo(() => {
    const order = [first, ...ORDER.filter((x) => x !== first)];
    return (x: string) => order.indexOf(prio(x));
  }, [first]);
  const cellPrio = useCallback((hex: string) => prio(p.cellBy.get(hex)?.priority ?? 'P2'), [p.cellBy]);

  // Nate's score: weight × (1 + hours waited / 6), compared across cells.
  const queueRows = useMemo(() => {
    const score = (q: (typeof queue)[number]) => q.weight * (1 + (p.simMinutes - q.waitSinceMin) / 360);
    return [...queue]
      .sort((a, b) => rankOf(a.cellPriority) - rankOf(b.cellPriority) || score(b) - score(a))
      .slice(0, 40);
  }, [queue, p.simMinutes, rankOf]);

  // Feed: chosen priority first, newest first within it (sort is stable).
  const feedRows = useMemo(
    () => [...p.feed].sort((a, b) => rankOf(cellPrio(a.hex)) - rankOf(cellPrio(b.hex))),
    [p.feed, cellPrio, rankOf],
  );

  const ids = useMemo(() => (live ? queueRows.map((q) => q.householdId) : []), [live, queueRows]);
  const householdBy = useHouseholdsById(ids);

  const pick = (t: OutreachTab) => {
    if (t === tab) setOpen((o) => !o);
    else {
      setTab(t);
      setOpen(true);
    }
  };
  const act = (fn: () => void) => () => (p.canAct ? fn() : p.onNeedJoin());
  const m = p.metrics;
  const reqCounts: Record<RequestTab, number> = {
    referral: m?.openReferrals ?? 0,
    assistance: m?.assistanceRequests ?? 0,
    inspection_request: m?.inspectionRequests ?? 0,
  };
  const overdue = (m?.overdueReferrals ?? 0) > 0;

  return (
    <section className={`glass p2${open ? ' open' : ''}`}>
      <div className="p2-bar">
        <div className="gseg p2-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={open && tab === t.id} className={open && tab === t.id ? 'on' : tab === t.id ? 'soft' : ''} onClick={() => pick(t.id)}>
              {t.label}
              {t.id === 'requests' && reqCounts.referral > 0 && (
                <span className={`tab-badge${overdue ? ' red' : ''}`} title="Open 911 / agency referrals">{reqCounts.referral}</span>
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

      {live && (
        <div className="p2-body" hidden={!open}>
          {live && (
            <div className="p2-pane" hidden={tab !== 'unacc'}>
              {p.adjusters.length > 0 ? (
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
              )}
              <ul className="p2-list">
                {queueRows.map((q) => {
                  const hh = householdBy.get(q.householdId);
                  const flags = riskFlags(hh);
                  const kids = p.kidsNote(hh);
                  const sent = p.sentTo.get(q.householdId);
                  const a = STEP_ACTION[q.escalation];
                  const isOpen = expanded === q.householdId;
                  const direct = !!a?.visit && p.adjusters.length > 0; // a visit with an adjuster online: one click
                  const onButton = act(() => {
                    if (direct) p.onAssignHousehold(q.householdId);
                    else setExpanded(isOpen ? null : q.householdId);
                  });
                  return (
                    <li key={q.householdId} className={`p2-item${isOpen ? ' open' : ''}`}>
                      <div className="p2-row">
                        <span className={`chip chip-${prio(q.cellPriority)}`}>{prio(q.cellPriority)}</span>
                        <button className="p2-main" onClick={() => p.onOpen(q.householdId, q.hex)}>
                          <b>{homeLabel(q.householdId, p.fictional)} <span className="muted small">· {p.labeler.cell(q.hex)}</span></b>
                          <span className="small muted">{ESCALATION[q.escalation]?.label ?? q.escalation} · waiting {fmtHM(p.simMinutes - q.waitSinceMin)}{q.vulnerable ? ' · vulnerable' : ''}</span>
                          {flags.length > 0 && <span className="risk small">{flags.join(' · ')}</span>}
                          {kids && <span className="kids small">{kids}</span>}
                        </button>
                        {sent
                          ? <span className="esc esc-green">Sent · {sent}</span>
                          : a && (
                            <button className={`btn small-btn step-btn${a.visit ? ' primary' : ''}`} aria-expanded={direct ? undefined : isOpen} onClick={onButton}>
                              {a.label}{!direct && <i className="caret" aria-hidden="true" />}
                            </button>
                          )}
                      </div>
                      {isOpen && a && (
                        <ContactActions householdId={q.householdId} how={a.how} prompt={a.prompt} canAssign={p.adjusters.length > 0} adjusterUrl={p.adjusterUrl}
                          onAssign={(id) => { setExpanded(null); p.onAssignHousehold(id); }}
                          onLog={(id, o, how) => { setExpanded(null); p.onLog(id, o, how); }} />
                      )}
                    </li>
                  );
                })}
                {!queueRows.length && <li className="muted empty">Everyone has been heard from.</li>}
              </ul>
            </div>
          )}

          {live && (
            <div className="p2-pane" hidden={tab !== 'requests'}>
              <div className="gseg req-tabs" role="tablist" aria-label="Request type">
                {([['referral', '911 / agency', '911 / local agency referrals (life safety)'], ['assistance', 'Care', 'Customer care requests'], ['inspection_request', 'Inspection', 'Inspection requests']] as [RequestTab, string, string][]).map(([id, label, title]) => (
                  <button key={id} role="tab" aria-selected={reqTab === id} className={reqTab === id ? 'on' : ''} onClick={() => setReqTab(id)} title={title}>
                    {label} <span className={`tab-badge${id === 'referral' && overdue ? ' red' : ''}`}>{reqCounts[id].toLocaleString()}</span>
                  </button>
                ))}
              </div>
              {live && (
                <div className="p2-pane" hidden={reqTab !== 'referral'}>
                  <ReferralList rankOf={rankOf} cellPrio={cellPrio} simMinutes={p.simMinutes} labeler={p.labeler} fictional={p.fictional} canAct={p.canAct} onNeedJoin={p.onNeedJoin} onOpen={p.onOpen} />
                </div>
              )}
              {(['assistance', 'inspection_request'] as const).map((kind) => live && (
                <div key={kind} className="p2-pane" hidden={reqTab !== kind}>
                  <RequestList kind={kind} rankOf={rankOf} cellPrio={cellPrio} simMinutes={p.simMinutes} labeler={p.labeler} fictional={p.fictional}
                    latestReply={p.latestReply} sentTo={p.sentTo} canAssign={p.adjusters.length > 0}
                    onAssign={(id) => act(() => p.onAssignHousehold(id))()} onOpen={p.onOpen} />
                </div>
              ))}
            </div>
          )}

          {live && (
            <div className="p2-pane" hidden={tab !== 'feed'}>
              <ul className="p2-list">
                {feedRows.map((f) => (
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
                {!p.feed.length && <li className="muted empty">No events yet. Press Start.</li>}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
