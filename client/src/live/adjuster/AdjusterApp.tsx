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
import { useFollowupsFor, useHexRows, useRepliesFor, useReportsFor, useSentFor } from './data';
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
  district: string;
  miles: number | null;
  replies: SmsReplyRow[];
  reports: FieldReportRow[];
  sent: D.SmsSentRow[];
  followup?: HouseholdFollowupRow;
  silent: number | null;
  banner: D.Banner | null;
  unsent: boolean;
}

type Route =
  | { name: 'tasks' }
  | { name: 'home'; id: string; close?: boolean }
  | { name: 'goto'; id: string }
  | { name: 'report'; id: string; mode: ReportMode; prefillOp?: string; opId?: string }
  | { name: 'sent'; opId: string };

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

function useGeolocation(): D.LatLng | null {
  const [pos, setPos] = useState<D.LatLng | null>(null);
  useEffect(() => {
    if (!('geolocation' in navigator)) return;
    const id = navigator.geolocation.watchPosition(
      (p) => setPos([p.coords.latitude, p.coords.longitude]),
      () => setPos(null), // denied or unavailable: no error on screen
      { enableHighAccuracy: false, maximumAge: 30_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);
  return pos;
}

function Field({ meName }: { meName: string }) {
  const conn = useSpacetimeDB();
  const myId = conn.identity;
  const [mine, mineReady] = useTable(tables.myAssignments);
  const [cells] = useTable(tables.hexStats);
  const [worldRows] = useTable(tables.world);
  const [replayRows] = useTable(tables.replayState);
  const [facilities] = useTable(tables.facility);
  const [members] = useTable(tables.member);
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

  // ---- Position: real GPS when it is inside the disaster region, else a simulated staging point ----
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
  const gps = useGeolocation();
  const gpsInRegion = !!(gps && regionCenter && D.milesBetween(gps, regionCenter) < 60);
  const mePos: D.LatLng | null = gpsInRegion ? gps : staging;
  const simulated = !gpsInRegion && !!staging;

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
        hh: householdBy.get(id), est, cell, hexRow: hexBy.get(a.hex), priority: prio(cell?.priority ?? 'P2'), type,
        district: labeler.district(a.hex), miles: mePos ? D.milesBetween(mePos, D.cellCenter(a.hex)) : null,
        replies, reports, sent, followup, silent: D.silentHours(est, sim, replies, sent),
        banner: D.taskBanner({ a, replies, reports, followup, me: myId, type }), unsent: unsentIds.has(id),
      };
    });
    const openT = built.filter((t) => t.open).sort((x, y) =>
      RANK[x.priority] - RANK[y.priority]
      || (y.est?.pNeedsHelp ?? 0) - (x.est?.pNeedsHelp ?? 0)
      || Number(x.a.createdAt.microsSinceUnixEpoch - y.a.createdAt.microsSinceUnixEpoch));
    openT.forEach((t, i) => { t.number = i + 1; });
    const doneT = built.filter((t) => !t.open).sort((x, y) => Number(y.a.updatedAt.microsSinceUnixEpoch - x.a.updatedAt.microsSinceUnixEpoch));
    return { open: openT, done: doneT };
  }, [active, estimateBy, repliesBy, reportsBy, sentBy, followupBy, cellBy, householdBy, hexBy, labeler, mePos, sim, myId, unsentIds]);
  const byId = useMemo(() => new Map([...open, ...done].map((t) => [t.id, t])), [open, done]);

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
  if (route.name === 'report') {
    const t = byId.get(route.id);
    if (!t) return <Fallback onBack={() => setRoute({ name: 'tasks' })} />;
    const prefill = route.prefillOp ? sentRecs[route.prefillOp]?.form : undefined;
    const target: ReportTarget = {
      householdId: t.id, hex: t.hex, assignmentId: String(t.a.id), label: t.label, type: t.type,
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
            <div className="adj-big">{t.miles != null ? D.fmtMiles(t.miles) : 'Location off'}</div>
            <span className="adj-sub">to the center of {t.district} · {t.label}</span>
          </div>
          <span className="adj-caption">Demo data: area, not an address{simulated ? ' · simulated position' : ''}</span>
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

  return (
    <div className="adj">
      <TasksView
        open={open} done={done} me={mePos} simulated={simulated} meName={whoAmI} sim={sim} badge={badge}
        bannerFor={bannerFor} myId={myId}
        onOpen={(id) => setRoute({ name: 'home', id })}
        onGo={(id) => setRoute({ name: 'goto', id })}
        onDismiss={(t, b) => dismiss(`${t.a.id}:${b.key}`)}
        onSkip={(t) => void skipTask(t)}
      />
      {toastEl}
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
  const sub = t.open ? [t.type === 'Property inspection' ? 'Property inspection' : null, ...needs].filter(Boolean).join(' · ') || t.district : null;
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
function TasksView({ open, done, me, simulated, meName, sim, badge, bannerFor, myId, onOpen, onGo, onDismiss, onSkip }: {
  open: Task[]; done: Task[]; me: D.LatLng | null; simulated: boolean; meName: string; sim: number; badge: React.ReactNode;
  bannerFor: (t: Task) => D.Banner | null; myId?: Parameters<typeof D.taskBanner>[0]['me'];
  onOpen: (id: string) => void; onGo: (id: string) => void; onDismiss: (t: Task, b: D.Banner) => void; onSkip: (t: Task) => void;
}) {
  const [expanded, setExpanded] = useState(false);
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
  const fitKey = `tasks:${all.map((t) => t.id).join(',')}:${me ? 'me' : ''}`;
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
      <PhoneMap areas={areas} me={me} route={route} fitKey={fitKey} padTop={150} padBottom={expanded ? 520 : 330} onAreaClick={pickArea} />
      <header className="adj-header adj-glass">
        <div>
          <strong>Field tasks</strong>
          <span className="sub">{meName} · {fmtT(sim)}</span>
        </div>
        {badge}
      </header>
      <span className="adj-demo adj-glass">Demo data: areas, not addresses{simulated ? ' · simulated position' : ''}</span>

      <section className="adj-sheet adj-glass" aria-label="Tasks">
        <button
          type="button" className="adj-handle" aria-expanded={expanded} aria-label={expanded ? 'Show next up only' : 'Show all tasks'}
          onPointerDown={(e) => { drag.current = { y: e.clientY, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dy = e.clientY - d.y;
            if (dy < -24) { setExpanded(true); d.moved = true; }
            else if (dy > 24) { setExpanded(false); d.moved = true; }
          }}
          onPointerUp={() => { const d = drag.current; drag.current = null; if (d && !d.moved) setExpanded((x) => !x); }}
          onClick={(e) => { if (e.detail === 0) setExpanded((x) => !x); }}
        ><span /></button>

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
                  <span className="adj-pill">{next.type}</span>
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
function HomeView({ t, total, me, live, unsent, hazardType, subline, banner, onBack, onGo, onReport, onClose, onDismiss, onSkip }: {
  t: Task; total: number; me: D.LatLng | null; live: LiveState; unsent: number; hazardType?: string; subline: string; banner: D.Banner | null;
  onBack: () => void; onGo: () => void; onReport: () => void; onClose: () => void; onDismiss: () => void; onSkip: () => void;
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
            <span className="adj-pill">{t.type}</span>
            {t.silent != null && <span className="adj-pill fill">Silent {t.silent} h</span>}
          </div>
          <div>
            <h1 className="adj-title">{t.label}</h1>
            <span className="adj-sub">{subline}</span>
          </div>
        </div>

        <div className="adj-highlight">
          <Icon name={t.type === 'Welfare check' ? 'bell' : 'search'} size={24} />
          <span><b>{why.title}</b><span>{why.body}</span></span>
        </div>

        <div className="adj-rows">
          {t.hh?.phoneOnFile !== false ? (
            <>
              <div className="adj-irow">
                <Icon name="phone" />
                <span className="grow">Phone on file</span>
                <button type="button" className="adj-btn outline small" onClick={() => setCallTried(true)}>Call</button>
              </div>
              {callTried && <span className="adj-toastline" role="status">Demo household: no real number</span>}
            </>
          ) : (
            <div className="adj-irow"><Icon name="phone" /><span className="grow">No phone on file · try emergency contact</span></div>
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
        <button type="button" className="adj-btn dark" style={{ height: 50, padding: '0 22px', fontSize: 16 }} onClick={onReport}>Start field report</button>
      </footer>
    </>
  );
}
