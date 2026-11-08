import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MultiPolygon } from 'polygon-clipping';
import type { Region } from './buildRegion';
import { addBasemap } from '../basemap';

// [lng, lat] MultiPolygon → Leaflet [lat, lng] nesting.
const toLeaflet = (mp: MultiPolygon) => mp.map((poly) => poly.map((ring) => ring.map(([lng, lat]) => [lat, lng] as [number, number])));

export interface RegionMapOptions {
  showFootprint: boolean;   // raw hazard contour before the coastline cut
  showClipped: boolean;     // outline the boundary cells that were clipped
  showLand: boolean;        // the Census land polygon we clip against
}

export function RegionMap({ region, opts }: { region: Region; opts: RegionMapOptions }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { zoomControl: true, zoomSnap: 0.25 });
    addBasemap(m, { labelsOpacity: 0.7 });
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const s = region.scenario;

    if (opts.showLand) {
      L.polygon(toLeaflet(s.land), { color: '#2563eb', weight: 1, opacity: 0.6, fillColor: '#2563eb', fillOpacity: 0.04, interactive: false }).addTo(g);
    }

    // Hexes: neutral ramp by how far above the threshold the hazard is.
    const vals = region.cells.map((c) => c.intensity);
    const lo = s.threshold;
    const hi = Math.max(lo + 1e-6, ...vals);
    for (const c of region.cells) {
      const t = Math.max(0, Math.min(1, (c.intensity - lo) / (hi - lo)));
      L.polygon(toLeaflet(c.geometry), {
        color: '#ffffff',
        weight: 1,
        opacity: 0.9,
        fillColor: '#111111',
        fillOpacity: 0.12 + 0.45 * t,
      })
        .bindTooltip(`${c.clipped ? 'Boundary cell (clipped)' : 'Interior cell'} · ${c.intensity.toFixed(s.unit === 'MMI' ? 1 : 0)} ${s.unit} · ${Math.round(c.areaFrac * 100)}% of a hex`, { sticky: true })
        .addTo(g);
    }
    if (opts.showClipped) {
      for (const c of region.cells.filter((x) => x.clipped)) {
        L.polygon(toLeaflet(c.geometry), { fill: false, color: '#f97316', weight: 1.5, interactive: false }).addTo(g);
      }
    }

    // Region outline = the irregular boundary (hazard contour ∩ shoreline).
    L.polygon(toLeaflet(region.region), { fill: false, color: '#111111', weight: 2, interactive: false }).addTo(g);
    if (opts.showFootprint) {
      L.polygon(toLeaflet(region.footprint), { fill: false, color: '#111111', weight: 1.5, dashArray: '5 5', opacity: 0.7, interactive: false }).addTo(g);
      for (const e of s.extra) {
        L.polyline(e.points.map(([lng, lat]) => [lat, lng] as [number, number]), { color: '#dc2626', weight: 2, dashArray: '2 6', interactive: false })
          .bindTooltip(e.label, { permanent: true, direction: 'center', className: 'extra-label' })
          .addTo(g);
      }
    }
  }, [region, opts.showClipped, opts.showFootprint, opts.showLand]);

  // Fit to the region whenever a new one is generated.
  useEffect(() => {
    const m = map.current;
    if (!m || !region.region.length) return;
    m.fitBounds(L.polygon(toLeaflet(region.region)).getBounds(), { padding: [24, 24] });
  }, [region]);

  return <div ref={el} className="map" />;
}
