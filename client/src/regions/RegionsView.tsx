// #/regions: irregular disaster boundaries on real geography, tiled with H3.
import { useMemo, useState } from 'react';
import { buildRegion, multiArea } from './buildRegion';
import { makeScenario, type ScenarioId } from './scenarios';
import { RegionMap, type RegionMapOptions } from './RegionMap';

const IDS: ScenarioId[] = ['sf-peninsula', 'corpus-christi'];

export function RegionsView() {
  const [seeds, setSeeds] = useState<Record<ScenarioId, number>>({ 'sf-peninsula': 1, 'corpus-christi': 1 });
  const [opts, setOpts] = useState<RegionMapOptions>({ showFootprint: true, showClipped: false, showLand: false });
  const toggle = (k: keyof RegionMapOptions) => setOpts((o) => ({ ...o, [k]: !o[k] }));

  return (
    <div className="lab">
      <header className="lab-head">
        <div>
          <strong>Disaster regions</strong>
          <span className="muted"> · synthetic hazards on real coastlines · H3 res 8</span>
        </div>
        <div className="lab-controls">
          <label className="check"><input type="checkbox" checked={opts.showFootprint} onChange={() => toggle('showFootprint')} /> Hazard contour before coastline cut</label>
          <label className="check"><input type="checkbox" checked={opts.showClipped} onChange={() => toggle('showClipped')} /> Highlight clipped boundary cells</label>
          <label className="check"><input type="checkbox" checked={opts.showLand} onChange={() => toggle('showLand')} /> Land polygon (Census)</label>
        </div>
      </header>
      <div className="regions-grid">
        {IDS.map((id) => (
          <RegionPanel key={id} id={id} seed={seeds[id]} opts={opts} onReseed={() => setSeeds((s) => ({ ...s, [id]: s[id] + 1 }))} />
        ))}
      </div>
    </div>
  );
}

function RegionPanel({ id, seed, opts, onReseed }: { id: ScenarioId; seed: number; opts: RegionMapOptions; onReseed: () => void }) {
  const region = useMemo(() => buildRegion(makeScenario(id, seed)), [id, seed]);
  const s = region.scenario;
  const lat0 = (s.bbox[1] + s.bbox[3]) / 2;
  const clipped = region.cells.filter((c) => c.clipped).length;
  return (
    <section className="lab-cell">
      <div className="lab-cap">
        <div className="region-title">
          <b>{s.name}</b>
          <span className="muted small">seed {seed}</span>
          <button className="btn" onClick={onReseed}>New random scenario</button>
        </div>
        <p className="muted small">{s.summary}</p>
        <p className="small">
          {multiArea(region.region, lat0).toFixed(0)} km² affected land · {region.cells.length} cells ({region.cells.length - clipped} whole, {clipped} clipped at the boundary) · {region.region.length} separate land piece{region.region.length === 1 ? '' : 's'}
        </p>
      </div>
      <div className="lab-map">
        <RegionMap region={region} opts={opts} />
      </div>
    </section>
  );
}
