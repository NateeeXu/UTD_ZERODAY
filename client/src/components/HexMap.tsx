import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { cellToBoundary, cellToLatLng } from 'h3-js';
import type { HexId, World } from '@shared/types';
import type { HexView } from '../engine/placeholderEstimate';
import { PATTERN_DEFS, paintFused, paintSea, seaClass, type HexPaint, type SeaMode, type VariantId } from './hexStyle';

export type Layer = 'fused' | 'hazard' | 'silence' | 'claims';

interface Props {
  world: World;
  hexById: Map<HexId, HexView>;
  layer: Layer;
  selectedHexes?: Set<HexId>;
  labels?: { id: string; name: string; lat: number; lng: number }[];
  pulseHex?: HexId | null;
  onSelectHex?: (hex: HexId) => void;
  padRight?: number;        // px hidden behind the floating card, for fitBounds
  variant?: VariantId;
  land?: Map<HexId, number> | null;
  sea?: SeaMode;
}

interface HexLayers {
  base: L.Polygon;
  overlay: L.Polygon;
  inset: L.Polygon;
}

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const EMPTY = new Set<HexId>();

function layerValue(h: HexView, layer: Layer): number {
  if (layer === 'hazard') return h.hazard;
  if (layer === 'silence') return h.silence;
  return h.claimsGap;
}

function shrink(ring: [number, number][], hex: HexId, k: number): [number, number][] {
  const [clat, clng] = cellToLatLng(hex);
  return ring.map(([lat, lng]) => [clat + (lat - clat) * k, clng + (lng - clng) * k]);
}

// Leaflet is driven imperatively: polygons are created once per world and
// restyled when estimates change, so replay ticks stay cheap.
export function HexMap({
  world, hexById, layer, selectedHexes = EMPTY, labels, pulseHex, onSelectHex, padRight = 24,
  variant = '0', land = null, sea = 'faint',
}: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const group = useRef<L.FeatureGroup | null>(null);
  const layers = useRef(new Map<string, HexLayers>());
  const labelGroup = useRef<L.LayerGroup | null>(null);
  const selectionGroup = useRef<L.LayerGroup | null>(null);
  const onSelectRef = useRef(onSelectHex);
  onSelectRef.current = onSelectHex;

  useEffect(() => {
    if (!el.current) return;
    // No zoom buttons: they'd sit under the floating cards; scroll/pinch still zoom.
    const m = L.map(el.current, { zoomControl: false, attributionControl: true, zoomSnap: 0.25 });
    // Keyless light-grey basemap (Esri Canvas) + its label layer on top.
    L.tileLayer(`${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
      attribution: 'Tiles &copy; Esri',
      maxZoom: 16,
    }).addTo(m);
    m.createPane('labels');
    m.getPane('labels')!.style.zIndex = '450';
    m.getPane('labels')!.style.pointerEvents = 'none';
    L.tileLayer(`${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, {
      pane: 'labels',
      maxZoom: 16,
      opacity: 0.7,
    }).addTo(m);

    const g = L.featureGroup().addTo(m);
    for (const cell of world.hexes) {
      const ring = cellToBoundary(cell.hex) as [number, number][];
      const base = L.polygon(ring, { weight: 1, color: '#ffffff', fillOpacity: 0.1 });
      const overlay = L.polygon(ring, { stroke: false, fillOpacity: 1, interactive: false });
      const inset = L.polygon(shrink(ring, cell.hex, 0.78), { fill: false, interactive: false });
      base.on('click', () => onSelectRef.current?.(cell.hex));
      base.addTo(g);
      layers.current.set(cell.hex, { base, overlay, inset });
    }
    group.current = g;
    // Selection outlines get their own pane so neighbouring hexes can't paint over them.
    m.createPane('selection');
    m.getPane('selection')!.style.zIndex = '420';
    m.getPane('selection')!.style.pointerEvents = 'none';
    selectionGroup.current = L.layerGroup().addTo(m);
    labelGroup.current = L.layerGroup().addTo(m);
    m.fitBounds(g.getBounds(), { paddingTopLeft: [24, 24], paddingBottomRight: [padRight, 24] });
    map.current = m;
    return () => {
      m.remove();
      layers.current.clear();
      map.current = null;
    };
    // padRight only matters for the initial fit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);

  // Restyle on estimate / layer / variant / sea mask change.
  useEffect(() => {
    const m = map.current;
    const g = group.current;
    if (!m || !g) return;
    const toggle = (layerObj: L.Polygon, opts: L.PathOptions | null, front: boolean) => {
      if (opts) {
        layerObj.setStyle(opts);
        if (!m.hasLayer(layerObj)) layerObj.addTo(m);
        if (front) layerObj.bringToFront();
      } else if (m.hasLayer(layerObj)) {
        layerObj.remove();
      }
    };
    for (const [id, l] of layers.current) {
      const h = hexById.get(id);
      if (!h) continue;
      const where = variant === '0' ? 'land' : seaClass(land?.get(id));
      const dim = where === 'coast' ? 0.5 : 1;
      let paint: HexPaint;
      if (where === 'sea') {
        paint = paintSea(sea);
      } else if (layer === 'fused') {
        paint = paintFused(h, variant, dim);
      } else {
        paint = {
          base: { color: '#ffffff', weight: 1, opacity: 0.9 * dim, fillColor: '#111111', fillOpacity: (0.04 + 0.66 * layerValue(h, layer)) * dim },
          overlay: null,
          inset: null,
        };
      }
      const hidden = where === 'sea' && sea === 'hide';
      if (hidden && g.hasLayer(l.base)) g.removeLayer(l.base);
      if (!hidden && !g.hasLayer(l.base)) g.addLayer(l.base);
      l.base.setStyle(paint.base);
      toggle(l.overlay, hidden ? null : paint.overlay, true);
      toggle(l.inset, hidden ? null : paint.inset, true);
    }
  }, [hexById, layer, variant, land, sea]);

  useEffect(() => {
    const g = selectionGroup.current;
    if (!g) return;
    g.clearLayers();
    for (const id of selectedHexes) {
      L.polygon(cellToBoundary(id) as [number, number][], {
        pane: 'selection', fill: false, color: '#111111', weight: 2.5, interactive: false,
      }).addTo(g);
    }
  }, [selectedHexes]);

  // Area name labels.
  useEffect(() => {
    const g = labelGroup.current;
    if (!g) return;
    g.clearLayers();
    for (const lb of labels ?? []) {
      L.marker([lb.lat, lb.lng], {
        interactive: false,
        icon: L.divIcon({ className: 'area-label', html: `<span>${lb.name}</span>`, iconSize: undefined }),
      }).addTo(g);
    }
  }, [labels]);

  // Pulse rings where a new report landed.
  useEffect(() => {
    const m = map.current;
    if (!m || !pulseHex) return;
    const [lat, lng] = cellToLatLng(pulseHex);
    const mk = L.marker([lat, lng], {
      interactive: false,
      icon: L.divIcon({ className: 'pulse', html: '<i></i><i></i>', iconSize: [0, 0] }),
    }).addTo(m);
    const id = setTimeout(() => mk.remove(), 4500);
    return () => {
      clearTimeout(id);
      mk.remove();
    };
  }, [pulseHex]);

  return <div ref={el} className="map" />;
}

// SVG patterns referenced by url(#id) from hex fills. Render once per page.
export function MapPatterns() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <defs>
        <pattern id="hatch-light" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.75)" strokeWidth="2" />
        </pattern>
        <pattern id="hatch-dark" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(0,0,0,0.45)" strokeWidth="1.5" />
        </pattern>
        {PATTERN_DEFS.map((p) =>
          p.kind === 'line' ? (
            <pattern key={p.id} id={p.id} width={p.size} height={p.size} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2={p.size} stroke={p.stroke} strokeOpacity={p.opacity} strokeWidth={p.width} />
            </pattern>
          ) : (
            <pattern key={p.id} id={p.id} width={p.size} height={p.size} patternUnits="userSpaceOnUse">
              <circle cx={p.size / 2} cy={p.size / 2} r={p.width} fill={p.stroke} fillOpacity={p.opacity} />
            </pattern>
          ),
        )}
      </defs>
    </svg>
  );
}
