import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings/index.ts';
import { ConnectionBadge, LiveProvider } from './LiveProvider';
import { REGIONS, initialRegion, rememberRegion, type RegionConfig } from './config';
import { LiveMap, type FitTarget } from './LiveMap';
import { hasCone, parseHazard } from './hazard';
import { JoinDialog, rememberedName, useAutoRejoin } from './JoinDialog';
import { ReplayBar } from './ReplayBar';
import { QrButton } from './LiveQrCard';
import { useEstimatesById, useHouseholdsById, useHouseholdsInCell } from './hooks';
import { SnapshotManager } from './SnapshotManager';
import { makeLabeler } from './labels';
import { cellToLatLng } from 'h3-js';
import { COLOR, RANK, cellSetKey, prio, severeRange, unitsFor, type MapMode, type MapUnit, type Priority } from './mapModel';
import './cell-detail.css';
import './live-toast.css';
import './topbar.css';
import { AccountingCard, makeKidsNote } from './accounting';
import { OutreachPanel, type FeedItem } from './OutreachPanel';
import type { HexStatsRow, HouseholdRow, MetricsRow, SmsReplyRow } from './rows';
import { HouseholdPanel, reportDamage } from './household';
import { SevereCard } from './SevereCard';
import { DecisionTrace, useReplyCellCapture } from './DecisionTrace';
import { homeLabel, pct } from '../format';
import { CELL_STATUS_LABEL, cellStatus } from '../cellStatus';

export function ManagerLive() {
  const [region, setRegion] = useState<RegionConfig>(initialRegion);
  const onRegion = (r: RegionConfig) => {
    rememberRegion(r.id);
    setRegion(r);
  };
  if (!region.db) return <SnapshotManager key={region.id} region={region} onRegion={onRegion} />;
  return (
    <LiveProvider key={region.db} screen="manager" db={region.db}>
      <ManagerScreen region={region} onRegion={onRegion} />
    </LiveProvider>
  );
}

// Shared top bar: product label, current scenario (world.name, which changes when a new disaster is
// loaded), right-hand slot, then the region switcher pinned to the right edge (topbar.css) so it
// stays put when the scenario name changes length.
export function RegionHeader({ region, onRegion, scenario, children }: {
  region: RegionConfig; onRegion: (r: RegionConfig) => void; scenario?: string; children?: ReactNode;
}) {
  return (
    <header className="topbar region-bar">
      <div className="brand stacked">
        <div className="brand-line">
          <strong>Saviu</strong>
          {scenario && <span className="scenario" title={scenario}>{scenario}</span>}
        </div>
      </div>
      <div className="topbar-right">{children}</div>
      <div className="segmented" role="group" aria-label="Region">
        {/* Dev regions (Harbor Bend) stay off the switcher; shown only while one is open via ?region=. */}
        {REGIONS.filter((r) => !r.dev || r.id === region.id).map((r) => {
          const available = !!(r.db || r.preview);
          const label = `${r.label}${!r.db && r.preview ? ' · preview' : ''}`;
          return (
            <button key={r.id} className={r.id === region.id ? 'on' : ''} disabled={!available} data-label={label}
              title={r.db ? `Live · ${r.db}` : r.preview ? 'Preview snapshot (live database not published yet)' : 'Not available'}
              onClick={() => available && r.id !== region.id && onRegion(r)}>
              {label}
            </button>
          );
        })}
      </div>
    </header>
  );
}

function ManagerScreen({ region, onRegion }: { region: RegionConfig; onRegion: (r: RegionConfig) => void }) {
  const [cells] = useTable(tables.hexStats);
  const [worldRows, worldReady] = useTable(tables.world);
  const [replayRows] = useTable(tables.replayState);
  const [metricsRows, metricsReady] = useTable(tables.metrics);
  const [facilities] = useTable(tables.facility);
  const [members] = useTable(tables.member);
  // Adjuster positions for the map (demo starts picked on the phones); names from member.
  const [adjusterLocations] = useTable(tables.adjusterLocation);
  const adjusterPins = useMemo(() => {
    const names = new Map(members.map((m) => [m.identity.toHexString(), m.name]));
    return adjusterLocations.map((l) => {
      const id = l.identity.toHexString();
      return { id, name: names.get(id) ?? 'Adjuster', lat: l.lat, lng: l.lng };
    });
  }, [adjusterLocations, members]);
  const [myMember, memberReady] = useTable(tables.myMember);
  const [assignments] = useTable(tables.assignment);
  // Each adjuster's "Next best" list (backend rules, src/recommend.ts); the area panel shows who is matched where.
  const [recommendations] = useTable(tables.adjusterRecommendation);

  const [flash, setFlash] = useState<{ hex: string; key: number } | null>(null);
  const [toast, setToast] = useState<{ key: number; title: string; detail: string } | null>(null);
  const onLiveEvent = useCallback((hex: string, title: string, detail: string) => {
    const key = Date.now();
    setFlash({ hex, key });
    setToast({ key, title, detail });
  }, []);
  const recent = (at: { toDate(): Date }) => Date.now() - at.toDate().getTime() < 20_000;

  const [smsReplies] = useTable(tables.smsReply, {
    onInsert: (r) => r.source === 'live' && recent(r.ingestedAt) && onLiveEvent(r.hex, r.lifeSafety ? 'Life-safety reply' : r.safety === 'needs_help' ? 'Help request' : 'Reply', r.damageKnown ? `damage ${r.damage}` : 'damage unknown'),
  });
  const [claims] = useTable(tables.claim);
  const [fieldReports] = useTable(tables.fieldReport, {
    onInsert: (r) => recent(r.ingestedAt) && onLiveEvent(r.hex, `Field report · ${r.adjusterId}`, `${r.safety === 'unsure' ? 'nobody seen' : r.safety.replace('_', ' ')}, ${reportDamage(r)}`),
  });

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(id);
  }, [toast]);

  const world = worldRows[0];
  const replay = replayRows[0];
  const metrics = metricsRows[0];
  const me = myMember[0];
  const isManager = me?.role === 'manager';
  const rejoining = useAutoRejoin('manager', region.db ?? undefined, !!me, memberReady);
  const fictional = world ? !world.region : false; // until `world` arrives, assume real geography (never invent names)

  const [joining, setJoining] = useState(false);
  const [mapMode, setMapMode] = useState<MapMode>('priority');
  const [selected, setSelected] = useState<MapUnit | null>(null);
  const [focus, setFocus] = useState<{ id: string; hex: string } | null>(null); // household panel
  // The disaster itself (cone / track / landfall, or epicentre / rupture). Parsed once per world.
  const hazard = useMemo(() => parseHazard(world?.hazardGeometryJson), [world?.hazardGeometryJson]);
  const [fitTo, setFitTo] = useState<FitTarget | null>(null); // map opens on the cells; the button flips to the cone and back
  const coneShown = fitTo?.target === 'cone';

  // Rebuilt only when the cell set itself changes (not on every stats tick).
  const cellKey = useMemo(() => cellSetKey(cells), [cells]);
  const labeler = useMemo(() => makeLabeler(cells.map((c) => c.hex), fictional), [cellKey, fictional]); // eslint-disable-line react-hooks/exhaustive-deps
  const labelFor = useCallback((u: MapUnit) => (u.res === 7 ? labeler.district(u.id) : labeler.cell(u.id)), [labeler]);

  const cellBy = useMemo(() => new Map(cells.map((c) => [c.hex, c])), [cells]);
  const adjusters = useMemo(() => members.filter((m) => m.role === 'adjuster'), [members]);
  const [adjusterHex, setAdjusterHex] = useState('');
  const pickedAdjuster = adjusters.find((a) => a.identity.toHexString() === adjusterHex) ?? adjusters[0];

  // Keep the selected unit in sync with live data.
  const sel = useMemo(() => {
    if (!selected) return null;
    const kids = selected.kids.map((k) => cellBy.get(k.hex)).filter((k): k is HexStatsRow => !!k);
    // Rebuild the unit from the live rows so the header (priority, status, reason, range) follows updates.
    return kids.length ? unitsFor(kids, selected.res)[0] ?? null : null;
  }, [selected, cellBy]);

  const openAssignments = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assignments) if (a.status === 'assigned') m.set(a.hex, (m.get(a.hex) ?? 0) + 1);
    return m;
  }, [assignments]);
  // Every assigned or completed task with its adjuster's name, for the area panel's "On the way" list.
  // Distance: from the adjuster's last position to the area's centre (the phone routes to the area, not the address).
  const assignedHomes = useMemo<AssignedHome[]>(() => {
    const names = new Map(members.map((m) => [m.identity.toHexString(), m.name]));
    const where = new Map(adjusterLocations.map((l) => [l.identity.toHexString(), l]));
    return assignments
      .filter((a) => a.status !== 'cancelled')
      .map((a) => {
        const id = a.adjuster.toHexString();
        const from = where.get(id);
        return {
          householdId: a.householdId, hex: a.hex, status: a.status, adjuster: names.get(id) ?? 'adjuster', at: a.updatedAt.toDate().getTime(),
          km: from && a.status === 'assigned' ? kmToCell(from, a.hex) : null,
        };
      });
  }, [assignments, members, adjusterLocations]);
  // Matched but not accepted: each adjuster's Next best #1, unless that home already has an open assignment.
  const matched = useMemo<MatchedPick[]>(() => {
    const names = new Map(members.map((m) => [m.identity.toHexString(), m.name]));
    const taken = new Set(assignments.filter((a) => a.status === 'assigned').map((a) => a.householdId));
    return recommendations
      .filter((r) => r.rank === 1 && !taken.has(r.householdId))
      .map((r) => ({ householdId: r.householdId, hex: r.hex, adjuster: names.get(r.adjuster.toHexString()) ?? 'adjuster', km: r.distanceKm }));
  }, [recommendations, assignments, members]);
  // Household → name of the adjuster it is assigned to (open assignments only).
  const sentTo = useMemo(() => {
    const names = new Map(members.map((m) => [m.identity.toHexString(), m.name]));
    const m = new Map<string, string>();
    for (const a of assignments) if (a.status === 'assigned') m.set(a.householdId, names.get(a.adjuster.toHexString()) ?? 'adjuster');
    return m;
  }, [assignments, members]);

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [];
    for (const r of smsReplies) items.push({ key: `s${r.id}`, kind: 'sms_reply', t: r.t, at: r.ingestedAt.toDate().getTime(), hex: r.hex, householdId: r.householdId, live: r.source === 'live', ...replyFeed(r) });
    for (const c of claims) items.push({ key: `c${c.id}`, kind: 'claim', t: c.t, at: c.ingestedAt.toDate().getTime(), hex: c.hex, householdId: c.householdId, live: c.source === 'live', channel: 'claim', title: 'Claim filed', detail: `${cap(c.peril)} · ${damagePhrase(c.reportedDamage)}`, tone: 'neutral' });
    for (const f of fieldReports) items.push({ key: `f${f.id}`, kind: 'field_report', t: f.t, at: f.ingestedAt.toDate().getTime(), hex: f.hex, householdId: f.householdId, live: true, channel: 'visit',
      title: f.safety === 'unsure' ? 'Visit · nobody seen' : f.safety === 'needs_help' ? 'Visit · needs help' : 'Visit · everyone safe',
      detail: `${f.damageKnown ? damagePhrase(f.damage) : 'House not assessed'} · ${f.adjusterId}`, tone: f.safety === 'needs_help' ? 'help' : 'neutral' });
    return items.sort((a, b) => b.t - a.t || b.at - a.at).slice(0, 50);
  }, [smsReplies, claims, fieldReports]);

  // Newest reply per household (request lists, household panel).
  const latestReply = useMemo(() => {
    const m = new Map<string, SmsReplyRow>();
    for (const r of smsReplies) {
      const prev = m.get(r.householdId);
      if (!prev || r.t >= prev.t) m.set(r.householdId, r);
    }
    return m;
  }, [smsReplies]);

  const kidsNote = useMemo(() => makeKidsNote(facilities, cellBy, !!world?.schoolHours), [facilities, cellBy, world?.schoolHours]);


  // QR target: a household with a phone in the most urgent silent cell, so a judge's reply lands somewhere visible.
  const qrHex = useMemo(() => {
    const top = [...cells].filter((c) => c.households > 0)
      .sort((a, b) => b.silence * b.hazard * b.households - a.silence * a.hazard * a.households || b.severity - a.severity)[0];
    return top?.hex ?? null;
  }, [cells]);
  const qrCell = useHouseholdsInCell(qrHex);
  const qrHousehold = useMemo(() => qrCell.find((h) => h.phoneOnFile) ?? qrCell[0] ?? null, [qrCell]);

  // Assignments need an adjuster who has joined (backend rule). Feedback goes to the toast so it is
  // visible wherever the button was (list or area panel).
  const adjusterUrl = `${window.location.pathname}?region=${region.id}#/adjuster`;
  const assignHex = useReducer(reducers.assignHex);
  const assignOne = useReducer(reducers.assign);
  const notify = (title: string, detail: string) => setToast({ key: Date.now(), title, detail });
  const sendAdjuster = async (what: string, call: (adjusterIdentityHex: string) => Promise<unknown>) => {
    if (!isManager) return setJoining(true);
    if (!pickedAdjuster) return notify('No adjuster online', 'open the adjuster screen and join as adjuster first');
    try {
      await call(pickedAdjuster.identity.toHexString());
      notify('Adjuster sent', `${what} → ${pickedAdjuster.name}`);
    } catch (e) {
      notify('Could not send adjuster', e instanceof Error ? e.message : String(e));
    }
  };
  const doAssign = (hex: string) =>
    sendAdjuster(`up to 3 homes in ${labeler.cell(hex)}`, (adjusterIdentityHex) => assignHex({ hex, adjusterIdentityHex, count: 3 }));
  const doAssignHousehold = (householdId: string) =>
    sendAdjuster(homeLabel(householdId, fictional), (adjusterIdentityHex) => assignOne({ householdId, adjusterIdentityHex }));

  const counts = metrics ? { P0: metrics.p0Cells, P1: metrics.p1Cells, P2: metrics.p2Cells } : { P0: 0, P1: 0, P2: 0 };
  const selectFromHex = (hex: string) => {
    const c = cellBy.get(hex);
    setFocus(null);
    if (c) setSelected(unitFromCell(c));
  };
  const selectUnit = (u: MapUnit) => {
    setFocus(null);
    setSelected(u);
  };
  const openHousehold = (id: string, hex: string) => {
    setSelected(null);
    setFocus({ id, hex });
  };


  // Household panel data: the manager already subscribes to every reply / claim / field report.
  const focusIds = useMemo(() => (focus ? [focus.id] : []), [focus]);
  const focusHousehold = useHouseholdsById(focusIds).get(focus?.id ?? '');
  const focusEst = useEstimatesById(focusIds).get(focus?.id ?? '');
  const focusCell = focus ? cellBy.get(focus.hex) : undefined;
  const focusSignals = useMemo(() => ({
    replies: focus ? smsReplies.filter((r) => r.householdId === focus.id) : [],
    reports: focus ? fieldReports.filter((r) => r.householdId === focus.id) : [],
    claims: focus ? claims.filter((r) => r.householdId === focus.id) : [],
  }), [focus, smsReplies, fieldReports, claims]);
  const simMinutes = replay?.simMinutes ?? 0;
  // Decision trace: a cell's before → after is captured from the update that carried each reply, so it
  // has to listen while the page is open, not only while the panel is.
  const replyCellCapture = useReplyCellCapture();
  const selHexes = useMemo(() => sel?.kids.map((k) => k.hex) ?? [], [sel]);

  // A new disaster is being loaded: the world row is gone (wiped) or present but not counted yet
  // (metrics.households is recounted by reset_demo, the last seeding step).
  const loading = !worldReady
    ? null
    : !world
      ? 'Waiting for the next scenario…'
      : metricsReady && (!metrics || metrics.households === 0)
        ? `Loading ${world.name} · ${cells.length.toLocaleString()} areas so far`
        : null;

  return (
    <div className="manager live">
      <RegionHeader region={region} onRegion={onRegion} scenario={world?.name}>
        <QrButton household={qrHousehold} region={region.id} />
        <ModelButton metrics={metrics} />
        <ConnectionBadge />
        {me ? (
          <span className="small">{me.role === 'manager' ? 'Manager' : me.role} · <b>{me.name}</b></span>
        ) : rejoining ? (
          <span className="small muted">Rejoining…</span>
        ) : (
          <button className="btn" onClick={() => setJoining(true)}>{rememberedName(region.db ?? undefined, 'manager') ? 'Rejoin as manager' : 'Join as manager'}</button>
        )}
      </RegionHeader>

      <div className="stage">
        <LiveMap
          cells={cells}
          labelFor={labelFor}
          selected={focus?.hex ?? sel?.id ?? null}
          onSelect={selectUnit}
          flash={flash}
          fitKey={`${region.id}|${world?.eventId ?? ''}`}
          padLeft={420}
          padRight={40}
          mode={mapMode}
          hazard={hazard}
          fitTo={fitTo}
          adjusters={adjusterPins}
        />

        <div className="left-rail">
          <AccountingCard metrics={metrics} />
          {/* The live-event toast sits just right of the queue panel (p2), level with its top. */}
          <div className="p2-slot">
          <OutreachPanel
            simMinutes={simMinutes}
            cellBy={cellBy}
            labeler={labeler}
            fictional={fictional}
            feed={feed}
            latestReply={latestReply}
            kidsNote={kidsNote}
            onSelectHex={selectFromHex}
            onOpen={openHousehold}
            onAssignHousehold={doAssignHousehold}
            sentTo={sentTo}
            adjusterUrl={adjusterUrl}
            adjusters={adjusters}
            pickedAdjuster={pickedAdjuster}
            onPickAdjuster={setAdjusterHex}
            metrics={metrics}
            canAct={isManager}
            onNeedJoin={() => setJoining(true)}
          />
          {toast && (
            <div className="toast" key={toast.key} role="status">
              <span className="dot" />
              <span><b>{toast.title}</b> · {toast.detail}</span>
              <span className="muted">just now</span>
            </div>
          )}
          </div>
        </div>

        <div className="overlay map-tools">
          <div className="map-chips">
            <div className="gseg" role="group" aria-label="Map shading">
              <button className={mapMode === 'priority' ? 'on' : ''} aria-pressed={mapMode === 'priority'} onClick={() => setMapMode('priority')}>Priority</button>
              <button className={mapMode === 'unaccounted' ? 'on' : ''} aria-pressed={mapMode === 'unaccounted'} onClick={() => setMapMode('unaccounted')}>Unaccounted</button>
            </div>
            {hasCone(hazard) && (
              <button className="glass-chip chip-btn" aria-pressed={coneShown}
                onClick={() => setFitTo((f) => ({ target: f?.target === 'cone' ? 'cells' : 'cone', n: (f?.n ?? 0) + 1 }))}>
                {coneShown ? 'Back to affected areas' : 'Show forecast cone'}
              </button>
            )}
          </div>
          {loading && (
            <div className="toast loading" role="status">
              <span className="dot" />
              <span>{loading}</span>
            </div>
          )}
        </div>

        <div className="overlay map-legend glass-chip">
          {(['P0', 'P1', 'P2'] as Priority[]).map((p) => (
            <span key={p}><i style={{ background: COLOR[p] }} /><b>{counts[p]}</b> {p}</span>
          ))}
          <span className="muted">{mapMode === 'unaccounted' ? 'stronger = more not heard from' : 'fainter = less confident'}</span>
          <span className="muted">
            <svg width="14" height="13" aria-hidden><polygon points="7,1 13,4 13,9.5 7,12.5 1,9.5 1,4" fill="none" stroke={COLOR.P0} strokeWidth="2" /></svg>
            silent high-hazard
          </span>
          {hazard?.kind === 'hurricane' && (
            <span className="muted hazard-key" title={hasCone(hazard) ? `Forecast cone issued ${hazard.cone.issuedHoursBeforeLandfall} h before landfall` : undefined}>
              <svg width="18" height="10" aria-hidden><line x1="1" y1="5" x2="17" y2="5" stroke="#1e2a3a" strokeWidth="2" strokeDasharray="4 3" /></svg>
              track
              <svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="3.5" fill="#fff" stroke="#1e2a3a" strokeWidth="1.5" /></svg>
              when forecast issued
              <svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="4" fill="#1e2a3a" /></svg>
              landfall
            </span>
          )}
          {hazard?.kind === 'earthquake' && (
            <span className="muted hazard-key">
              <svg width="14" height="14" aria-hidden><circle cx="7" cy="7" r="6" fill="none" stroke="#1e2a3a" strokeWidth="1.2" /><circle cx="7" cy="7" r="3" fill="#1e2a3a" /></svg>
              epicentre
              {hazard.rupture && <><svg width="18" height="10" aria-hidden><line x1="2" y1="5" x2="16" y2="5" stroke="#1e2a3a" strokeWidth="3.5" strokeLinecap="round" /></svg>rupture</>}
            </span>
          )}
        </div>

        {focus && (
          <div className="right-rail">
            <HouseholdPanel
              householdId={focus.id}
              household={focusHousehold}
              est={focusEst}
              {...focusSignals}
              label={labeler.cell(focus.hex)}
              priority={focusCell && prio(focusCell.priority)}
              unverified={focusCell?.verification === 'needs_verification'}
              fictional={fictional}
              sentTo={sentTo.get(focus.id)}
              canAssign={adjusters.length > 0}
              adjusterUrl={adjusterUrl}
              onAssign={doAssignHousehold}
              onClose={() => setFocus(null)}
              noteFor={kidsNote}
            />
            <DecisionTrace
              householdId={focus.id}
              latestReply={latestReply}
              cellBy={cellBy}
              capture={replyCellCapture}
              labelCell={labeler.cell}
              fictional={fictional}
            />
          </div>
        )}

        {!focus && !sel && (
          <div className="right-top">
            <SevereCard metrics={metrics} simMinutes={simMinutes} maxMinutes={replay?.maxMinutes || 4320} />
          </div>
        )}

        {!focus && sel && (
          <div className="right-rail">
            <CellDetail
              unit={sel}
              label={labelFor(sel)}
              openAssignments={openAssignments}
              assignedHomes={assignedHomes}
              matched={matched}
              onOpenHousehold={openHousehold}
              cellLabel={labeler.cell}
              onSelectCell={selectFromHex}
              onAssign={doAssign}
              onClose={() => setSelected(null)}
              canAssign={isManager}
              adjusterName={pickedAdjuster?.name}
              adjusterUrl={adjusterUrl}
              fictional={fictional}
              noteFor={kidsNote}
            />
            <DecisionTrace
              key={sel.id}
              cellHexes={selHexes}
              latestReply={latestReply}
              cellBy={cellBy}
              capture={replyCellCapture}
              labelCell={labeler.cell}
              fictional={fictional}
              onOpenHousehold={openHousehold}
            />
          </div>
        )}
      </div>

      <ReplayBar replay={replay} canControl={isManager} onNeedJoin={() => setJoining(true)} />
      {joining && <JoinDialog role="manager" db={region.db ?? undefined} onDone={() => setJoining(false)} onCancel={() => setJoining(false)} />}
    </div>
  );
}

// Model diagnostics moved off the main screen: a small popover in the header.
function ModelButton({ metrics }: { metrics: MetricsRow | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="model-wrap">
      <button className="btn ghost-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>Model ⓘ</button>
      {open && metrics && (
        <div className="glass model-pop" role="dialog" aria-label="Model diagnostics">
          <div className="model-head"><b>Model</b><span className="small muted">v{metrics.modelVersion} · {metrics.engine}</span></div>
          <dl>
            <dt>Holdout error (Brier)</dt><dd>{metrics.holdoutN ? metrics.holdoutBrierSevere.toFixed(3) : '—'}</dd>
            <dt>Source trust · hazard / SMS / claims</dt><dd>{pct(metrics.trustHazard)} · {pct(metrics.trustSms)} · {pct(metrics.trustClaims)}</dd>
            {/* metrics.verifiedCoverage = verifiedHouseholds / households (ingest.ts): field reports, all areas. */}
            <dt title="Share of all households with an adjuster's field report">Inspected coverage</dt><dd>{pct(metrics.verifiedCoverage)}</dd>
            <dt>Cells needing a check</dt><dd>{metrics.needsVerificationCells} of {metrics.hexes}</dd>
            <dt>Closed without contact</dt><dd>{metrics.closedNoContact}</dd>
          </dl>
          <span className="small muted">Trust moves after every 10 field reports. Lower holdout error is better.</span>
        </div>
      )}
    </div>
  );
}

function unitFromCell(c: HexStatsRow): MapUnit {
  return unitsFor([c], 8)[0];
}

function Chip({ p, unverified }: { p: Priority; unverified?: boolean }) {
  return (
    <span className={`chip chip-${p}`} style={{ opacity: unverified ? 0.55 : 1 }} title={unverified ? `${p}, needs check` : p}>
      {p}
    </span>
  );
}

type AssignedHome = { householdId: string; hex: string; status: string; adjuster: string; at: number; km?: number | null };
type MatchedPick = { householdId: string; hex: string; adjuster: string; km: number };

// Straight-line km from a position to an H3 cell's centre; shown in miles like the phone.
function kmToCell(from: { lat: number; lng: number }, hex: string): number {
  const [lat, lng] = cellToLatLng(hex);
  const rad = Math.PI / 180;
  const s = Math.sin(((lat - from.lat) * rad) / 2) ** 2 + Math.cos(from.lat * rad) * Math.cos(lat * rad) * Math.sin(((lng - from.lng) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
}
const miles = (km: number) => `${(km * 0.621371).toFixed(1)} mi`;
const ASSIGNED_SHOWN = 8;

export function CellDetail({ unit, label, openAssignments, assignedHomes = [], matched = [], onOpenHousehold, cellLabel, onSelectCell, onAssign, onClose, canAssign, adjusterName, adjusterUrl, readOnly = false, fictional = false }: {
  unit: MapUnit;
  label: string;
  households?: Map<string, HouseholdRow>;
  candidates?: readonly { householdId: string; hex: string; rank: number; inspectScore: number; pSevere: number; pNeedsHelp: number }[];
  openAssignments: Map<string, number>;
  assignedHomes?: readonly AssignedHome[];
  matched?: readonly MatchedPick[];
  onOpenHousehold?: (householdId: string, hex: string) => void;
  cellLabel?: (hex: string) => string;   // "District 14 · 3"
  onSelectCell?: (hex: string) => void;  // open that neighborhood's panel
  onAssign: (hex: string) => void;
  onClose: () => void;
  canAssign: boolean;
  adjusterName: string | undefined;
  adjusterUrl?: string;
  readOnly?: boolean;
  fictional?: boolean;
  noteFor?: (h: HouseholdRow | undefined) => string | null;
}) {
  const kidHexes = new Set(unit.kids.map((k) => k.hex));
  // For a district, assign in its most urgent unverified child cell.
  const target = [...unit.kids].sort((a, b) => RANK[prio(a.priority)] - RANK[prio(b.priority)] || b.severity - a.severity)
    .find((k) => k.verification === 'needs_verification') ?? unit.kids[0];
  const assigned = unit.kids.reduce((s, k) => s + (openAssignments.get(k.hex) ?? 0), 0);
  // Homes sent to adjusters in this area: open first, then done; newest first within each.
  const homes = assignedHomes.filter((a) => kidHexes.has(a.hex))
    .sort((a, b) => Number(a.status !== 'assigned') - Number(b.status !== 'assigned') || b.at - a.at);
  const doneCount = homes.filter((a) => a.status !== 'assigned').length;
  const picks = matched.filter((m) => kidHexes.has(m.hex));
  const homeLink = (householdId: string, hex: string) => (onOpenHousehold
    ? <button type="button" className="link" onClick={() => onOpenHousehold(householdId, hex)}><b>{homeLabel(householdId, fictional)}</b></button>
    : <b>{homeLabel(householdId, fictional)}</b>);
  // The neighborhood that sets a district's priority (same rule as unitsFor).
  const topKid = unit.kids.reduce((a, b) =>
    RANK[prio(b.priority)] < RANK[prio(a.priority)] || (b.priority === a.priority && b.severity > a.severity) ? b : a);
  return (
    <aside className="card detail">
      <div className="detail-head">
        <div className="detail-nav">
          <button className="link muted" onClick={onClose}>← Queues</button>
          <button className="link muted close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="detail-title">
          <Chip p={unit.p} unverified={unit.v === 'needs_verification'} />
          <h2>{label}</h2>
          <span className={`pill status-${cellStatus(unit.fr, unit.v)}`}>{CELL_STATUS_LABEL[cellStatus(unit.fr, unit.v)]}</span>
        </div>
        <span className="muted small">
          {unit.res === 7 ? `District of ${unit.kids.length} neighborhoods · ` : ''}{unit.n.toLocaleString()} households · confidence {pct(unit.c)}
        </span>
      </div>
      <div className="detail-body">
        {/* Kept short on purpose: neighborhood number, the readout and assigned homes. The engine's reasoning is in the decision trace. */}
        {unit.res === 7 && cellLabel && (
          <p className="nb-line">
            Most urgent neighborhood:{' '}
            {onSelectCell
              ? <button type="button" className="link nb-link" onClick={() => onSelectCell(topKid.hex)}>{cellLabel(topKid.hex)}</button>
              : <b>{cellLabel(topKid.hex)}</b>}
          </p>
        )}
        <div className="readout">
          <span title={`90% range from the simulation · point estimate ~${unit.ex.toFixed(1)}`}><b>{severeRange(unit)}</b>homes severely damaged</span>
          <span><b>{unit.rep}/{unit.sent}</b>SMS replied</span>
          <span><b>{unit.cl}</b>claims</span>
        </div>
        {!readOnly && <>
        {/* Who is heading here (open tasks, distance from their last position) and who the backend's
            Next best has matched here but who hasn't accepted yet. Distances only, never arrival times. */}
        {homes.length > 0 && <>
          <h3 className="eyebrow divider">On the way · {homes.length - doneCount}{doneCount ? ` · ${doneCount} done` : ''}</h3>
          <ul className="hh-list otw-list">
            {homes.slice(0, ASSIGNED_SHOWN).map((a) => (
              <li key={`${a.householdId}-${a.at}`}>
                <span className="hh-main">
                  <b className="otw-who">{a.adjuster}</b>
                  <span className="muted small">{homeLink(a.householdId, a.hex)}{a.km != null ? ` · ${miles(a.km)}` : ''}</span>
                </span>
                <span className={`small num otw-state${a.status === 'assigned' ? ' going' : ''}`}>{a.status === 'assigned' ? 'On the way' : 'Done ✓'}</span>
              </li>
            ))}
            {homes.length > ASSIGNED_SHOWN && <li className="muted small">+{homes.length - ASSIGNED_SHOWN} more</li>}
          </ul>
        </>}
        {picks.length > 0 && <>
          <h3 className="eyebrow divider">Matched · not accepted yet</h3>
          <ul className="hh-list otw-list">
            {picks.map((m) => (
              <li key={`${m.adjuster}-${m.householdId}`}>
                <span className="hh-main">
                  <b className="otw-who">{m.adjuster}</b>
                  <span className="muted small">{homeLink(m.householdId, m.hex)} · {miles(m.km)}</span>
                </span>
                <span className="small num muted">Next best #1</span>
              </li>
            ))}
          </ul>
        </>}
        </>}
      </div>
      {!readOnly && <div className="detail-actions">
        <span className="assigned small">{assigned ? `${assigned} inspection${assigned > 1 ? 's' : ''} assigned` : canAssign ? (adjusterName ? `To ${adjusterName}` : 'No adjuster online') : 'Join as manager to assign'}</span>
        {canAssign && !adjusterName && adjusterUrl
          ? <a className="btn" href={adjusterUrl} target="_blank" rel="noreferrer">Open adjuster screen ↗</a>
          : <button className="btn primary" onClick={() => onAssign(target.hex)}>Assign 3 inspections</button>}
      </div>}
    </aside>
  );
}

// Feed rows in plain words: a title that says what happened, a detail line with the house.
const DAMAGE_PHRASE = ['No damage', 'Minor damage', 'Severe damage', 'Uninhabitable'];
const damagePhrase = (d: number) => DAMAGE_PHRASE[d] ?? `Damage ${d}`;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
function replyFeed(r: SmsReplyRow): Pick<FeedItem, 'channel' | 'title' | 'detail' | 'tone'> {
  return {
    channel: r.channel === 'call' ? 'call' : 'text',
    title: r.lifeSafety ? 'Immediate danger' : r.safety === 'needs_help' ? 'Needs help' : r.notHome ? 'Safe, not home' : 'Safe',
    detail: r.damageKnown ? damagePhrase(r.damage) : 'Damage unknown',
    tone: r.lifeSafety ? 'danger' : r.safety === 'needs_help' ? 'help' : 'ok',
  };
}
