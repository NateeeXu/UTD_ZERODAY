import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings/index.ts';
import { ConnectionBadge, LiveProvider } from './LiveProvider';
import { REGIONS, initialRegion, rememberRegion, type RegionConfig } from './config';
import { LiveMap } from './LiveMap';
import { JoinDialog } from './JoinDialog';
import { ReplayBar } from './ReplayBar';
import { LiveQrCard } from './LiveQrCard';
import { useHouseholdsById, useHouseholdsInCell } from './hooks';
import { SnapshotManager } from './SnapshotManager';
import { makeLabeler } from './labels';
import { CAUSE, COLOR, RANK, prio, unitsFor, type MapMode, type MapUnit, type Priority } from './mapModel';
import { AccountingCard, makeKidsNote } from './accounting';
import { OutreachPanel, type FeedItem } from './OutreachPanel';
import { ReferralsPanel } from './ReferralsPanel';
import type { HexStatsRow, HouseholdRow, MetricsRow } from './rows';
import { homeLabel, pct } from '../format';

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

// Shared top bar: product label, region switcher, right-hand slot.
export function RegionHeader({ region, onRegion, fictional, children }: {
  region: RegionConfig; onRegion: (r: RegionConfig) => void; fictional: boolean; children?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <strong>Triage Loop</strong>
        <span className="muted small">
          {fictional ? 'Synthetic exercise · fictional town · no real customer data' : 'Synthetic exercise · real geography and census data · no real customer data'}
        </span>
      </div>
      <div className="segmented" role="group" aria-label="Region">
        {REGIONS.map((r) => {
          const available = !!(r.db || r.preview);
          return (
            <button key={r.id} className={r.id === region.id ? 'on' : ''} disabled={!available}
              title={r.db ? `Live · ${r.db}` : r.preview ? 'Preview snapshot (live database not published yet)' : 'Not available'}
              onClick={() => available && r.id !== region.id && onRegion(r)}>
              {r.label}{!r.db && r.preview ? ' · preview' : ''}
            </button>
          );
        })}
      </div>
      <div className="topbar-right">{children}</div>
    </header>
  );
}

function ManagerScreen({ region, onRegion }: { region: RegionConfig; onRegion: (r: RegionConfig) => void }) {
  const [cells] = useTable(tables.hexStats);
  const [worldRows] = useTable(tables.world);
  const [replayRows] = useTable(tables.replayState);
  const [metricsRows] = useTable(tables.metrics);
  const [facilities] = useTable(tables.facility);
  const [members] = useTable(tables.member);
  const [myMember] = useTable(tables.myMember);
  const [candidates] = useTable(tables.inspectionCandidate);
  const [assignments] = useTable(tables.assignment);

  const [flash, setFlash] = useState<{ hex: string; key: number } | null>(null);
  const [toast, setToast] = useState<{ key: number; title: string; detail: string } | null>(null);
  const onLiveEvent = useCallback((hex: string, title: string, detail: string) => {
    const key = Date.now();
    setFlash({ hex, key });
    setToast({ key, title, detail });
  }, []);
  const recent = (at: { toDate(): Date }) => Date.now() - at.toDate().getTime() < 20_000;

  const [smsReplies] = useTable(tables.smsReply, {
    onInsert: (r) => r.source === 'live' && recent(r.ingestedAt) && onLiveEvent(r.hex, r.safety === 'needs_help' ? 'HELP reply' : 'SMS reply', `damage ${r.damage}`),
  });
  const [claims] = useTable(tables.claim);
  const [fieldReports] = useTable(tables.fieldReport, {
    onInsert: (r) => recent(r.ingestedAt) && onLiveEvent(r.hex, `Field report · ${r.adjusterId}`, `${r.safety.replace('_', ' ')}, damage ${r.damage}`),
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
  const fictional = world ? !world.region : false; // until `world` arrives, assume real geography (never invent names)

  const [joining, setJoining] = useState(false);
  const [mapMode, setMapMode] = useState<MapMode>('priority');
  const [selected, setSelected] = useState<MapUnit | null>(null);
  const [showFacilities, setShowFacilities] = useState(false);
  const [res, setRes] = useState<7 | 8>(7);

  const labeler = useMemo(() => makeLabeler(cells.map((c) => c.hex), fictional), [cells.length, fictional]); // eslint-disable-line react-hooks/exhaustive-deps
  const labelFor = useCallback((u: MapUnit) => (u.res === 7 ? labeler.district(u.id) : labeler.cell(u.id)), [labeler]);

  const cellBy = useMemo(() => new Map(cells.map((c) => [c.hex, c])), [cells]);
  const adjusters = useMemo(() => members.filter((m) => m.role === 'adjuster'), [members]);
  const [adjusterHex, setAdjusterHex] = useState('');
  const pickedAdjuster = adjusters.find((a) => a.identity.toHexString() === adjusterHex) ?? adjusters[0];

  // Keep the selected unit in sync with live data.
  const sel = useMemo(() => {
    if (!selected) return null;
    const kids = selected.kids.map((k) => cellBy.get(k.hex)).filter((k): k is HexStatsRow => !!k);
    return kids.length ? { ...selected, kids } : null;
  }, [selected, cellBy]);

  const openAssignments = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assignments) if (a.status === 'assigned') m.set(a.hex, (m.get(a.hex) ?? 0) + 1);
    return m;
  }, [assignments]);

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [];
    for (const r of smsReplies) items.push({ key: `s${r.id}`, kind: 'sms_reply', t: r.t, at: r.ingestedAt.toDate().getTime(), hex: r.hex, householdId: r.householdId, live: r.source === 'live', text: `${r.safety === 'needs_help' ? 'HELP' : 'SAFE'} reply · damage ${r.damage}`, help: r.safety === 'needs_help' });
    for (const c of claims) items.push({ key: `c${c.id}`, kind: 'claim', t: c.t, at: c.ingestedAt.toDate().getTime(), hex: c.hex, householdId: c.householdId, live: c.source === 'live', text: `Claim · ${c.peril} · damage ${c.reportedDamage}`, help: false });
    for (const f of fieldReports) items.push({ key: `f${f.id}`, kind: 'field_report', t: f.t, at: f.ingestedAt.toDate().getTime(), hex: f.hex, householdId: f.householdId, live: true, text: `Field report (${f.adjusterId}) · ${f.safety.replace('_', ' ')} · damage ${f.damage}`, help: f.safety === 'needs_help' });
    return items.sort((a, b) => b.t - a.t || b.at - a.at).slice(0, 50);
  }, [smsReplies, claims, fieldReports]);

  const kidsNote = useMemo(() => makeKidsNote(facilities, cellBy, !!world?.schoolHours), [facilities, cellBy, world?.schoolHours]);

  // Household details for the selected cell's candidates (the panels subscribe their own rows).
  const detailIds = useMemo(() => {
    if (!sel) return [];
    const kids = new Set(sel.kids.map((k) => k.hex));
    return candidates.filter((c) => kids.has(c.hex)).map((c) => c.householdId);
  }, [sel, candidates]);
  const householdBy = useHouseholdsById(detailIds);

  // QR target: a household with a phone in the most urgent silent cell, so a judge's reply lands somewhere visible.
  const qrHex = useMemo(() => {
    const top = [...cells].filter((c) => c.households > 0)
      .sort((a, b) => b.silence * b.hazard * b.households - a.silence * a.hazard * a.households || b.severity - a.severity)[0];
    return top?.hex ?? null;
  }, [cells]);
  const qrCell = useHouseholdsInCell(qrHex);
  const qrHousehold = useMemo(() => qrCell.find((h) => h.phoneOnFile) ?? qrCell[0] ?? null, [qrCell]);

  const assignHex = useReducer(reducers.assignHex);
  const [assignError, setAssignError] = useState<string | null>(null);
  const doAssign = async (hex: string) => {
    if (!isManager) return setJoining(true);
    if (!pickedAdjuster) return setAssignError('No adjuster has joined yet. Open the adjuster screen on a phone and join first.');
    setAssignError(null);
    try {
      await assignHex({ hex, adjusterIdentityHex: pickedAdjuster.identity.toHexString(), count: 3 });
    } catch (e) {
      setAssignError(e instanceof Error ? e.message : String(e));
    }
  };

  const counts = metrics ? { P0: metrics.p0Cells, P1: metrics.p1Cells, P2: metrics.p2Cells } : { P0: 0, P1: 0, P2: 0 };
  const selectFromHex = (hex: string) => {
    const c = cellBy.get(hex);
    if (c) setSelected(unitFromCell(c));
  };
  const simMinutes = replay?.simMinutes ?? 0;

  return (
    <div className="manager live">
      <RegionHeader region={region} onRegion={onRegion} fictional={fictional}>
        <ModelButton metrics={metrics} />
        <ConnectionBadge />
        {me ? (
          <span className="small">{me.role === 'manager' ? 'Manager' : me.role} · <b>{me.name}</b></span>
        ) : (
          <button className="btn" onClick={() => setJoining(true)}>Join as manager</button>
        )}
      </RegionHeader>

      <div className="stage">
        <LiveMap
          cells={cells}
          facilities={facilities}
          showFacilities={showFacilities}
          labelFor={labelFor}
          selected={sel?.id ?? null}
          onSelect={setSelected}
          flash={flash}
          fitKey={region.id}
          padLeft={420}
          padRight={420}
          onResChange={setRes}
          mode={mapMode}
        />

        <div className="left-rail">
          <AccountingCard metrics={metrics} />
          <OutreachPanel
            simMinutes={simMinutes}
            cellBy={cellBy}
            labeler={labeler}
            fictional={fictional}
            feed={feed}
            kidsNote={kidsNote}
            onSelectHex={selectFromHex}
            onAssign={doAssign}
            adjusters={adjusters}
            pickedAdjuster={pickedAdjuster}
            onPickAdjuster={setAdjusterHex}
            assignError={assignError}
          />
        </div>

        <div className="overlay map-tools">
          <div className="map-chips">
            <div className="gseg" role="group" aria-label="Map shading">
              <button className={mapMode === 'priority' ? 'on' : ''} aria-pressed={mapMode === 'priority'} onClick={() => setMapMode('priority')}>Priority</button>
              <button className={mapMode === 'unaccounted' ? 'on' : ''} aria-pressed={mapMode === 'unaccounted'} onClick={() => setMapMode('unaccounted')}>Unaccounted</button>
            </div>
            <label className="glass-chip">
              <input type="checkbox" checked={showFacilities} onChange={(e) => setShowFacilities(e.target.checked)} disabled={!facilities.length} />
              Schools and hospitals
            </label>
            <span className="glass-chip muted" title="Zoom in for neighborhoods (res 8)">{res === 7 ? 'Districts' : 'Neighborhoods'}</span>
          </div>
          {toast && (
            <div className="toast" key={toast.key} role="status">
              <span className="dot" />
              <span><b>{toast.title}</b> · {toast.detail}</span>
              <span className="muted">just now</span>
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
        </div>

        <div className="right-rail">
          {sel ? (
            <CellDetail
              unit={sel}
              label={labelFor(sel)}
              households={householdBy}
              candidates={candidates}
              openAssignments={openAssignments}
              onAssign={doAssign}
              onClose={() => setSelected(null)}
              canAssign={isManager}
              adjusterName={pickedAdjuster?.name}
              fictional={fictional}
              noteFor={kidsNote}
            />
          ) : (
            <ReferralsPanel
              metrics={metrics}
              simMinutes={simMinutes}
              labeler={labeler}
              fictional={fictional}
              canAct={isManager}
              onNeedJoin={() => setJoining(true)}
              onSelectHex={selectFromHex}
            />
          )}
          {!sel && <LiveQrCard household={qrHousehold} />}
        </div>
      </div>

      <ReplayBar replay={replay} canControl={isManager} onNeedJoin={() => setJoining(true)} />
      {joining && <JoinDialog role="manager" onDone={() => setJoining(false)} onCancel={() => setJoining(false)} />}
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
            <dt>Verified coverage</dt><dd>{pct(metrics.verifiedCoverage)}</dd>
            <dt>Cells needing verification</dt><dd>{metrics.needsVerificationCells} of {metrics.hexes}</dd>
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

function householdLine(h: HouseholdRow | undefined, fictional: boolean): string {
  if (!h) return '';
  const flags: string[] = [];
  if (h.age75) flags.push('75+');
  else if (h.age65) flags.push('65+');
  if (h.livesAlone) flags.push('lives alone');
  if (h.medicalDevice) flags.push('medical device');
  if (h.disability) flags.push('disability');
  if (h.noVehicle) flags.push('no vehicle');
  if (h.limitedEnglish) flags.push(`limited English${h.primaryLanguage ? ` (${h.primaryLanguage})` : ''}`);
  return [homeLabel(h.id, fictional), ...flags].join(' · ');
}

function Chip({ p, unverified }: { p: Priority; unverified?: boolean }) {
  return (
    <span className={`chip chip-${p}`} style={{ opacity: unverified ? 0.55 : 1 }} title={unverified ? `${p}, needs verification` : p}>
      {p}
    </span>
  );
}

export function CellDetail({ unit, label, households, candidates, openAssignments, onAssign, onClose, canAssign, adjusterName, readOnly = false, fictional = false, noteFor }: {
  unit: MapUnit;
  label: string;
  households: Map<string, HouseholdRow>;
  candidates: readonly { householdId: string; hex: string; rank: number; inspectScore: number; pSevere: number; pNeedsHelp: number }[];
  openAssignments: Map<string, number>;
  onAssign: (hex: string) => void;
  onClose: () => void;
  canAssign: boolean;
  adjusterName: string | undefined;
  readOnly?: boolean;
  fictional?: boolean;
  noteFor?: (h: HouseholdRow | undefined) => string | null;
}) {
  const kidHexes = new Set(unit.kids.map((k) => k.hex));
  const top = candidates.filter((c) => kidHexes.has(c.hex)).sort((a, b) => b.inspectScore - a.inspectScore).slice(0, 6);
  // For a district, assign in its most urgent unverified child cell.
  const target = [...unit.kids].sort((a, b) => RANK[prio(a.priority)] - RANK[prio(b.priority)] || b.severity - a.severity)
    .find((k) => k.verification === 'needs_verification') ?? unit.kids[0];
  const assigned = unit.kids.reduce((s, k) => s + (openAssignments.get(k.hex) ?? 0), 0);
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
          <span className="pill">{unit.v === 'verified' ? 'Verified' : 'Needs verification'}</span>
        </div>
        <span className="muted small">
          {unit.res === 7 ? `District of ${unit.kids.length} neighborhoods · ` : ''}{unit.n.toLocaleString()} households · confidence {pct(unit.c)}
        </span>
      </div>
      <div className="detail-body">
        {unit.r && <p className="reason">{unit.res === 7 && <b>Most urgent neighborhood: </b>}{unit.r}</p>}
        <div className="readout">
          <span><b>~{unit.ex.toFixed(1)}</b>likely severe</span>
          <span><b>{unit.rep}/{unit.sent}</b>SMS replied</span>
          <span><b>{unit.cl}</b>claims</span>
        </div>
        {unit.si >= 0.2 && (
          <p className="small silence-line">Silence {pct(unit.si)} · {CAUSE[unit.sc] ?? (unit.sc || 'cause unclear')}</p>
        )}
        {!readOnly && <>
        <h3 className="eyebrow divider">Inspect first</h3>
        <ul className="hh-list">
          {top.map((c) => (
            <li key={c.householdId}>
              <span className="hh-main">
                <b>{homeLabel(c.householdId, fictional)}</b>
                <span className="muted small">{householdLine(households.get(c.householdId), fictional).split(' · ').slice(1).join(' · ') || 'no vulnerability flags'}</span>
                {noteFor?.(households.get(c.householdId)) && <span className="kids small">{noteFor(households.get(c.householdId))}</span>}
              </span>
              <span className="small num">help {pct(c.pNeedsHelp)} · severe {pct(c.pSevere)}</span>
            </li>
          ))}
          {!top.length && <li className="muted small">No open inspection candidates here.</li>}
        </ul>
        </>}
      </div>
      {!readOnly && <div className="detail-actions">
        <span className="assigned small">{assigned ? `${assigned} inspection${assigned > 1 ? 's' : ''} assigned` : canAssign ? (adjusterName ? `To ${adjusterName}` : 'No adjuster joined yet') : 'Join as manager to assign'}</span>
        <button className="btn primary" onClick={() => onAssign(target.hex)}>Assign 3 inspections</button>
      </div>}
    </aside>
  );
}
