// #/lab: side-by-side map style variants on the same data and moment.
import { useState } from 'react';
import type { Priority, Verification } from '@shared/types';
import type { HexView } from '../engine/placeholderEstimate';
import { HexMap } from '../components/HexMap';
import { VARIANTS, paintFused, type SeaMode, type VariantId } from '../components/hexStyle';
import { useLandFraction } from '../data/landMask';
import { useTriage } from '../state/TriageStore';
import { fmtT } from '../format';

export function LabView() {
  const s = useTriage();
  const [sea, setSea] = useState<SeaMode>('faint');
  const land = useLandFraction(s.bundle?.world);
  if (!s.bundle) return <div className="loading">Loading…</div>;

  const seaCount = land ? [...land.values()].filter((v) => v < 0.15).length : null;
  const coastCount = land ? [...land.values()].filter((v) => v >= 0.15 && v < 0.6).length : null;

  return (
    <div className="lab">
      <header className="lab-head">
        <div>
          <strong>Map style lab</strong>
          <span className="muted"> · {fmtT(s.t)} · same data in every panel</span>
        </div>
        <div className="lab-controls">
          <span className="muted small">
            {land ? `${seaCount} sea hexes, ${coastCount} coastal (dimmed)` : 'Measuring coastline…'}
          </span>
          <div className="segmented" role="group" aria-label="Sea hexes">
            {(['faint', 'hide'] as SeaMode[]).map((m) => (
              <button key={m} className={sea === m ? 'on' : ''} aria-pressed={sea === m} onClick={() => setSea(m)}>
                Sea: {m === 'faint' ? 'faint outline' : 'hidden'}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className="lab-grid">
        {VARIANTS.map((v) => (
          <section key={v.id} className="lab-cell">
            <div className="lab-cap">
              <div className="lab-title"><b>{v.id === '0' ? 'Current' : `${v.id} · ${v.name}`}</b></div>
              <p className="muted small">{v.blurb}</p>
              <div className="lab-swatches">
                <Swatch v={v.id} p="P0" ver="verified" label="P0" />
                <Swatch v={v.id} p="P0" ver="needs_verification" label="P0 unverified" />
                <Swatch v={v.id} p="P1" ver="verified" label="P1" />
                <Swatch v={v.id} p="P1" ver="needs_verification" label="P1 unverified" />
              </div>
            </div>
            <div className="lab-map">
              <HexMap world={s.bundle!.world} hexById={s.hexById} layer="fused" variant={v.id} land={land} sea={sea} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function Swatch({ v, p, ver, label }: { v: VariantId; p: Priority; ver: Verification; label: string }) {
  const paint = paintFused({ priority: p, verification: ver } as HexView, v, 1);
  const b = paint.base;
  return (
    <span className="swatch">
      <svg width="30" height="20" aria-hidden>
        <rect width="30" height="20" fill="#ececec" />
        <rect width="30" height="20" fill={b.fillColor} fillOpacity={b.fillOpacity} />
        {paint.overlay && <rect width="30" height="20" fill={paint.overlay.fillColor} />}
        {paint.inset && <rect x="4" y="4" width="22" height="12" fill="none" stroke={paint.inset.color} strokeWidth={paint.inset.weight} />}
      </svg>
      {label}
    </span>
  );
}
