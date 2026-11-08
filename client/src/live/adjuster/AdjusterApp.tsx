// Adjuster phone (docs/ADJUSTER_APP.md): Tasks, Home, Go to area, Field report, Report sent, Can't make contact.
// Areas, never house points: the households are synthetic but their coordinates fall on real streets, so
// the phone shows the H3 cell and routes to its center inside the app (no external map app).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { cellToLatLng } from 'h3-js';
import { reducers, tables } from '../../module_bindings/index.ts';
import { initialLiveRegion } from '../config';
import { JoinDialog, useAutoRejoin } from '../JoinDialog';
import { makeLabeler } from '../labels';
import { COLOR, RANK, cellSetKey, prio, type Priority } from '../mapModel';
import { useEstimatesById, useHouseholdsById } from '../hooks';
import { fmtAgo, fmtT, homeLabel } from '../../format';
import type {
  AssignmentRow, FieldReportRow, HexRow, HexStatsRow, HouseholdEstimateRow, HouseholdFollowupRow, HouseholdRow, MemberRow, SmsReplyRow,
} from '../rows';
import * as D from './derive';
import { useChatFor, useFollowupsFor, useHexRows, useImessageFor, useRepliesFor, useReportsFor, useSentFor, type ChatRow, type ImessageRow } from './data';
import { ChatScreen, NotifiedCard, NotifiedChips } from './Chat';
import { useOutbox, type Draft, type ReportMode, type SentRecord } from './outbox';
import { PhoneMap, type MapArea } from './PhoneMap';
import { CloseSheet, ReportScreen, SentSheet, type NextInfo, type ReportTarget } from './ReportFlow';
import { Icon, needIcon } from './icons';
import './adjuster.css';

interface Task {
  a: AssignmentRow;
  id: string;
  hex: string;
  open: boolean;
  number: number;
  label: string;
  hh?: HouseholdRow;
  est?: HouseholdEstimateRow;
  cell?: HexStatsRow;
  hexRow?: HexRow;
  priority: Priority;
  type: D.TaskType;
  job: D.Job;
  district: string;
  miles: number | null;
  replies: SmsReplyRow[];
  reports: FieldReportRow[];
  sent: D.SmsSentRow[];
  followup?: HouseholdFollowupRow;
  silent: number | null;
  banner: D.Banner | null;
  unsent: boolean;
  /** Latest iMessage notice for this household: present when I accepted it from Next best. */
  notice?: ImessageRow;
}

type Tab = 'tasks' | 'messages' | 'me';
type Route =
  | { name: Tab }
  | { name: 'home'; id: string; close?: boolean }
  | { name: 'goto'; id: string }
  | { name: 'report'; id: string; mode: ReportMode; prefillOp?: string; opId?: string }
  | { name: 'sent'; opId: string }
  | { name: 'chat'; id: string; from: 'tasks' | 'home' | 'messages' };

export function AdjusterApp() {
  const [myMember, memberReady] = useTable(tables.myMember);
  const me = myMember[0];
  const db = useMemo(() => initialLiveRegion().db ?? undefined, []);
  const rejoining = useAutoRejoin('adjuster', db, !!me, memberReady);
  if (!me || me.role !== 'adjuster') {
    return (
      <div className="adj">
        <div className="adj-join">
          <strong style={{ fontSize: 22 }}>Field tasks</strong>
          <span className="adj-muted">{rejoining ? 'Rejoining as adjuster…' : 'Join as an adjuster to see your tasks.'}</span>
          {!rejoining && <JoinDialog role="adjuster" db={db} onDone={() => undefined} />}
        </div>
      </div>
    );
  }
  return <Field meName={me.name} />;
}

// ---- Connection badge (never hard-coded) ----
type LiveState = 'live' | 'reconnecting' | 'offline' | 'connecting';
const LIVE_LABEL: Record<LiveState, string> = { live: 'Live', reconnecting: 'Reconnecting', offline: 'Offline', connecting: 'Connecting' };
function useLiveState(isActive: boolean): LiveState {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  const ever = useRef(false);
  if (isActive) ever.current = true;
  if (!online) return 'offline';
  if (isActive) return 'live';
  return ever.current ? 'reconnecting' : 'connecting';
}
function LiveBadge({ state, unsent, className = '' }: { state: LiveState; unsent: number; className?: string }) {
  return (
    <span className={`adj-live ${state} ${className}`} role="status">
      <i />{LIVE_LABEL[state]}{unsent > 0 && <span className="unsent"> · {unsent} unsent</span>}
    </span>
  );
}

// "Next best" row (docs/ADJUSTER_APP.md section 2.7): the caller's own recommendations.
export type NextBest = { householdId: string; rank: number; priority: string; distanceKm: number; etaMin: number; reason: string };
/** Next best distance: straight line, miles with one decimal. */
const recMiles = (km: number) => `${(km * 0.621).toFixed(1)} mi`;

function Field({ meName }: { meName: string }) {
  const conn = useSpacetimeDB();
  const myId = conn.identity;
  const [mine, mineReady] = useTable(tables.myAssignments);
  const [cells] = useTable(tables.hexStats);
  const [worldRows] = useTable(tables.world);
  const [replayRows] = useTable(tables.replayState);
  const [members] = useTable(tables.member);
  // Demo start position and the "Next best" list. No real GPS in the demo: a default start near the
  // middle of the region, and the adjuster can tap the map to move it.
  const [locRows, locReady] = useTable(tables.adjusterLocation);
  const [facilities] = useTable(tables.facility);
  const [recRows] = useTable(tables.myRecommendations);
  const updateLocation = useReducer(reducers.updateMyLocation);
  const refreshRecs = useReducer(reducers.refreshRecommendations);
  const acceptRec = useReducer(reducers.acceptRecommendation);
  const world = worldRows[0];
  const sim = replayRows[0]?.simMinutes ?? 0;
  const fictional = world ? !world.region : false;
  const cellKey = useMemo(() => cellSetKey(cells), [cells]);
  const labeler = useMemo(() => makeLabeler(cells.map((c) => c.hex), fictional), [cellKey, fictional]); // eslint-disable-line react-hooks/exhaustive-deps
  const cellBy = useMemo(() => new Map(cells.map((c) => [c.hex, c])), [cells]);

  const active = useMemo(() => mine.filter((a) => a.status !== 'cancelled'), [mine]);
  const ids = useMemo(() => active.map((a) => a.householdId), [active]);
  const hexes = useMemo(() => active.map((a) => a.hex), [active]);
  const householdBy = useHouseholdsById(ids);
  const estimateBy = useEstimatesById(ids);
  const repliesBy = useRepliesFor(ids);
  const reportsBy = useReportsFor(ids);
  const followupBy = useFollowupsFor(ids);
  const sentBy = useSentFor(ids);
  const hexBy = useHexRows(hexes);

  const live = useLiveState(conn.isActive);
  const [route, setRoute] = useState<Route>({ name: 'tasks' });
  const routeRef = useRef(route);
  routeRef.current = route;
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const dismiss = useCallback((key: string) => setDismissed((s) => new Set(s).add(key)), []);

  // ---- Outbox ----
  const submit = useReducer(reducers.submitFieldReport);
  const updateAssignment = useReducer(reducers.updateAssignment);
  const closeHousehold = useReducer(reducers.closeHousehold);
  const myCount = useCallback((hid: string) => {
    if (!myId) return 0;
    return (reportsBy.get(hid) ?? []).filter((r) => r.ingestedBy.isEqual(myId)).length;
  }, [reportsBy, myId]);
  const [sentRecs, setSentRecs] = useState<Record<string, SentRecord>>({});
  const onSent = useCallback((r: SentRecord) => {
    setSentRecs((s) => ({ ...s, [r.opId]: r }));
    const cur = routeRef.current;
    if (cur.name === 'report' && cur.opId === r.opId) setRoute({ name: 'sent', opId: r.opId });
    else showToast(`Report for ${homeLabel(r.householdId)} sent`);
  }, [showToast]);
  const outbox = useOutbox({ submit, isActive: conn.isActive, myCount, onSent });

  // ---- Position: the demo start in adjuster_location (source 'demo'). Until one is saved, the default
  // start is the facility nearest the middle of the region (a staging point), else the middle itself.
  const regionCenter = useMemo<D.LatLng | null>(() => {
    if (!cells.length) return null;
    let la = 0;
    let ln = 0;
    for (const c of cells) {
      const [a, b] = cellToLatLng(c.hex);
      la += a;
      ln += b;
    }
    return [la / cells.length, ln / cells.length];
  }, [cellKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const staging = useMemo<D.LatLng | null>(() => {
    if (!regionCenter) return null;
    let best: D.LatLng | null = null;
    let bestD = Infinity;
    for (const f of facilities) {
      const d = D.milesBetween(regionCenter, [f.lat, f.lng]);
      if (d < bestD) { bestD = d; best = [f.lat, f.lng]; }
    }
    return best ?? regionCenter;
  }, [regionCenter, facilities]);
  const myLoc = myId ? locRows.find((r) => r.identity.isEqual(myId)) : undefined;
  const savedPos = useMemo<D.LatLng | null>(
    () => (myLoc && myLoc.source === 'demo' ? [myLoc.lat, myLoc.lng] : null),
    [myLoc?.lat, myLoc?.lng, myLoc?.source], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const mePos = savedPos ?? staging;
  const hasStart = !!mePos;
  const [moving, setMoving] = useState(false);
  const isDefaultStart = !!staging && (!savedPos || (savedPos[0] === staging[0] && savedPos[1] === staging[1]));
  // The card is the row with the lowest rank (rows of taken tasks disappear; the rest keep their ranks).
  const nextBest: NextBest | null = useMemo(() => {
    if (!recRows.length) return null;
    const r = [...recRows].sort((a, b) => a.rank - b.rank)[0];
    return { householdId: r.householdId, rank: r.rank, priority: r.priority, distanceKm: r.distanceKm, etaMin: r.etaMin, reason: r.reason };
  }, [recRows]);

  const setStart = useCallback(async (lat: number, lng: number) => {
    try {
      await updateLocation({ lat, lng, source: 'demo' });
      showToast('Start set');
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  }, [updateLocation, showToast]);
  const refreshNow = useCallback(async () => {
    try {
      await refreshRecs();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  }, [refreshRecs, showToast]);
  // After Accept: "Customer notified" for that household, shown once its assignment arrives. A task that is
  // no longer needed makes no assignment, so nothing shows and the card moves to the next row.
  const [acceptedId, setAcceptedId] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const acceptBest = useCallback(async () => {
    if (!nextBest || accepting) return;
    const hid = nextBest.householdId;
    setAccepting(true);
    try {
      await acceptRec({ householdId: hid });
      setAcceptedId(hid);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      setAccepting(false);
    }
  }, [acceptRec, nextBest, accepting, showToast]);
  const imessageBy = useImessageFor(acceptedId ? [...ids, acceptedId] : ids);

  // Rebuild "Next best" when the Tasks page opens (and after a reconnect). Never on a timer.
  const onTasks = route.name === 'tasks';
  const refreshRef = useRef(refreshRecs);
  refreshRef.current = refreshRecs;
  const hasStartRef = useRef(hasStart);
  hasStartRef.current = hasStart;
  useEffect(() => {
    if (onTasks && conn.isActive && hasStartRef.current) refreshRef.current().catch(() => undefined);
  }, [onTasks, conn.isActive]);
  // Save the default start once, so "Next best" can rank from it (update_my_location rebuilds the list).
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !conn.isActive || !locReady || myLoc || !staging) return;
    seeded.current = true;
    updateLocation({ lat: staging[0], lng: staging[1], source: 'demo' }).catch(() => undefined);
  }, [conn.isActive, locReady, myLoc, staging, updateLocation]);

  // ---- Tasks ----
  const unsentIds = useMemo(() => new Set(outbox.items.map((i) => i.householdId)), [outbox.items]);
  const { open, done } = useMemo(() => {
    const built: Task[] = active.map((a) => {
      const id = a.householdId;
      const est = estimateBy.get(id);
      const replies = repliesBy.get(id) ?? [];
      const reports = reportsBy.get(id) ?? [];
      const sent = sentBy.get(id) ?? [];
      const followup = followupBy.get(id);
      const type = D.taskType(est);
      const cell = cellBy.get(a.hex);
      return {
        a, id, hex: a.hex, open: a.status === 'assigned', number: 0, label: homeLabel(id),
        hh: householdBy.get(id), est, cell, hexRow: hexBy.get(a.hex), priority: prio(cell?.priority ?? 'P2'), type, job: D.jobFor(est, type),
        // Same cell label as the manager's dashboard ("District 90 · 7"), so a task maps to the area panel.
        district: labeler.cell(a.hex), miles: mePos ? D.milesBetween(mePos, D.cellCenter(a.hex)) : null,
        replies, reports, sent, followup, silent: D.silentHours(est, sim, replies, sent),
        banner: D.taskBanner({ a, replies, reports, followup, me: myId, type }), unsent: unsentIds.has(id),
        notice: imessageBy.get(id),
      };
    });
    const openT = built.filter((t) => t.open).sort((x, y) =>
      RANK[x.priority] - RANK[y.priority]
      || (y.est?.pNeedsHelp ?? 0) - (x.est?.pNeedsHelp ?? 0)
      || Number(x.a.createdAt.microsSinceUnixEpoch - y.a.createdAt.microsSinceUnixEpoch));
    openT.forEach((t, i) => { t.number = i + 1; });
    const doneT = built.filter((t) => !t.open).sort((x, y) => Number(y.a.updatedAt.microsSinceUnixEpoch - x.a.updatedAt.microsSinceUnixEpoch));
    return { open: openT, done: doneT };
  }, [active, estimateBy, repliesBy, reportsBy, sentBy, followupBy, cellBy, householdBy, hexBy, labeler, mePos, sim, myId, unsentIds, imessageBy]);
  const byId = useMemo(() => new Map([...open, ...done].map((t) => [t.id, t])), [open, done]);

  // ---- Messages tab: one thread per task; unread = a policyholder message after the last one I opened ----
  const chatBy = useChatFor(ids);
  const [chatSeen, setChatSeen] = useState<Record<string, string>>(loadChatSeen);
  const openChatId = route.name === 'chat' ? route.id : null;
  const openChatLast = openChatId ? chatBy.get(openChatId)?.at(-1)?.id : undefined;
  useEffect(() => {
    if (!openChatId || openChatLast == null) return;
    setChatSeen((cur) => {
      if (cur[openChatId] && BigInt(cur[openChatId]) >= openChatLast) return cur;
      const next = { ...cur, [openChatId]: String(openChatLast) };
      try { localStorage.setItem(CHAT_SEEN_KEY, JSON.stringify(next)); } catch { /* private mode: unread resets on reload */ }
      return next;
    });
  }, [openChatId, openChatLast]);
  const threads: Thread[] = useMemo(() => {
    const list = [...open, ...done].flatMap((t) => {
      const rows = chatBy.get(t.id) ?? [];
      if (!t.open && !rows.length) return [];
      const seenId = chatSeen[t.id] ? BigInt(chatSeen[t.id]) : -1n;
      const unread = rows.some((r) => r.sender === 'policyholder' && r.id > seenId);
      return [{ t, last: rows.at(-1), unread }];
    });
    return list.sort((x, y) => (x.last && y.last ? (y.last.id > x.last.id ? 1 : -1) : x.last ? -1 : y.last ? 1 : 0));
  }, [open, done, chatBy, chatSeen]);
  const unreadCount = threads.filter((x) => x.unread).length;

  // "New task assigned" (no address, no household details)
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const openIds = active.filter((a) => a.status === 'assigned').map((a) => String(a.id));
    if (seen.current === null) {
      if (mineReady) seen.current = new Set(openIds);
      return;
    }
    const fresh = openIds.filter((id) => !seen.current!.has(id));
    openIds.forEach((id) => seen.current!.add(id));
    if (fresh.length) showToast(fresh.length > 1 ? `${fresh.length} new tasks assigned` : 'New task assigned');
  }, [active, mineReady, showToast]);

  const bannerFor = (t: Task): D.Banner | null => {
    const b = t.banner;
    if (!b || dismissed.has(`${t.a.id}:${b.key}`)) return null;
    if (!t.open && b.kind !== 'closed') return null;
    if (b.kind === 'closed' && t.followup?.closedBy === meName) return null;
    return b;
  };
  const skipTask = async (t: Task) => {
    try {
      await updateAssignment({ id: t.a.id, status: 'cancelled' });
      showToast('Task skipped');
      if (routeRef.current.name !== 'tasks') setRoute({ name: 'tasks' });
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };

  // Another adjuster with my name (e.g. after an auto-rejoin): show the same short id the manager's picker shows.
  const myHex = myId?.toHexString() ?? '';
  const dupeName = members.some((m: MemberRow) => m.role === 'adjuster' && m.name === meName && m.identity.toHexString() !== myHex);
  const whoAmI = dupeName && myHex ? `${meName} · …${myHex.slice(-5)}` : meName;
  const badge = <LiveBadge state={live} unsent={outbox.items.length} />;
  const toastEl = toast && <div className="adj-toast" role="status">{toast}</div>;

  // ---- Routes ----
  if (route.name === 'chat') {
    const t = byId.get(route.id);
    if (!t) return <Fallback onBack={() => setRoute({ name: 'tasks' })} />;
    return (
      <div className="adj">
        <ChatScreen
          householdId={t.id} label={t.label} meName={meName} canSend={live === 'live'}
          live={<LiveBadge state={live} unsent={outbox.items.length} className="soft" />}
          onBack={() => setRoute(route.from === 'home' ? { name: 'home', id: t.id } : { name: route.from })}
        />
        {toastEl}
      </div>
    );
  }

  if (route.name === 'report') {
    const t = byId.get(route.id);
    if (!t) return <Fallback onBack={() => setRoute({ name: 'tasks' })} />;
    const prefill = route.prefillOp ? sentRecs[route.prefillOp]?.form : undefined;
    const target: ReportTarget = {
      householdId: t.id, hex: t.hex, assignmentId: String(t.a.id), label: t.label, type: t.type, job: t.job,
      policy: D.policyOf(t.hh), hazardType: world?.hazardType, hh: t.hh, cell: t.cell,
    };
    const item = route.opId ? outbox.items.find((i) => i.opId === route.opId) : undefined;
    return (
      <div className="adj">
        <ReportScreen
          key={`${t.id}:${route.mode}:${route.prefillOp ?? ''}`}
          target={target} mode={route.mode} prefill={prefill} item={item}
          live={<LiveBadge state={live} unsent={outbox.items.length} className="soft" />}
          onBack={() => setRoute({ name: 'home', id: t.id })}
          onSend={(d: Draft) => setRoute({ ...route, opId: outbox.send(d) })}
          onTryNow={() => { if (route.opId) void outbox.tryNow(route.opId); }}
          onEdit={() => { if (route.opId) outbox.remove(route.opId); setRoute({ ...route, opId: undefined }); }}
        />
        {toastEl}
      </div>
    );
  }

  if (route.name === 'sent') {
    const rec = sentRecs[route.opId];
    const t = rec ? byId.get(rec.householdId) : undefined;
    if (!rec || !t) return <Fallback onBack={() => setRoute({ name: 'tasks' })} />;
    const mineReports = t.reports.filter((r) => myId && r.ingestedBy.isEqual(myId));
    const reportT = mineReports.length ? Math.max(...mineReports.map((r) => r.t)) : sim;
    const n = open.find((x) => x.id !== t.id);
    const next: NextInfo | null = n ? {
      label: n.label, priority: n.priority, distance: n.miles != null ? D.fmtMiles(n.miles) : null,
      onOpen: () => setRoute({ name: 'home', id: n.id }),
    } : null;
    return (
      <div className="adj">
        <PhoneMap areas={[{ hex: t.hex, color: COLOR[t.priority], pill: 'dark', label: t.open ? String(t.number) : '✓' }]} fitKey={`sent:${t.id}`} padTop={80} padBottom={420} />
        <header className="adj-header adj-glass"><strong>{t.label}</strong>{badge}</header>
        <SentSheet
          rec={rec} cell={t.cell} followup={t.followup} reportT={reportT} next={next}
          nextOf={`${open.filter((x) => x.id !== t.id).length} left`}
          onUpdate={() => setRoute({ name: 'report', id: t.id, mode: 'update', prefillOp: rec.opId })}
          onCorrection={() => setRoute({ name: 'report', id: t.id, mode: 'correction', prefillOp: rec.opId })}
          onAllTasks={() => setRoute({ name: 'tasks' })}
          onLocateFailed={() => setRoute({ name: 'home', id: t.id, close: true })}
        />
        {toastEl}
      </div>
    );
  }

  if (route.name === 'goto') {
    const t = byId.get(route.id);
    if (!t) return <Fallback onBack={() => setRoute({ name: 'tasks' })} />;
    const center = D.cellCenter(t.hex);
    return (
      <div className="adj">
        <PhoneMap areas={[{ hex: t.hex, color: COLOR[t.priority], pill: 'dark', label: t.open ? String(t.number) : '✓' }]}
          me={mePos} route={mePos ? [mePos, center] : undefined} fitKey={`goto:${t.id}:${mePos ? 'me' : ''}`} padTop={90} padBottom={280} />
        <button type="button" className="adj-round adj-glass" style={{ left: 12, top: 'calc(12px + var(--top))' }} aria-label={`Back to ${t.label}`}
          onClick={() => setRoute({ name: 'home', id: t.id })}><Icon name="back" size={20} stroke={2.2} /></button>
        <span className="adj-chip-float adj-glass" style={{ right: 12, top: 'calc(12px + var(--top))' }}>
          <LiveBadge state={live} unsent={outbox.items.length} className="soft" />
        </span>
        <section className="adj-float-card adj-glass" aria-label="Distance">
          <div>
            <div className="adj-big">{t.miles != null ? D.fmtMiles(t.miles) : 'No start set'}</div>
            <span className="adj-sub">{t.miles != null ? `to the center of ${t.district} (${t.label})` : 'Set your start on the Tasks map'}</span>
          </div>
          <span className="adj-caption">Demo data: area, not an address</span>
          <button type="button" className="adj-btn dark block" onClick={() => setRoute({ name: 'home', id: t.id })}>Open home</button>
        </section>
        {toastEl}
      </div>
    );
  }

  if (route.name === 'home') {
    const t = byId.get(route.id);
    if (!t) return <Fallback onBack={() => setRoute({ name: 'tasks' })} />;
    const assignedBy = members.find((m: MemberRow) => m.identity.isEqual(t.a.assignedBy))?.name ?? 'manager';
    const ago = fmtAgo((Date.now() - t.a.createdAt.toDate().getTime()) / 60_000);
    const b = bannerFor(t);
    return (
      <div className="adj">
        <HomeView
          t={t} total={open.length} me={mePos} live={live} unsent={outbox.items.length} hazardType={world?.hazardType}
          subline={`${t.district} · from ${assignedBy}, ${ago}`} banner={b}
          onBack={() => setRoute({ name: 'tasks' })}
          onGo={() => setRoute({ name: 'goto', id: t.id })}
          onReport={() => setRoute({ name: 'report', id: t.id, mode: 'new' })}
          onMessage={() => setRoute({ name: 'chat', id: t.id, from: 'home' })}
          onClose={() => setRoute({ name: 'home', id: t.id, close: true })}
          onDismiss={() => b && dismiss(`${t.a.id}:${b.key}`)}
          onSkip={() => void skipTask(t)}
        />
        {route.close && (
          <CloseSheet
            canSkip={t.open}
            canUnreachable={t.reports.some((r) => r.safety === 'unsure')}
            onCancel={() => setRoute({ name: 'home', id: t.id })}
            onSkip={async () => {
              await updateAssignment({ id: t.a.id, status: 'cancelled' });
              showToast('Task skipped');
              setRoute({ name: 'tasks' });
            }}
            onCloseHome={async (reason, note) => {
              await closeHousehold({ householdId: t.id, reason, note });
              showToast(`${t.label} closed`);
              setRoute({ name: 'tasks' });
            }}
          />
        )}
        {toastEl}
      </div>
    );
  }

  const tab: Tab = route.name === 'messages' ? 'messages' : route.name === 'me' ? 'me' : 'tasks';
  const tabBar = <TabBar tab={tab} unread={unreadCount} onTab={(k) => { setMoving(false); setRoute({ name: k }); }} />;
  if (route.name === 'messages') {
    return (
      <div className="adj">
        <MessagesView threads={threads} meName={meName} badge={badge} onOpen={(id) => setRoute({ name: 'chat', id, from: 'messages' })} />
        {tabBar}
        {toastEl}
      </div>
    );
  }
  if (route.name === 'me') {
    return (
      <div className="adj">
        <ProfileView
          meName={whoAmI} region={initialLiveRegion().label} sim={sim} badge={badge} open={open.length} done={done.length}
          unsent={outbox.items.length} isDefaultStart={isDefaultStart} hasStart={hasStart}
          onMoveStart={() => { setMoving(true); setRoute({ name: 'tasks' }); }}
        />
        {tabBar}
        {toastEl}
      </div>
    );
  }

  const accepted = acceptedId ? byId.get(acceptedId) : undefined;
  return (
    <div className="adj has-tabs">
      <TasksView
        moving={moving} setMoving={setMoving}
        open={open} done={done} me={mePos} hasStart={hasStart} isDefaultStart={isDefaultStart} regionCenter={regionCenter} meName={whoAmI} sim={sim} badge={badge}
        nextBest={nextBest} accepting={accepting} onSetStart={setStart} onAccept={() => void acceptBest()} onRefresh={() => void refreshNow()}
        accepted={accepted} onDismissAccepted={() => setAcceptedId(null)}
        onMessage={(id) => setRoute({ name: 'chat', id, from: 'tasks' })}
        bannerFor={bannerFor} myId={myId}
        onOpen={(id) => setRoute({ name: 'home', id })}
        onGo={(id) => setRoute({ name: 'goto', id })}
        onDismiss={(t, b) => dismiss(`${t.a.id}:${b.key}`)}
        onSkip={(t) => void skipTask(t)}
      />
      {tabBar}
      {toastEl}
    </div>
  );
}

// ---- Tab bar (Tasks, Messages, Profile): floating Apple-style glass, on the three main screens only ----
const TAB_SPACE = 82; // tab bar height + its gap, kept clear on the Tasks map
const CHAT_SEEN_KEY = 'adj-chat-seen-v1';
function loadChatSeen(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(CHAT_SEEN_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
type Thread = { t: Task; last?: ChatRow; unread: boolean };

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'tasks', label: 'Tasks', icon: 'map' },
  { key: 'messages', label: 'Messages', icon: 'talk' },
  { key: 'me', label: 'Profile', icon: 'person' },
];
function TabBar({ tab, unread, onTab }: { tab: Tab; unread: number; onTab: (k: Tab) => void }) {
  return (
    <nav className="adj-tabbar" aria-label="Main">
      {TABS.map((x) => (
        <button key={x.key} type="button" className={`adj-tab${tab === x.key ? ' on' : ''}`} aria-current={tab === x.key ? 'page' : undefined} onClick={() => onTab(x.key)}>
          <span className="ico">
            <Icon name={x.icon} size={23} stroke={tab === x.key ? 2.2 : 1.8} />
            {x.key === 'messages' && unread > 0 && <span className="adj-badge" aria-label={`${unread} unread`}>{unread}</span>}
          </span>
          <span className="lbl">{x.label}</span>
        </button>
      ))}
    </nav>
  );
}

const fmtChatTime = (r: ChatRow) => {
  const d = r.createdAt.toDate();
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
function MessagesView({ threads, meName, badge, onOpen }: { threads: Thread[]; meName: string; badge: React.ReactNode; onOpen: (id: string) => void }) {
  return (
    <div className="adj-tabpage">
      <header className="adj-tabhead"><h1>Messages</h1>{badge}</header>
      {threads.length === 0 ? (
        <div className="adj-group adj-empty">No tasks yet. Each task gets a thread with its policyholder.</div>
      ) : (
        <div className="adj-group">
          {threads.map(({ t, last, unread }) => {
            const who = !last ? '' : last.sender === 'policyholder' ? '' : last.sender === 'system' ? 'Automated: '
              : last.senderName === meName ? 'You: ' : `${last.senderName || 'Adjuster'}: `;
            return (
              <button key={t.id} type="button" className={`adj-row adj-throw${unread ? ' unread' : ''}`} onClick={() => onOpen(t.id)}>
                <span className="adj-avatar"><Icon name="house" size={19} stroke={1.9} /></span>
                <span className="adj-throw-main">
                  <span className="adj-throw-top">
                    <b>{t.label}</b>
                    <span className="time">{last ? fmtChatTime(last) : t.open ? `Task ${t.number}` : 'Done'}</span>
                  </span>
                  <span className="adj-throw-prev">{last ? `${who}${last.text}` : 'No messages yet'}</span>
                </span>
                {unread ? <i className="adj-dot" aria-label="Unread" /> : <Icon name="chevron" size={16} stroke={2} />}
              </button>
            );
          })}
        </div>
      )}
      <p className="adj-muted adj-tabnote">Messages go to the policyholder's check-in page. No arrival times or payment promises.</p>
    </div>
  );
}

function ProfileView({ meName, region, sim, badge, open, done, unsent, isDefaultStart, hasStart, onMoveStart }: {
  meName: string; region: string; sim: number; badge: React.ReactNode; open: number; done: number; unsent: number;
  isDefaultStart: boolean; hasStart: boolean; onMoveStart: () => void;
}) {
  const initials = meName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
  return (
    <div className="adj-tabpage">
      <header className="adj-tabhead"><h1>Profile</h1>{badge}</header>
      <div className="adj-group">
        <div className="adj-me">
          <span className="adj-initials" aria-hidden="true">{initials}</span>
          <span className="adj-me-main"><b>{meName}</b><span className="adj-muted">Field adjuster · {region}</span></span>
        </div>
      </div>
      <div className="adj-group">
        <div className="adj-row"><span className="grow">Open tasks</span><span className="tail">{open}</span></div>
        <div className="adj-row"><span className="grow">Done</span><span className="tail">{done}</span></div>
        <div className="adj-row">
          <span className="grow">Unsent reports</span>
          {unsent > 0 ? <span className="adj-tag amber">{unsent} waiting</span> : <span className="tail">None</span>}
        </div>
        <div className="adj-row"><span className="grow">Exercise time</span><span className="tail">{fmtT(sim)}</span></div>
      </div>
      <div className="adj-group">
        <button type="button" className="adj-row" onClick={onMoveStart}>
          <span className="grow stack"><span>Start position</span><span className="adj-muted">{!hasStart ? 'Not set' : isDefaultStart ? 'Default start' : 'Set on the map'}</span></span>
          <span className="adj-link small">Move start</span>
        </button>
      </div>
      <p className="adj-muted adj-tabnote">Demo data: synthetic households, areas not addresses. No real calls, texts or GPS.</p>
    </div>
  );
}

function Fallback({ onBack }: { onBack: () => void }) {
  return (
    <div className="adj">
      <div className="adj-join">
        <span className="adj-muted">This task is no longer assigned to you.</span>
        <button type="button" className="adj-btn dark" onClick={onBack}>Back to tasks</button>
      </div>
    </div>
  );
}

// ---- Shared bits ----
function BannerStrip({ b, onOpen, onDismiss, onSkip, glass }: {
  b: D.Banner; onOpen?: () => void; onDismiss: () => void; onSkip?: () => void; glass?: boolean;
}) {
  return (
    <div className={`adj-banner${b.kind === 'help' ? ' help' : ''}${glass ? ' float' : ''}`} role="status">
      <span className="txt"><b>{b.title}</b>{b.detail && <span>{b.detail}</span>}</span>
      {b.kind === 'help' && (onOpen
        ? <button type="button" className="adj-btn dark small" onClick={onOpen}>Open home</button>
        : <button type="button" className="adj-btn dark small" onClick={onDismiss}>OK</button>)}
      {(b.kind === 'visited' || b.kind === 'safe') && (
        <>
          <button type="button" className="adj-btn dark small" onClick={onDismiss}>Still go</button>
          {onSkip && <button type="button" className="adj-link small" onClick={onSkip}>Skip</button>}
        </>
      )}
      {b.kind === 'closed' && <button type="button" className="adj-btn dark small" onClick={onDismiss}>OK</button>}
    </div>
  );
}

function doneTag(t: Task): { text: string; tone: '' | 'red' | 'amber' } {
  const f = t.followup;
  const s = t.est?.escalation ?? '';
  if (f?.closureReason) return { text: `Closed: ${D.CLOSURE_LABEL[f.closureReason] ?? f.closureReason}`, tone: '' };
  if (f?.memberMissing && f.referralStatus !== 'resolved') return { text: 'Someone missing', tone: 'amber' };
  if (s === 'emergency_referral' || s.startsWith('referral_')) return { text: 'Referral open', tone: 'red' };
  if (s === 'locate') return { text: 'Locate pending', tone: '' };
  return { text: t.est?.accounted ? 'Everyone safe' : 'Reported', tone: '' };
}

function TaskCard({ t, myId, banner, onOpen, onDismiss, onSkip }: {
  t: Task; myId?: Parameters<typeof D.taskBanner>[0]['me']; banner: D.Banner | null;
  onOpen: () => void; onDismiss: () => void; onSkip: () => void;
}) {
  const needs = D.listNeeds(t.hh);
  const sub = t.open ? [t.job !== 'Visit' ? D.JOB_LABEL[t.job] : null, ...needs].filter(Boolean).join(' · ') || t.district : null;
  const tag = t.open ? null : doneTag(t);
  const mine = t.reports.filter((r) => myId && r.ingestedBy.isEqual(myId));
  const reportedAt = mine.length ? Math.max(...mine.map((r) => r.t)) : null;
  return (
    <div className={`adj-taskcard${t.open ? '' : ' done'}`}>
      <button type="button" className="adj-task" onClick={onOpen}>
        <span className={`adj-num${t.open ? '' : ' done'}`}>{t.open ? t.number : <Icon name="check" size={13} stroke={3} />}</span>
        {t.open && <span className={`adj-p ${t.priority}`}>{t.priority}</span>}
        <span className="adj-task-main">
          <b style={t.open ? undefined : { color: 'var(--t2)' }}>{t.label}</b>
          {sub && <span>{sub}</span>}
          {tag && <span className={`adj-tag ${tag.tone}`}>{tag.text}</span>}
        </span>
        <span className="adj-task-side">
          {t.unsent && <span className="adj-tag amber">Unsent</span>}
          {t.open ? (t.miles != null ? D.fmtMiles(t.miles) : null) : reportedAt != null ? fmtT(reportedAt) : null}
        </span>
      </button>
      {banner && <BannerStrip b={banner} onOpen={onOpen} onDismiss={onDismiss} onSkip={t.open ? onSkip : undefined} />}
    </div>
  );
}

// ---- Screen 1: Tasks ----
function TasksView({ moving, setMoving, open, done, me, hasStart, isDefaultStart, regionCenter, meName, sim, badge, bannerFor, myId, nextBest, accepting, onSetStart, onAccept, onRefresh, accepted, onDismissAccepted, onMessage, onOpen, onGo, onDismiss, onSkip }: {
  moving: boolean; setMoving: (on: boolean) => void;
  open: Task[]; done: Task[]; me: D.LatLng | null; hasStart: boolean; isDefaultStart: boolean; regionCenter: D.LatLng | null; meName: string; sim: number; badge: React.ReactNode;
  bannerFor: (t: Task) => D.Banner | null; myId?: Parameters<typeof D.taskBanner>[0]['me'];
  nextBest: NextBest | null; accepting: boolean; onSetStart: (lat: number, lng: number) => void; onAccept: () => void; onRefresh: () => void;
  accepted?: Task; onDismissAccepted: () => void; onMessage: (id: string) => void;
  onOpen: (id: string) => void; onGo: (id: string) => void; onDismiss: (t: Task, b: D.Banner) => void; onSkip: (t: Task) => void;
}) {
  // Sheet: 'peek' = one line so the map shows, 'next' = Next best + Next up, 'all' = the whole list.
  const [sheet, setSheet] = useState<'peek' | 'next' | 'all'>('next');
  const expanded = sheet === 'all';
  const up = () => setSheet((s) => (s === 'peek' ? 'next' : 'all'));
  const down = () => setSheet((s) => (s === 'all' ? 'next' : 'peek'));
  const [whyOpen, setWhyOpen] = useState(false);
  // Picking a start: only before the region has loaded (no default yet), or after "Move start".
  const picking = !hasStart || moving;
  const showBest = hasStart && !!nextBest;
  const drag = useRef<{ y: number; moved: boolean } | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const all = useMemo(() => [...open, ...done], [open, done]);
  // The card shows the task picked on the map, else the next one up.
  const next = (selId ? all.find((t) => t.id === selId) : undefined) ?? open[0];
  const isNextUp = !!next && next === open[0];

  const areas: MapArea[] = useMemo(() => [
    ...done.map((t) => ({ hex: t.hex, color: '#9a9a9a', pill: 'done' as const })),
    ...open.map((t) => ({ hex: t.hex, color: COLOR[t.priority], pill: (t === next ? 'dark' : 'light') as 'dark' | 'light', label: String(t.number) })),
  ], [open, done, next]);
  const route = useMemo(() => (me && open.length ? [me, ...open.map((t) => D.cellCenter(t.hex))] : undefined), [me, open]);
  // Refit when the sheet drops to (or rises from) peek, so the areas fill the freed map.
  const fitKey = `tasks:${all.map((t) => t.id).join(',')}:${me ? 'me' : ''}:${sheet === 'peek' ? 'peek' : 'open'}`;
  const nb = next ? bannerFor(next) : null;
  const rest = all.filter((t) => t !== next);
  // Tap an area: select its task (tap again to cycle when one area holds several homes).
  const pickArea = (hex: string) => {
    const here = all.filter((t) => t.hex === hex);
    if (!here.length) return;
    const i = next ? here.indexOf(next) : -1;
    setSelId(here[(i + 1) % here.length].id);
  };

  return (
    <>
      <PhoneMap
        areas={areas} me={me} route={route} fitKey={fitKey} padTop={150}
        padBottom={sheet === 'peek' ? TAB_SPACE + 90 : TAB_SPACE + (expanded ? 520 : 330) + (showBest ? (whyOpen ? 190 : 120) : 0) + (accepted ? 170 : 0)}
        fallbackCenter={regionCenter}
        onAreaClick={picking ? undefined : pickArea}
        onMapClick={picking ? ([lat, lng]) => { onSetStart(lat, lng); setMoving(false); } : undefined}
      />
      <header className="adj-header adj-glass">
        <div>
          <strong>Field tasks</strong>
          <span className="sub">{meName} · {fmtT(sim)}</span>
        </div>
        {badge}
      </header>
      {picking ? (
        <div className="adj-pick" role="status">
          <span>Tap the map to set your start</span>
          {hasStart && <button type="button" className="adj-link small" onClick={() => setMoving(false)}>Cancel</button>}
        </div>
      ) : (
        <span className="adj-demo adj-glass">
          Demo data: areas, not addresses{isDefaultStart ? ' · default start' : ''} · <button type="button" className="adj-link small" onClick={() => setMoving(true)}>Move start</button>
        </span>
      )}

      <section className={`adj-sheet adj-glass${sheet === 'peek' ? ' peek' : ''}`} aria-label="Tasks">
        <button
          type="button" className="adj-handle" aria-expanded={sheet !== 'peek'}
          aria-label={sheet === 'peek' ? 'Show tasks' : expanded ? 'Show next up only' : 'Show all tasks'}
          onPointerDown={(e) => { drag.current = { y: e.clientY, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dy = e.clientY - d.y;
            // One step per swipe: up peek → next → all, down all → next → peek.
            if (d.moved) return;
            if (dy < -24) { up(); d.moved = true; }
            else if (dy > 24) { down(); d.moved = true; }
          }}
          onPointerUp={() => { const d = drag.current; drag.current = null; if (d && !d.moved) setSheet((s) => (s === 'next' ? 'all' : 'next')); }}
          onClick={(e) => { if (e.detail === 0) setSheet((s) => (s === 'next' ? 'all' : 'next')); }}
        ><span /></button>

        {sheet === 'peek' && (
          <button type="button" className="adj-peekline" onClick={() => setSheet('next')}>
            <b>{open.length ? `${open.length} open task${open.length > 1 ? 's' : ''}` : 'No open tasks'}</b>
            {next && <span>{isNextUp ? 'Next up · ' : ''}{next.label}{next.district ? ` · ${next.district}` : ''}</span>}
          </button>
        )}

        {accepted && (
          <NotifiedCard
            label={accepted.label} imessage={accepted.notice} onDismiss={onDismissAccepted}
            onMessage={() => onMessage(accepted.id)} onOpen={() => onOpen(accepted.id)}
          />
        )}

        {showBest && nextBest && (
          <article className="adj-card adj-best" aria-label="Next best">
            <div className="adj-best-row">
              <span className={`adj-p ${prio(nextBest.priority)}`}>{prio(nextBest.priority)}</span>
              <span className="adj-best-main">
                <b>Next best · {recMiles(nextBest.distanceKm)}</b>
                <span>{nextBest.reason}</span>
              </span>
              <button type="button" className="adj-iconbtn t44" aria-label="Refresh suggestions" onClick={onRefresh}><Icon name="refresh" size={18} stroke={2} /></button>
              <button type="button" className="adj-btn dark small t44" disabled={accepting} onClick={onAccept}>Accept</button>
            </div>
            <button type="button" className="adj-why-toggle" aria-expanded={whyOpen} aria-controls="adj-why" onClick={() => setWhyOpen((x) => !x)}>
              <Icon name="down" size={16} stroke={2.2} />Why this task
            </button>
            {whyOpen && (
              <ul id="adj-why" className="adj-why">
                <li>{prio(nextBest.priority)} area · {nextBest.reason}</li>
                <li>{recMiles(nextBest.distanceKm)} · {Math.round(nextBest.etaMin)} min drive</li>
                <li className="adj-why-note">Ranked by priority, then value per minute. Rules, not AI.</li>
              </ul>
            )}
          </article>
        )}

        {next ? (
          <>
            <div className="adj-rowhead">
              <h2>{isNextUp ? 'Next up' : next.open ? `Task ${next.number}` : 'Done'}</h2>
              {isNextUp
                ? <span className="adj-muted">1 of {open.length}</span>
                : open.length > 0 && <button type="button" className="adj-link small" onClick={() => setSelId(null)}>Back to next up</button>}
            </div>
            <article className="adj-card" style={{ overflow: 'hidden' }}>
              <div className="adj-next">
                <div className="adj-badges">
                  <span className={`adj-p ${next.priority}`}>{next.priority}</span>
                  <span className="adj-pill">{D.JOB_LABEL[next.job]}</span>
                  {next.silent != null && <span className="adj-pill fill">Silent {next.silent} h</span>}
                  {!next.open && <span className={`adj-tag ${doneTag(next).tone}`}>{doneTag(next).text}</span>}
                  {next.unsent && <span className="adj-tag amber">Unsent</span>}
                </div>
                <strong className="adj-title">{next.label}</strong>
                <span className="adj-sub">
                  {[next.district, next.miles != null ? D.fmtMiles(next.miles) : null, `Help: ${D.helpLevel(next.est?.pNeedsHelp ?? 0)}`].filter(Boolean).join(' · ')}
                </span>
                {D.listNeeds(next.hh).length > 0 && (
                  <div className="adj-needs">
                    {D.listNeeds(next.hh).map((n) => <span key={n} className="adj-need"><Icon name={needIcon(n)} size={14} stroke={2} />{n}</span>)}
                  </div>
                )}
                <div className="adj-actions">
                  <button type="button" className="adj-btn outline" onClick={() => onGo(next.id)}><Icon name="nav" size={16} stroke={2} />Go to area</button>
                  <button type="button" className="adj-btn outline adj-msgbtn" aria-label="Message" title="Message" onClick={() => onMessage(next.id)}><Icon name="talk" size={18} stroke={2} /></button>
                  <button type="button" className="adj-btn dark grow" onClick={() => onOpen(next.id)}>Open home</button>
                </div>
              </div>
              {nb && <BannerStrip b={nb} onOpen={() => onOpen(next.id)} onDismiss={() => onDismiss(next, nb)} onSkip={() => onSkip(next)} />}
            </article>
          </>
        ) : (
          <div className="adj-card adj-empty">{done.length ? 'All tasks done.' : 'No tasks yet. New tasks appear here automatically.'}</div>
        )}

        {rest.length > 0 && (
          // Always rendered so opening and closing animate; inert while closed so it can't be tabbed into.
          <div className={`adj-more${expanded ? ' open' : ''}`} inert={!expanded}>
            <div className="adj-more-inner">
              <div className="adj-list">
                {rest.map((t) => {
                  const b = bannerFor(t);
                  return <TaskCard key={t.id} t={t} myId={myId} banner={b} onOpen={() => onOpen(t.id)} onDismiss={() => b && onDismiss(t, b)} onSkip={() => onSkip(t)} />;
                })}
              </div>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

// ---- Screen 2: Home ----
function HomeView({ t, total, me, live, unsent, hazardType, subline, banner, onBack, onGo, onReport, onMessage, onClose, onDismiss, onSkip }: {
  t: Task; total: number; me: D.LatLng | null; live: LiveState; unsent: number; hazardType?: string; subline: string; banner: D.Banner | null;
  onBack: () => void; onGo: () => void; onReport: () => void; onMessage: () => void; onClose: () => void; onDismiss: () => void; onSkip: () => void;
}) {
  const [callTried, setCallTried] = useState(false);
  const why = D.whyText({ hazardType, hex: t.hexRow, cell: t.cell, hh: t.hh, replies: t.replies, silent: t.silent, type: t.type });
  const home = D.homeStatus(t.est);
  const needs = t.hh ? D.homeNeeds(t.hh) : [];
  const center = D.cellCenter(t.hex);
  const policy = D.policyOf(t.hh);
  const quake = D.isQuake(hazardType);
  const coverage = t.hh && t.type === 'Property inspection'
    ? (quake
      ? [D.POLICY_LABEL[policy], `${t.hh.earthquakeEndorsement ? '✓' : '✗'} Earthquake`, `${t.hh.windCovered ? '✓' : '✗'} Wind`]
      : [D.POLICY_LABEL[policy], `${t.hh.windCovered ? '✓' : '✗'} Wind`, `${t.hh.floodPolicy ? '✓' : '✗'} Flood policy`])
    : null;

  return (
    <>
      <PhoneMap className="adj-hero" areas={[{ hex: t.hex, color: COLOR[t.priority], pill: 'dark', label: t.open ? String(t.number) : '✓' }]}
        me={me} route={me ? [me, center] : undefined} fitKey={`home:${t.id}`} padTop={70} padBottom={70} />
      <button type="button" className="adj-round adj-glass" style={{ left: 12, top: 'calc(12px + var(--top))' }} aria-label="Back to tasks" onClick={onBack}>
        <Icon name="back" size={20} stroke={2.2} />
      </button>
      <span className="adj-chip-float adj-glass" style={{ right: 12, top: 'calc(12px + var(--top))' }}>
        {t.open ? `${t.number} of ${total}` : 'Done'}
        <LiveBadge state={live} unsent={unsent} className="soft" />
      </span>
      <span className="adj-hero-demo adj-glass">Demo data: area, not an address</span>
      <button type="button" className="adj-go adj-glass" onClick={onGo}>
        <Icon name="nav" size={16} stroke={2} />Go to area{t.miles != null ? ` · ${D.fmtMiles(t.miles)}` : ''}
      </button>

      <main className="adj-panel">
        {banner && <BannerStrip b={banner} onDismiss={onDismiss} onSkip={t.open ? onSkip : undefined} glass />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="adj-badges">
            <span className={`adj-p ${t.priority}`}>{t.priority}</span>
            <span className="adj-pill">{D.JOB_LABEL[t.job]}</span>
            {t.silent != null && <span className="adj-pill fill">Silent {t.silent} h</span>}
          </div>
          <div>
            <h1 className="adj-title">{t.label}</h1>
            <span className="adj-sub">{subline}</span>
          </div>
        </div>

        <div className="adj-highlight">
          <Icon name={D.isRemote(t.job) ? 'phone' : t.type === 'Welfare check' ? 'bell' : 'search'} size={24} />
          <span><b>{D.isRemote(t.job) ? D.JOB_TITLE[t.job] : why.title}</b><span>{why.body}</span></span>
        </div>

        <div className="adj-rows">
          {t.hh?.phoneOnFile !== false ? (
            <>
              <div className="adj-irow">
                <Icon name="phone" />
                <span className="grow">Phone on file</span>
                <button type="button" className="adj-btn outline small t44" onClick={() => setCallTried(true)}>Call</button>
              </div>
              {callTried && <span className="adj-toastline" role="status">Demo household: no real number</span>}
            </>
          ) : (
            <div className="adj-irow"><Icon name="phone" /><span className="grow">No phone on file · try emergency contact</span></div>
          )}
          <div className="adj-irow">
            <Icon name="talk" />
            <span className="grow">Messages</span>
            <button type="button" className="adj-btn outline small t44" onClick={onMessage}>Message</button>
          </div>
          {t.notice && (
            <div className="adj-irow">
              <Icon name="check" />
              <span className="grow stack"><b>Customer notified</b><NotifiedChips imessage={t.notice} /></span>
            </div>
          )}
          <div className="adj-irow">
            <Icon name="person" />
            <span className="grow"><b>{D.peopleStatus(t.est, t.followup)}</b><span className="tail"> · {D.contactLine(t.replies, t.sent)}</span></span>
          </div>
          <div className="adj-irow">
            <Icon name="house" />
            <span className="grow"><b>{home.head}</b>{home.tail && <span className="tail"> · {home.tail}</span>}</span>
          </div>
          {coverage && (
            <div className="adj-irow">
              <Icon name="shield" />
              <span className="grow tail" style={{ color: 'var(--t)' }}>{coverage.join(' · ')}</span>
            </div>
          )}
        </div>

        {needs.length > 0 && (
          <div className="adj-needs">
            {needs.map((n) => <span key={n} className="adj-need"><Icon name={needIcon(n)} size={14} stroke={2} />{n}</span>)}
          </div>
        )}
      </main>

      <footer className="adj-footer">
        <button type="button" className="adj-link" onClick={onClose}>Can't make contact?</button>
        <button type="button" className="adj-btn dark" style={{ height: 50, padding: '0 22px', fontSize: 16 }} onClick={onReport}>{D.isRemote(t.job) ? 'Report result' : 'Start field report'}</button>
      </footer>
    </>
  );
}
