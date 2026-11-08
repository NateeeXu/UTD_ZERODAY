// Decision trace: one reply, read by Claude, decided by the rules. Live tables only.
//   1 Reply             sms_reply (text, language, channel, t), or the household's pending reply_inbox row
//   2 Sent to Claude    reply_inbox matched by householdId + text (status, receivedAt → parsedAt, error)
//   3 Claude output     sms_reply (safety, lifeSafety, needs, notHome, damage, damageKnown)
//   4 Keyword net       reply_inbox.error "keyword_net:<rules>" (parser.ts writes it only when the net raised life safety)
//   5 Rules and engine  household_estimate (escalation, pNeedsHelp, pSevere)
//   6 Home and cell     hex_stats (priority, verification, severeLo–severeHi, reason). Before → after only when the
//                       old row came from the hex_stats update in the same transaction as this reply, seen while
//                       the page was open (useReplyCellCapture). Otherwise the current value. Never an invented before.
//   7 Action            escalation → action (deterministic)
// Claude's confidence and raw JSON are not stored in the backend, so they are not shown.
// Nothing here dials: no tel: links, no arrival times, no coverage or payment promises.
import './decision-trace.css';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Infer } from 'spacetimedb';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables, type DbConnection, type EventContext } from '../module_bindings/index.ts';
import type ReplyInboxRowDef from '../module_bindings/reply_inbox_table.ts';
import type { HexStatsRow, HouseholdEstimateRow, SmsReplyRow } from './rows';
import { ESCALATION } from './accounting';
import { DAMAGE, needsText } from './household';
import { prio, severeRange, type Priority } from './mapModel';
import { fmtT, homeLabel, pct } from '../format';

type ReplyInboxRow = Infer<typeof ReplyInboxRowDef>;

const STEPS = [
  { title: 'Reply', bar: 'Reply', lane: '' },
  { title: 'Sent to Claude', bar: 'Sent', lane: 'c' },
  { title: 'Claude output', bar: 'Claude', lane: 'c' },
  { title: 'Keyword net', bar: 'Net', lane: 'r' },
  { title: 'Rules and engine', bar: 'Rules', lane: 'r' },
  { title: 'Home and cell', bar: 'Cell', lane: 'r' },
  { title: 'Action', bar: 'Action', lane: 'r' },
] as const;
const LAST = STEPS.length - 1;
const SENT = 1; // last step a reply still waiting for Claude can reach
const TICK_MS = 1000;
const NONE = '__none__';

// ---------------------------------------------------------------------------------------------
// Before → after for the cell, captured live.
// A reply and the hex_stats update it causes arrive in one transaction (ingest.ts onEvent →
// recomputeHex). Listening on the connection (ManagerLive already subscribes to both tables) gives
// each callback the transaction's event id, so the cell's old row is tied to the reply exactly.
// Resolved synchronously inside the transaction's callbacks, so the next render already sees it.
// ---------------------------------------------------------------------------------------------

export type CellChange = { before: HexStatsRow; after: HexStatsRow; replies: number };
export type ReplyCellCapture = { get(replyId: bigint): CellChange | undefined };
const KEEP_CAPTURES = 4000;

export function useReplyCellCapture(): ReplyCellCapture {
  const conn = useSpacetimeDB().getConnection() as DbConnection | null;
  const [byReply] = useState(() => new Map<bigint, CellChange>());
  useEffect(() => {
    if (!conn) return;
    type Tx = { cells: Map<string, CellChange>; replies: SmsReplyRow[] };
    const txs = new Map<string, Tx>();
    const open = (id: string): Tx => {
      let tx = txs.get(id);
      if (!tx) {
        tx = { cells: new Map(), replies: [] };
        txs.set(id, tx);
        queueMicrotask(() => txs.delete(id)); // the transaction's callbacks all run synchronously
      }
      return tx;
    };
    const live = (ctx: EventContext) => ctx.event.tag === 'Transaction' || ctx.event.tag === 'Reducer';
    const link = (r: SmsReplyRow, ch: CellChange) => {
      ch.replies += 1;
      byReply.set(r.id, ch);
      if (byReply.size > KEEP_CAPTURES) byReply.delete(byReply.keys().next().value!);
    };
    const onInsert = (ctx: EventContext, r: SmsReplyRow) => {
      if (!live(ctx)) return;
      const tx = open(ctx.event.id);
      tx.replies.push(r);
      const ch = tx.cells.get(r.hex);
      if (ch) link(r, ch);
    };
    const onUpdate = (ctx: EventContext, before: HexStatsRow, after: HexStatsRow) => {
      if (!live(ctx)) return;
      const tx = open(ctx.event.id);
      const ch: CellChange = { before, after, replies: 0 };
      tx.cells.set(after.hex, ch);
      for (const r of tx.replies) if (r.hex === after.hex) link(r, ch);
    };
    conn.db.smsReply.onInsert(onInsert);
    conn.db.hexStats.onUpdate(onUpdate);
    return () => {
      conn.db.smsReply.removeOnInsert(onInsert);
      conn.db.hexStats.removeOnUpdate(onUpdate);
    };
  }, [conn, byReply]);
  return useMemo(() => ({ get: (id: bigint) => byReply.get(id) }), [byReply]);
}

// ---------------------------------------------------------------------------------------------
// Targeted subscriptions: this household's reply_inbox rows and household_estimate row.
// ---------------------------------------------------------------------------------------------

function useInbox(householdId: string | null): [readonly ReplyInboxRow[], boolean] {
  const query = useMemo(() => tables.replyInbox.where((r) => r.householdId.eq(householdId ?? NONE)), [householdId]);
  return useTable(query, { enabled: !!householdId });
}

function useEstimate(householdId: string | null): [HouseholdEstimateRow | undefined, boolean] {
  const query = useMemo(() => tables.householdEstimate.where((r) => r.householdId.eq(householdId ?? NONE)), [householdId]);
  const [rows, ready] = useTable(query, { enabled: !!householdId });
  return [rows[0], ready];
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const ms = (ts: { toDate(): Date }) => ts.toDate().getTime();
const cmpBig = (a: bigint, b: bigint) => (a > b ? 1 : a < b ? -1 : 0);
const newerReply = (a: SmsReplyRow, b: SmsReplyRow) => a.t - b.t || ms(a.ingestedAt) - ms(b.ingestedAt) || cmpBig(a.id, b.id);
const fresh = (r: SmsReplyRow) => Date.now() - ms(r.ingestedAt) < 60_000;

let langNames: Intl.DisplayNames | null | undefined;
function langName(code: string | undefined): string {
  if (!code) return 'Language unknown';
  if (langNames === undefined) {
    try {
      langNames = new Intl.DisplayNames(['en'], { type: 'language' });
    } catch {
      langNames = null;
    }
  }
  try {
    return langNames?.of(code) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const yesNo = (b: boolean) => (b ? 'Yes' : 'No');
const channelName = (c: string) => (c === 'call' ? 'Call' : 'SMS');

function safetyLabel(r: SmsReplyRow): string {
  if (r.lifeSafety) return 'Life safety';
  if (r.safety === 'needs_help' && !r.needs.trim()) return 'Unsure';
  return r.safety === 'safe' ? 'Safe' : 'Needs help';
}
const damageLabel = (r: SmsReplyRow) => (r.damageKnown ? DAMAGE[r.damage] ?? String(r.damage) : 'Unknown');

// reply_inbox.error: "review: keyword_net:fire+gas,unsure" | "parser: timeout; fallback submitted" | "submit: …"
// Only the keyword_net part is shown. Other review flags (e.g. low_confidence) stay hidden: confidence is not shown.
function keywordRules(error: string): string[] {
  const m = error.match(/keyword_net:([^,;|\s]+)/);
  return m ? m[1].split('+').filter(Boolean) : [];
}

// The inbox row this reply came from: same household (the subscription), same text, received before it was ingested.
function matchInbox(rows: readonly ReplyInboxRow[], reply: SmsReplyRow): ReplyInboxRow | undefined {
  if (!reply.text) return undefined;
  const same = rows.filter((r) => r.text === reply.text);
  const at = ms(reply.ingestedAt);
  const before = same.filter((r) => ms(r.receivedAt) <= at + 1000);
  const pool = before.length ? before : same;
  return pool.reduce<ReplyInboxRow | undefined>((a, b) => (!a || ms(b.receivedAt) > ms(a.receivedAt) ? b : a), undefined);
}

const ROUTES = [
  ['life_safety', 'Referral'],
  ['needs_help', 'Customer care'],
  ['needs inspection', 'Inspection request'],
  ['else', 'Accounted'],
] as const;
function routeIndex(esc: string): number {
  if (esc === 'emergency_referral' || esc.startsWith('referral_')) return 0;
  if (esc === 'assistance') return 1;
  if (esc === 'inspection_request') return 2;
  if (esc === 'accounted' || esc === 'recheck') return 3;
  return -1;
}

function actionFor(esc: string): { label: string; tone: 'ref' | 'req' | 'none' | 'other'; call911: boolean } {
  switch (esc) {
    case 'emergency_referral': return { label: 'Referral created', tone: 'ref', call911: true };
    case 'assistance': return { label: 'Customer care request', tone: 'req', call911: false };
    case 'inspection_request': return { label: 'Inspection request', tone: 'req', call911: false };
    case 'accounted': return { label: 'No further action', tone: 'none', call911: false };
    default: return { label: ESCALATION[esc]?.label ?? (esc || '—'), tone: 'other', call911: false };
  }
}

const verificationLabel = (v: string) => (v === 'verified' ? 'Verified' : 'Needs check');
const rangeOf = (h: HexStatsRow) => severeRange({ lo: h.severeLo, hi: h.severeHi, ex: h.expectedSevere });
const sameCell = (a: HexStatsRow, b: HexStatsRow) =>
  a.priority === b.priority && a.verification === b.verification && rangeOf(a) === rangeOf(b) && a.reason === b.reason;

function Pri({ p }: { p: string }) {
  const q: Priority = prio(p);
  return <span className={`chip chip-${q}`}>{q}</span>;
}

function reducedMotion(): boolean {
  try {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const COLLAPSE_KEY = 'triage.decisionTrace.collapsed';
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}
function writeCollapsed(v: boolean) {
  try {
    localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
  } catch {
    /* per-viewer convenience only */
  }
}

// ---------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------

export interface DecisionTraceProps {
  /** Household panel: trace this home's latest reply. */
  householdId?: string;
  /** Area panel: trace the home with the most recent reply in these res-8 cells. */
  cellHexes?: readonly string[];
  /** Newest sms_reply per household (ManagerLive's existing subscription). */
  latestReply: Map<string, SmsReplyRow>;
  cellBy: Map<string, HexStatsRow>;
  capture: ReplyCellCapture;
  labelCell: (hex: string) => string;
  fictional: boolean;
  onOpenHousehold?: (id: string, hex: string) => void;
}

export function DecisionTrace(props: DecisionTraceProps) {
  const { householdId, cellHexes, latestReply } = props;
  const hexKey = cellHexes ? cellHexes.join(',') : null;
  const latestInCell = useMemo(() => {
    if (hexKey === null) return undefined;
    const set = new Set(hexKey.split(','));
    let best: SmsReplyRow | undefined;
    for (const r of latestReply.values()) if (set.has(r.hex) && (!best || newerReply(r, best) > 0)) best = r;
    return best;
  }, [hexKey, latestReply]);

  // Area panel: pinned to one home so stepping is not interrupted by the replay; a reply from the
  // live check-in page takes over (that is the one people are watching for), anything else waits behind a link.
  const [pinned, setPinned] = useState<string | null>(latestInCell?.householdId ?? null);
  useEffect(() => {
    if (!latestInCell || latestInCell.householdId === pinned) return;
    if (!pinned || (latestInCell.source === 'live' && fresh(latestInCell))) setPinned(latestInCell.householdId);
  }, [latestInCell, pinned]);

  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => setCollapsed((c) => {
    writeCollapsed(!c);
    return !c;
  });

  const id = householdId ?? pinned;
  const newer = hexKey !== null && latestInCell && latestInCell.householdId !== id ? latestInCell : undefined;
  return (
    <TracePanel
      key={id ?? NONE}
      householdId={id}
      reply={id ? latestReply.get(id) : undefined}
      area={hexKey !== null}
      newer={newer}
      onShowNewer={() => newer && setPinned(newer.householdId)}
      collapsed={collapsed}
      onToggle={toggle}
      cellBy={props.cellBy}
      capture={props.capture}
      labelCell={props.labelCell}
      fictional={props.fictional}
      onOpenHousehold={props.onOpenHousehold}
    />
  );
}

type Subject =
  | { kind: 'none' }
  | { kind: 'pending'; inbox: ReplyInboxRow }
  | { kind: 'reply'; reply: SmsReplyRow; inbox: ReplyInboxRow | undefined };

function TracePanel({ householdId, reply, area, newer, onShowNewer, collapsed, onToggle, cellBy, capture, labelCell, fictional, onOpenHousehold }: {
  householdId: string | null;
  reply: SmsReplyRow | undefined;
  area: boolean;
  newer: SmsReplyRow | undefined;
  onShowNewer: () => void;
  collapsed: boolean;
  onToggle: () => void;
  cellBy: Map<string, HexStatsRow>;
  capture: ReplyCellCapture;
  labelCell: (hex: string) => string;
  fictional: boolean;
  onOpenHousehold?: (id: string, hex: string) => void;
}) {
  const [inbox, inboxReady] = useInbox(householdId);
  const [est, estReady] = useEstimate(householdId);

  // A raw reply waiting for the parser (newer than the latest parsed reply) is the trace's subject until it lands.
  const subject = useMemo<Subject>(() => {
    const pending = inbox
      .filter((r) => r.status === 'pending' && (!reply || ms(r.receivedAt) > ms(reply.ingestedAt)))
      .reduce<ReplyInboxRow | undefined>((a, b) => (!a || ms(b.receivedAt) > ms(a.receivedAt) ? b : a), undefined);
    if (pending) return { kind: 'pending', inbox: pending };
    if (reply) return { kind: 'reply', reply, inbox: matchInbox(inbox, reply) };
    return { kind: 'none' };
  }, [inbox, reply]);

  const subjectKey = subject.kind === 'pending' ? `i${subject.inbox.id}` : subject.kind === 'reply' ? `r${subject.reply.id}` : '';
  const subjectText = subject.kind === 'pending' ? subject.inbox.text : subject.kind === 'reply' ? subject.reply.text ?? '' : '';
  const maxStep = subject.kind === 'pending' ? SENT : subject.kind === 'reply' ? LAST : 0;

  const [still] = useState(reducedMotion);
  const [step, setStep] = useState(() => (still && subjectKey ? LAST : 0));
  const [playing, setPlaying] = useState(() => !still && !!subjectKey);
  const shownStep = Math.min(step, maxStep);
  const isPlaying = playing && shownStep < maxStep;

  // A new reply for this home restarts the trace; the parsed version of the reply being read continues it.
  const prev = useRef({ key: subjectKey, text: subjectText, pending: subject.kind === 'pending' });
  useEffect(() => {
    const p = prev.current;
    prev.current = { key: subjectKey, text: subjectText, pending: subject.kind === 'pending' };
    if (p.key === subjectKey || !subjectKey) return;
    if (still) {
      setStep(LAST); // reduced motion: show the whole trace (clamped to "Sent to Claude" while it is being read)
      setPlaying(false);
      return;
    }
    const continues = p.pending && subject.kind === 'reply' && p.text === subjectText;
    setStep((s) => (continues ? Math.max(Math.min(s, SENT) + 1, 2) : 0));
    setPlaying(true);
  }, [subjectKey, subjectText, subject.kind, still]);

  useEffect(() => {
    if (!isPlaying) return;
    const t = setTimeout(() => setStep((s) => Math.min(s, maxStep) + 1), TICK_MS);
    return () => clearTimeout(t);
  }, [isPlaying, shownStep, maxStep]);

  const go = (i: number) => {
    setPlaying(false);
    setStep(Math.max(0, Math.min(maxStep, i)));
  };
  const play = () => {
    if (isPlaying) return setPlaying(false);
    if (shownStep >= maxStep) setStep(0);
    setPlaying(true);
  };
  const replay = () => {
    setStep(0);
    setPlaying(true);
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    if (e.key === 'ArrowRight' && shownStep < maxStep) { e.preventDefault(); go(shownStep + 1); }
    if (e.key === 'ArrowLeft' && shownStep > 0) { e.preventDefault(); go(shownStep - 1); }
  };

  // Keep the open step on screen inside the panel's own scroll area (never scrolls the page).
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = bodyRef.current;
    const cur = body?.querySelector<HTMLElement>('.dt-step.cur');
    if (!body || !cur) return;
    const b = body.getBoundingClientRect();
    const r = cur.getBoundingClientRect();
    let top = body.scrollTop;
    if (r.bottom > b.bottom - 8) top += Math.min(r.bottom - b.bottom + 12, r.top - b.top - 8);
    else if (r.top < b.top + 8) top -= b.top - r.top + 8;
    if (top !== body.scrollTop) body.scrollTo({ top, behavior: still ? 'auto' : 'smooth' });
  }, [shownStep, subjectKey, collapsed, still]);

  const hex = subject.kind === 'reply' ? subject.reply.hex : reply?.hex ?? null;
  const home = householdId ? homeLabel(householdId, fictional) : null;
  const when = subject.kind === 'reply'
    ? fmtT(subject.reply.t)
    : subject.kind === 'pending'
      ? subject.inbox.receivedAt.toDate().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : null;
  const empty = subject.kind === 'none';

  return (
    <aside className={`card dt${collapsed ? ' dt-collapsed' : ''}${empty ? ' dt-empty' : ''}`} aria-label="Decision trace" onKeyDown={onKey}>
      <div className="dt-head">
        <div className="dt-title">
          <h2>Decision trace</h2>
          <span className="dt-sub" title={area ? 'Latest reply in this area' : undefined}>
            {home && area && onOpenHousehold && hex
              ? <button className="link dt-home" onClick={() => onOpenHousehold(householdId!, hex)} title="Latest reply in this area · open this home">{home}</button>
              : home}
            {when && <> · {when}</>}
          </span>
          <button className="dt-x" onClick={onToggle} aria-expanded={!collapsed} aria-label={collapsed ? 'Show decision trace' : 'Hide decision trace'}>
            <span className={`dt-caret${collapsed ? ' down' : ''}`} />
          </button>
        </div>
        {!collapsed && newer && (
          <div className="dt-area">
            <span>A newer reply came in here</span>
            <button className="link dt-newer" onClick={onShowNewer}>Show {homeLabel(newer.householdId, fictional)} →</button>
          </div>
        )}
        {!collapsed && <Lanes step={empty ? -1 : shownStep} />}
        {!collapsed && !empty && (
          <>
            <div className="dt-controls">
              <button className="btn primary" onClick={play} aria-pressed={isPlaying}>{isPlaying ? 'Pause' : 'Play'}</button>
              <button className="btn" onClick={() => go(shownStep - 1)} disabled={shownStep === 0}>Back</button>
              <button className="btn" onClick={() => go(shownStep + 1)} disabled={shownStep >= maxStep}>Next</button>
              <button className="btn ghost" onClick={replay}>Replay</button>
              <span className="dt-count" aria-live="polite">Step {shownStep + 1} of {STEPS.length}</span>
            </div>
            <div className="dt-track" role="group" aria-label="Steps">
              {STEPS.map((s, i) => (
                <button key={s.bar} className={i < shownStep ? 'done' : i === shownStep ? 'on' : ''} onClick={() => go(i)} disabled={i > maxStep}
                  aria-label={`Step ${i + 1}: ${s.title}`} title={s.title} aria-current={i === shownStep ? 'step' : undefined} />
              ))}
            </div>
          </>
        )}
      </div>

      {!collapsed && (
        <div className="dt-body" ref={bodyRef}>
          {empty ? (
            <p className="dt-none">
              {!householdId ? 'No replies in this area yet.' : 'No reply from this home yet.'} The trace starts when one arrives.
            </p>
          ) : (
            <Path
              subject={subject}
              step={shownStep}
              onGo={go}
              inboxReady={inboxReady}
              est={est}
              estReady={estReady}
              cell={hex ? cellBy.get(hex) : undefined}
              change={subject.kind === 'reply' ? capture.get(subject.reply.id) : undefined}
              cellLabel={hex ? labelCell(hex) : ''}
              home={home ?? ''}
            />
          )}
        </div>
      )}
    </aside>
  );
}

function Lanes({ step }: { step: number }) {
  const lane = step >= 0 ? STEPS[step].lane : '';
  return (
    <div className="dt-lanes">
      <div className={`dt-lane c${lane === 'c' ? ' on' : ''}`}>
        <b>Claude reads</b>
      </div>
      <div className={`dt-lane r${lane === 'r' ? ' on' : ''}`}>
        <b>Rules decide</b>
      </div>
    </div>
  );
}

function Path({ subject, step, onGo, inboxReady, est, estReady, cell, change, cellLabel, home }: {
  subject: Exclude<Subject, { kind: 'none' }>;
  step: number;
  onGo: (i: number) => void;
  inboxReady: boolean;
  est: HouseholdEstimateRow | undefined;
  estReady: boolean;
  cell: HexStatsRow | undefined;
  change: CellChange | undefined;
  cellLabel: string;
  home: string;
}) {
  const steps = subject.kind === 'pending' ? pendingSteps(subject.inbox) : replySteps(subject.reply, subject.inbox, inboxReady, est, estReady, cell, change, cellLabel, home);
  return (
    <ol className="dt-path">
      {STEPS.map((s, i) => {
        const st = i < step ? 'done' : i === step ? 'cur' : 'todo';
        const v = steps[i];
        return (
          <li key={s.title} className={`dt-step ${st}${s.lane === 'c' ? ' claude' : ''}`}>
            <button className="dt-step-h" onClick={() => onGo(i)} aria-current={i === step ? 'step' : undefined} aria-expanded={i === step}>
              <b>{s.title}</b>
              {i === step ? <span className={`dt-src${v.srcMono ? ' mono' : ''}`}>{v.src}</span> : i < step ? <span className="dt-sum">{v.sum}</span> : null}
            </button>
            {i === step && <div className="dt-step-b">{v.body}</div>}
          </li>
        );
      })}
    </ol>
  );
}

type StepView = { sum: string; src: string; srcMono?: boolean; body: ReactNode };

function Field({ label, value, wide = false, strong = false }: { label: string; value: ReactNode; wide?: boolean; strong?: boolean }) {
  return (
    <div className={`dt-field${wide ? ' wide' : ''}${strong ? ' strong' : ''}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function pendingSteps(inbox: ReplyInboxRow): StepView[] {
  const waiting: StepView = { sum: '', src: 'Waiting', body: <p className="dt-note">Waiting for Claude to read the reply.</p> };
  return [
    {
      sum: 'Received',
      src: 'reply_inbox',
      srcMono: true,
      body: (
        <>
          <div className="dt-msg">{inbox.text}</div>
          <div className="dt-tags">
            <span className="dt-tag">{langName(inbox.language || undefined)}</span>
            <span className="dt-tag">Check-in page</span>
            <span className="dt-tag">Live</span>
          </div>
        </>
      ),
    },
    {
      sum: 'Reading…',
      src: 'reply_inbox',
      srcMono: true,
      body: (
        <>
          <div className="dt-reading" role="status"><i />Reading…</div>
          <p className="dt-note">Only the reply text is sent. No name, address or policy.</p>
        </>
      ),
    },
    waiting, waiting, waiting, waiting, waiting,
  ];
}

function replySteps(
  r: SmsReplyRow,
  inbox: ReplyInboxRow | undefined,
  inboxReady: boolean,
  est: HouseholdEstimateRow | undefined,
  estReady: boolean,
  cell: HexStatsRow | undefined,
  change: CellChange | undefined,
  cellLabel: string,
  home: string,
): StepView[] {
  const lang = langName(r.language);
  const loadingInbox = !inbox && !inboxReady;
  const error = inbox?.error ?? '';
  const rules = keywordRules(error);
  const fallback = inbox?.status === 'failed';
  const parsedMs = inbox?.parsedAt ? ms(inbox.parsedAt) - ms(inbox.receivedAt) : null;

  // 1 Reply
  const s1: StepView = {
    sum: `${lang} · ${channelName(r.channel)}`,
    src: 'sms_reply',
    srcMono: true,
    body: (
      <>
        {r.text ? <div className="dt-msg">{r.text}</div> : <div className="dt-msg sim">Simulated reply</div>}
        <div className="dt-tags">
          <span className="dt-tag">{lang}</span>
          <span className="dt-tag">{channelName(r.channel)}</span>
          <span className="dt-tag">{fmtT(r.t)}</span>
          {r.text && <span className="dt-tag">{r.source === 'live' ? 'Live' : 'Simulated'}</span>}
        </div>
      </>
    ),
  };

  // 2 Sent to Claude
  let s2: StepView;
  if (loadingInbox) s2 = { sum: 'Loading…', src: 'reply_inbox', srcMono: true, body: <p className="dt-note">Loading…</p> };
  else if (!inbox) {
    s2 = {
      sum: 'Not parsed',
      src: 'reply_inbox',
      srcMono: true,
      body: (
        <>
          <div className="dt-status">Not parsed</div>
          <p className="dt-note">{r.text ? 'No reply_inbox row for this text, so Claude did not read it.' : 'No free text, so there was nothing for Claude to read.'}</p>
        </>
      ),
    };
  } else if (inbox.status === 'pending') {
    s2 = { sum: 'Reading…', src: 'reply_inbox', srcMono: true, body: <div className="dt-reading" role="status"><i />Reading…</div> };
  } else {
    const took = parsedMs !== null && parsedMs >= 0 ? `${(parsedMs / 1000).toFixed(1)} s` : null;
    s2 = {
      sum: fallback ? 'Failed · fallback' : `Parsed${took ? ` · ${took}` : ''}`,
      src: 'reply_inbox',
      srcMono: true,
      body: (
        <>
          <pre className="dt-mono">{inbox.text}</pre>
          <div className="dt-tags">
            <span className={`dt-tag${fallback ? '' : ' ink'}`}>{fallback ? 'Failed' : 'Parsed'}</span>
            {took && <span className="dt-tag">Received → parsed {took}</span>}
          </div>
          {fallback && error && <pre className="dt-mono dt-err">{error}</pre>}
          <p className="dt-note">Only the reply text is sent. No name, address or policy.</p>
        </>
      ),
    };
  }

  // 3 Claude output (as submitted to sms_reply)
  const src3 = loadingInbox ? '…' : !inbox ? 'Not from Claude' : fallback ? 'Fallback' : 'Claude';
  const label3 = safetyLabel(r);
  const needs = cap(needsText(r.needs)) || 'None';
  const s3: StepView = {
    sum: label3,
    src: src3,
    body: (
      <>
        <div className="dt-fields">
          <Field label="Safety" value={label3} strong={r.lifeSafety} />
          <Field label="Damage" value={damageLabel(r)} />
          <Field label="Needs" value={needs} wide />
          <Field label="Not home" value={yesNo(r.notHome)} />
          <Field label="Language" value={r.language ?? '—'} />
        </div>
        {rules.length > 0 && <p className="dt-note">Life safety was raised by the keyword net (step 4), not by Claude.</p>}
        {fallback && <p className="dt-note">Claude's answer was not used: these are the fallback values.</p>}
        {!loadingInbox && !inbox && <p className="dt-note">{r.source === 'live' ? 'Fields came with the reply, not from Claude.' : 'Fields came from the simulator, not from Claude.'}</p>}
      </>
    ),
  };

  // 4 Keyword net (the worker writes reply_inbox.error when it marks the row parsed)
  const s4: StepView = inbox?.status === 'pending' ? {
    sum: 'Waiting',
    src: 'reply_inbox.error',
    srcMono: true,
    body: <p className="dt-note">Waiting for the parser to finish.</p>,
  } : {
    sum: rules.length ? `${rules[0]}${rules.length > 1 ? ` +${rules.length - 1}` : ''} · Raised` : 'No hit',
    src: 'reply_inbox.error',
    srcMono: true,
    body: rules.length ? (
      <>
        <div className="dt-tags">{rules.map((x) => <span key={x} className="dt-tag mono ink">{x}</span>)}</div>
        <div className="dt-status">Raised to life safety</div>
        <p className="dt-note">Escalate only: the net never lowers anything.</p>
      </>
    ) : (
      <>
        <div className="dt-status">No hit</div>
        <p className="dt-note">
          {fallback ? 'Hits are not recorded on fallback replies.' : !inbox ? 'The net runs on replies Claude reads.' : 'The net records a hit only when it raises life safety.'}
        </p>
      </>
    ),
  };

  // 5 Rules and engine
  const esc = est?.escalation ?? '';
  const ri = routeIndex(esc);
  const s5: StepView = !est
    ? { sum: estReady ? 'No estimate' : 'Loading…', src: 'household_estimate', srcMono: true, body: <p className="dt-note">{estReady ? 'No household_estimate row for this home.' : 'Loading…'}</p> }
    : {
      sum: esc,
      src: 'household_estimate',
      srcMono: true,
      body: (
        <>
          <div className="dt-esc"><code>{esc}</code><span>{ESCALATION[esc]?.label ?? ''}</span></div>
          <div className="dt-route">
            {ROUTES.map(([rule, to], i) => (
              <div key={rule} className={i === ri ? 'on' : ''}><code>{rule}</code><span>{to}</span></div>
            ))}
          </div>
          {ri < 0 && <p className="dt-note">Escalation has moved past the reply rules.</p>}
          <div className="dt-fields">
            <Field label="P(needs help)" value={pct(est.pNeedsHelp)} />
            <Field label="P(severe)" value={pct(est.pSevere)} />
          </div>
        </>
      ),
    };

  // 6 Home and cell
  let s6: StepView;
  if (!cell) s6 = { sum: '—', src: 'hex_stats', srcMono: true, body: <p className="dt-note">Cell not loaded.</p> };
  else {
    const b = change?.before;
    const a = change?.after ?? cell;
    const moved = change && !sameCell(change.after, cell);
    s6 = {
      sum: b ? `${prio(b.priority)} → ${prio(a.priority)} · ${rangeOf(a)}` : `${prio(cell.priority)} · ${rangeOf(cell)}`,
      src: 'hex_stats',
      srcMono: true,
      body: (
        <>
          <div className="dt-cellhead"><b>{home}</b><span>{est ? (est.accounted ? 'Accounted' : 'Not heard from') : ''}</span></div>
          <div className="dt-cellhead"><b>{cellLabel}</b><span>{b ? 'Before → after this reply' : 'Current'}</span></div>
          {b ? (
            <div className="dt-ct">
              <span className="l">Priority</span><span className="b"><Pri p={b.priority} /></span><span className="ar">→</span><span className="a"><Pri p={a.priority} /></span>
              <Row label="Verification" before={verificationLabel(b.verification)} after={verificationLabel(a.verification)} />
              <Row label="Severe range" before={rangeOf(b)} after={rangeOf(a)} />
            </div>
          ) : (
            <div className="dt-kv">
              <span className="l">Priority</span><span className="a"><Pri p={cell.priority} /></span>
              <span className="l">Verification</span><span className="a">{verificationLabel(cell.verification)}</span>
              <span className="l">Severe range</span><span className="a">{rangeOf(cell)}</span>
            </div>
          )}
          {b && b.reason !== a.reason ? (
            <div className="dt-reason"><span className="was">{b.reason}</span><span>{a.reason}</span></div>
          ) : (
            a.reason && <div className="dt-reason"><span>{a.reason}</span></div>
          )}
          {change && change.replies > 1 && <p className="dt-note">That update carried {change.replies} replies in this cell.</p>}
          {moved && <p className="dt-note">Now: {prio(cell.priority)} · {verificationLabel(cell.verification)} · {rangeOf(cell)}</p>}
        </>
      ),
    };
  }

  // 7 Action
  const act = actionFor(esc);
  const s7: StepView = !est
    ? { sum: '—', src: 'Deterministic', body: <p className="dt-note">{estReady ? 'No escalation for this home.' : 'Loading…'}</p> }
    : {
      sum: act.label,
      src: 'Deterministic',
      body: (
        <>
          <div className={`dt-action ${act.tone}`}>{act.label}</div>
          {act.call911 && <p className="dt-911">Call 911 now if anyone is in danger.</p>}
        </>
      ),
    };

  return [s1, s2, s3, s4, s5, s6, s7];
}

function Row({ label, before, after }: { label: string; before: string; after: string }) {
  return (
    <>
      <span className="l">{label}</span>
      <span className="b">{before}</span>
      <span className="ar">→</span>
      <span className={`a${before === after ? ' same' : ''}`}>{after}</span>
    </>
  );
}
