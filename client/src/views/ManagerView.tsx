import { useEffect, useMemo, useRef, useState } from 'react';
import type { HexId, SimEvent } from '@shared/types';
import { HexMap, type Layer } from '../components/HexMap';
import { AreaDetail } from '../components/AreaDetail';
import { Timeline } from '../components/Timeline';
import { QrCard } from '../components/QrCard';
import { Chip, actReason, areaHazard, silentReason } from '../components/bits';
import { byUrgency, bySilence, type AreaView } from '../areas';
import { useTriage } from '../state/TriageStore';
import { DAMAGE_LABEL, PRIORITY_COLOR, PRIORITY_LABEL, pct } from '../format';

const LAYERS: { id: Layer; label: string; legend: string }[] = [
  { id: 'fused', label: 'Fused', legend: '' },
  { id: 'hazard', label: 'Hazard', legend: 'Hazard: wind, flood and analyst zones' },
  { id: 'silence', label: 'Silence', legend: "Silence: texted homes that haven't replied, weighted by hazard" },
  { id: 'claims', label: 'Claims gap', legend: 'Claims gap: fewer claims than expected by now' },
];

interface Toast {
  key: number;
  title: string;
  detail: string;
  outcome: string;
}

export function ManagerView() {
  const s = useTriage();
  const [layer, setLayer] = useState<Layer>('fused');
  const [selectedArea, setSelectedArea] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [pulseHex, setPulseHex] = useState<HexId | null>(null);

  // ?area=<name> opens that area's panel on load (demo deep links).
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current || !s.areas.length) return;
    deepLinked.current = true;
    const want = new URLSearchParams(window.location.search).get('area')?.toLowerCase();
    const hit = want ? s.areas.find((a) => a.name.toLowerCase() === want) : undefined;
    if (hit) setSelectedArea(hit.id);
  }, [s.areas]);

  const world = s.bundle?.world;
  const hazardByArea = useMemo(
    () => new Map(world ? s.areas.map((a) => [a.id, areaHazard(world, a)]) : []),
    [world, s.areas],
  );

  const urgent = useMemo(() => s.areaViews.filter((a) => a.priority !== 'P2'), [s.areaViews]);
  const actNow = useMemo(() => urgent.filter((a) => a.verification === 'verified').sort(byUrgency), [urgent]);
  const unheard = useMemo(
    () => urgent.filter((a) => a.verification === 'needs_verification').sort(bySilence),
    [urgent],
  );
  const allUrgent = useMemo(() => [...urgent].sort(byUrgency), [urgent]);

  const selected = s.areaViews.find((a) => a.area.id === selectedArea) ?? null;
  const selectedHexes = useMemo(() => new Set(selected?.area.hexes ?? []), [selected]);

  const labels = useMemo(() => {
    const pick = selected ? [selected] : [...actNow.slice(0, 3), ...unheard.slice(0, 2)];
    return pick.map((a) => ({ id: a.area.id, name: a.area.name, lat: a.area.lat, lng: a.area.lng }));
  }, [selected, actNow, unheard]);

  // Toast + pulse whenever someone injects an event (adjuster report, SMS reply).
  const seen = useRef(s.injected.length);
  useEffect(() => {
    if (s.injected.length <= seen.current) {
      seen.current = s.injected.length;
      return;
    }
    const e = s.injected[s.injected.length - 1];
    seen.current = s.injected.length;
    const hh = s.householdById.get(e.householdId);
    if (!hh) return;
    const area = s.areaOfHex.get(hh.hex);
    const hex = s.hexById.get(hh.hex);
    setPulseHex(null);
    requestAnimationFrame(() => setPulseHex(hh.hex));
    setToast({
      key: Date.now(),
      title: `${kindTitle(e)} · ${area?.name ?? 'Unknown area'}`,
      detail: kindDetail(e),
      outcome: hex ? `→ ${hex.verification === 'verified' ? 'verified' : 'unverified'} ${hex.priority} · just now` : '',
    });
  }, [s.injected, s.householdById, s.areaOfHex, s.hexById]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(id);
  }, [toast]);

  if (!s.bundle || !world) return <div className="loading">Loading…</div>;
  const m = s.metrics;
  const legend = LAYERS.find((l) => l.id === layer)!;

  const row = (a: AreaView, reason: string) => (
    <li key={a.area.id}>
      <button className="area-row" onClick={() => setSelectedArea(a.area.id)}>
        <Chip priority={a.priority} verification={a.verification} />
        <span className="area-row-main">
          <b>{a.area.name}</b>
          <span className="muted">{reason}</span>
        </span>
        {s.assignments[a.area.id] && <span className="small muted">{s.assignments[a.area.id]}</span>}
      </button>
    </li>
  );

  return (
    <div className="manager">
      <header className="topbar">
        <div className="brand">
          <strong>Triage Loop</strong>
          <span className="muted">{world.name}</span>
          {s.source === 'mock' && <span className="pill warn">mock data</span>}
        </div>
        <div className="stats">
          <span><b>{pct(m.verifiedCoverage)}</b> verified</span>
          <span><b>{m.heldOutBrier == null ? '—' : m.heldOutBrier.toFixed(3)}</b> error</span>
          <span>trust <b>{Math.round(m.sourceTrust.hazard * 100)} · {Math.round(m.sourceTrust.sms * 100)} · {Math.round(m.sourceTrust.claims * 100)}</b></span>
        </div>
      </header>

      <div className="stage">
        <HexMap
          world={world}
          hexById={s.hexById}
          layer={layer}
          selectedHexes={selectedHexes}
          labels={labels}
          pulseHex={pulseHex}
          onSelectHex={(hex) => setSelectedArea(s.areaOfHex.get(hex)?.id ?? null)}
          padRight={400}
        />

        <div className="overlay top-left">
          <div className="segmented" role="group" aria-label="Map layer">
            {LAYERS.map((l) => (
              <button key={l.id} className={layer === l.id ? 'on' : ''} aria-pressed={layer === l.id} onClick={() => setLayer(l.id)}>
                {l.label}
              </button>
            ))}
          </div>
          {toast && (
            <div className="toast" key={toast.key} role="status">
              <span className="dot" />
              <span><b>{toast.title}</b> · {toast.detail}</span>
              <span className="muted">{toast.outcome}</span>
            </div>
          )}
        </div>

        <div className="overlay bottom-left legend">
          {layer === 'fused' ? (
            <>
              {(['P0', 'P1', 'P2'] as const).map((p) => (
                <span key={p}><i style={{ background: PRIORITY_COLOR[p], opacity: p === 'P2' ? 0.4 : 1 }} />{p} {PRIORITY_LABEL[p]}</span>
              ))}
              <span><i className="hatch-swatch" />unverified</span>
            </>
          ) : (
            <div className="ramp">
              <b>{legend.legend}</b>
              <span>low <i /> high</span>
            </div>
          )}
        </div>

        {selected ? (
          <div className="overlay right">
            <AreaDetail view={selected} onClose={() => setSelectedArea(null)} />
          </div>
        ) : (
          <div className="overlay right">
            <aside className="card nextup">
              {showAll ? (
                <>
                  <div className="nextup-head">
                    <h3 className="eyebrow">All urgent areas · {allUrgent.length}</h3>
                    <button className="link muted" onClick={() => setShowAll(false)}>Back</button>
                  </div>
                  <ul className="area-list scroll">
                    {allUrgent.map((a) => row(a, a.verification === 'verified' ? actReason(a, hazardByArea.get(a.area.id)!) : silentReason(a, hazardByArea.get(a.area.id)!)))}
                  </ul>
                </>
              ) : (
                <>
                  <h3 className="eyebrow">Next up</h3>
                  {actNow.length === 0 && unheard.length === 0 && (
                    <p className="muted empty">Nothing urgent yet. Press Start.</p>
                  )}
                  <ul className="area-list">{actNow.slice(0, 3).map((a) => row(a, actReason(a, hazardByArea.get(a.area.id)!)))}</ul>
                  {unheard.length > 0 && (
                    <>
                      <div className="rule" />
                      <h3 className="eyebrow">Haven't heard from</h3>
                      <ul className="area-list">{unheard.slice(0, 2).map((a) => row(a, silentReason(a, hazardByArea.get(a.area.id)!)))}</ul>
                    </>
                  )}
                  {allUrgent.length > 0 && (
                    <button className="see-all" onClick={() => setShowAll(true)}>See all {allUrgent.length} areas</button>
                  )}
                </>
              )}
            </aside>
            {!selected && <QrCard />}
          </div>
        )}
      </div>

      <Timeline />
    </div>
  );
}

function kindTitle(e: SimEvent): string {
  switch (e.kind) {
    case 'field_report': return 'Field report';
    case 'sms_reply': return e.safety === 'needs_help' ? 'HELP reply' : 'SMS reply';
    case 'claim': return 'Claim';
    case 'sms_sent': return 'SMS sent';
  }
}

function kindDetail(e: SimEvent): string {
  switch (e.kind) {
    case 'field_report': return `${DAMAGE_LABEL[e.damage].toLowerCase()} damage, ${e.safety.replace('_', ' ')}`;
    case 'sms_reply': return `damage ${e.damage}`;
    case 'claim': return `${e.peril}, damage ${e.reportedDamage}`;
    case 'sms_sent': return '';
  }
}
