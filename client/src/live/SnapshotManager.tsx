// Manager view for regions whose live database isn't published yet: same map and
// panels, fed by A's preview snapshots at t = 2 h / 6 h / 24 h. Read-only.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RegionConfig } from './config';
import { CellDetail, RegionHeader } from './ManagerLive';
import { LiveMap } from './LiveMap';
import { makeLabeler } from './labels';
import { CAUSE, COLOR, isSuspected, prio, RANK, type MapUnit, type Priority } from './mapModel';
import { loadPreview, snapshotFacilities, snapshotRows, type PreviewData } from './snapshot';
import type { HexStatsRow } from './rows';
import { pct } from '../format';

const fmtHours = (t: number) => (t < 60 ? `${t} min` : `${t / 60} h`);

export function SnapshotManager({ region, onRegion }: { region: RegionConfig; onRegion: (r: RegionConfig) => void }) {
  const [data, setData] = useState<PreviewData | null | undefined>(undefined);
  useEffect(() => {
    loadPreview().then(setData);
  }, []);
  const [t, setT] = useState(360);
  const [tab, setTab] = useState<'verify' | 'act'>('verify');
  const [selected, setSelected] = useState<MapUnit | null>(null);
  const [showFacilities, setShowFacilities] = useState(false);
  const [res, setRes] = useState<7 | 8>(7);

  const snap = region.preview ? data?.regions[region.preview] : undefined;
  const cells = useMemo(() => (snap ? snapshotRows(snap.snapshots[String(t)] ?? []) : []), [snap, t]);
  const facilities = useMemo(() => (snap ? snapshotFacilities(snap) : []), [snap]);
  const labeler = useMemo(() => makeLabeler(cells.map((c) => c.hex), false), [snap]); // eslint-disable-line react-hooks/exhaustive-deps
  const labelFor = useCallback((u: MapUnit) => (u.res === 7 ? labeler.district(u.id) : labeler.cell(u.id)), [labeler]);
  const cellBy = useMemo(() => new Map(cells.map((c) => [c.hex, c])), [cells]);

  // Keep the selection in sync when the snapshot time changes.
  const sel = useMemo(() => {
    if (!selected) return null;
    const kids = selected.kids.map((k) => cellBy.get(k.hex)).filter((k): k is HexStatsRow => !!k);
    return kids.length ? { ...selected, kids } : null;
  }, [selected, cellBy]);

  const counts = useMemo(() => {
    const c = { P0: 0, P1: 0, P2: 0, nv: 0 };
    for (const x of cells) {
      c[prio(x.priority)]++;
      if (x.verification === 'needs_verification') c.nv++;
    }
    return c;
  }, [cells]);

  const actNow = useMemo(
    () => cells.filter((c) => c.priority === 'P0' && c.verification === 'verified').sort((a, b) => b.severity - a.severity).slice(0, 30),
    [cells],
  );
  const toVerify = useMemo(
    () => cells
      .filter((c) => c.verification === 'needs_verification' && c.priority !== 'P2')
      .sort((a, b) => Number(isSuspected(b)) - Number(isSuspected(a)) || RANK[prio(a.priority)] - RANK[prio(b.priority)] || b.silence * b.hazard * b.households - a.silence * a.hazard * a.households)
      .slice(0, 30),
    [cells],
  );

  const select = (c: HexStatsRow) => setSelected({
    id: c.hex, res: 8, kids: [c], p: prio(c.priority), v: c.verification === 'verified' ? 'verified' : 'needs_verification',
    c: c.confidence, n: c.households, ex: c.expectedSevere, rep: c.smsReplies, sent: c.smsSent, cl: c.claims, fr: 0,
    si: c.silence, sc: c.silenceCause, r: c.reason, shape: [], center: [0, 0],
  });

  const when = snap?.eventLocalHour != null
    ? ` · event at ${String(snap.eventLocalHour).padStart(2, '0')}:00 local, ${snap.eventWeekday ? 'weekday' : 'weekend'}`
    : '';

  return (
    <div className="manager live">
      <RegionHeader region={region} onRegion={onRegion} fictional={false}>
        <span className="pill preview-pill" title="Live database not published yet: showing A's precomputed snapshots">Preview snapshot</span>
      </RegionHeader>

      <div className="metrics-strip">
        <span className="ms-title">{snap?.title ?? region.label}</span>
        <span className="muted">{snap ? `${snap.subtitle}${when}` : data === null ? 'Preview data not found (docs/preview/preview-data.js)' : 'Loading…'}</span>
        {(['P0', 'P1', 'P2'] as Priority[]).map((p) => (
          <span key={p}><i className="sw" style={{ background: COLOR[p] }} /><b>{counts[p]}</b> {p}</span>
        ))}
        <span><b>{counts.nv}</b> need verification</span>
        <span className="sep" />
        {snap && <span className="muted">{snap.households.toLocaleString()} synthetic policyholders · {snap.cells} neighborhoods · model v{snap.modelVersion}</span>}
      </div>

      <div className="stage">
        <LiveMap
          cells={cells}
          facilities={facilities}
          showFacilities={showFacilities}
          labelFor={labelFor}
          selected={sel?.id ?? null}
          onSelect={setSelected}
          flash={null}
          fitKey={region.id}
          padRight={420}
          onResChange={setRes}
        />

        <div className="overlay top-left">
          <div className="map-chips">
            <span className="pill">{res === 7 ? 'Districts · H3 res 7' : 'Neighborhoods · H3 res 8'}</span>
            <label className="check chip-check">
              <input type="checkbox" checked={showFacilities} onChange={(e) => setShowFacilities(e.target.checked)} />
              Schools and hospitals
            </label>
          </div>
        </div>

        <div className="overlay bottom-left legend">
          {(['P0', 'P1', 'P2'] as Priority[]).map((p) => (
            <span key={p}><i style={{ background: COLOR[p] }} />{p === 'P0' ? 'P0 act now' : p}</span>
          ))}
          <span><span className="ramp-mini"><i style={{ opacity: 0.2 }} /><i style={{ opacity: 0.5 }} /><i style={{ opacity: 0.85 }} /></span>Fainter = less confident</span>
          <span>
            <svg width="16" height="14" aria-hidden><polygon points="8,1 15,4.5 15,10 8,13 1,10 1,4.5" fill="none" stroke={COLOR.P0} strokeWidth="2" /></svg>
            Pulsing = top 10 silent high-hazard areas
          </span>
        </div>

        <div className="overlay right">
          {sel ? (
            <CellDetail
              unit={sel}
              label={labelFor(sel)}
              households={new Map()}
              candidates={[]}
              openAssignments={new Map()}
              onAssign={() => undefined}
              onClose={() => setSelected(null)}
              canAssign={false}
              adjusterName={undefined}
              readOnly
            />
          ) : (
            <aside className="card queues">
              <nav className="tabs" role="tablist">
                <button role="tab" aria-selected={tab === 'verify'} className={tab === 'verify' ? 'on' : ''} onClick={() => setTab('verify')}>
                  To verify <span className="count">{toVerify.length}</span>
                </button>
                <button role="tab" aria-selected={tab === 'act'} className={tab === 'act' ? 'on' : ''} onClick={() => setTab('act')}>
                  Verified P0 <span className="count">{actNow.length}</span>
                </button>
              </nav>
              <ul className="area-list scroll">
                {(tab === 'verify' ? toVerify : actNow).map((c) => (
                  <li key={c.hex}>
                    <button className="area-row" onClick={() => select(c)}>
                      <span className={`chip chip-${prio(c.priority)}`} style={{ opacity: c.verification === 'needs_verification' ? 0.55 : 1 }}>{prio(c.priority)}</span>
                      <span className="area-row-main">
                        <b>{labeler.cell(c.hex)}{isSuspected(c) ? ' · suspected' : ''}</b>
                        <span className="muted small">
                          {c.households.toLocaleString()} households · {c.smsReplies}/{c.smsSent} replied
                          {c.silence >= 0.2 ? ` · silence ${pct(c.silence)}${c.silenceCause ? `, ${CAUSE[c.silenceCause] ?? c.silenceCause}` : ''}` : ''}
                        </span>
                      </span>
                      <span className="small num">conf {pct(c.confidence)}</span>
                    </button>
                  </li>
                ))}
                {!(tab === 'verify' ? toVerify : actNow).length && <li className="muted empty">Nothing here at this time.</li>}
              </ul>
            </aside>
          )}
        </div>
      </div>

      <footer className="timeline live">
        <span className="small"><b>Snapshot time</b></span>
        <div className="segmented" role="group" aria-label="Snapshot time">
          {(data?.times ?? [120, 360, 1440]).map((x) => (
            <button key={x} className={x === t ? 'on' : ''} aria-pressed={x === t} onClick={() => setT(x)}>t = {fmtHours(x)}</button>
          ))}
        </div>
        <span className="muted small grow-text">
          Read-only preview. Replay controls, assignments and the judge QR code appear here once this region's live database is published.
        </span>
      </footer>
    </div>
  );
}
