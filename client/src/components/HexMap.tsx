import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { cellToBoundary, cellToLatLng } from 'h3-js';
import type { HexId, World } from '@shared/types';
import type { HexView } from '../engine/placeholderEstimate';
import { PRIORITY_COLOR } from '../format';

export type Layer = 'fused' | 'hazard' | 'silence' | 'claims';

interface Props {
  world: World;
  hexById: Map<HexId, HexView>;
  layer: Layer;
  selectedHexes: Set<HexId>;
  labels: { id: string; name: string; lat: number; lng: number }[];
  pulseHex: HexId | null;
  onSelectHex: (hex: HexId) => void;
  padRight: number; // px hidden behind the floating card, for fitBounds
}

interface HexLayers {
  fill: L.Polygon;
  hatch: L.Polygon;
}

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';

function layerValue(h: HexView, layer: Layer): number {
  if (layer === 'hazard') return h.hazard;
  if (layer === 'silence') return h.silence;
  return h.claimsGap;
}

// Leaflet is driven imperatively: polygons are created once per world and
// restyled when estimates change, so replay ticks stay cheap.
export function HexMap({ world, hexById, layer, selectedHexes, labels, pulseHex, onSelectHex, padRight }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef(new Map<string, HexLayers>());
  const labelGroup = useRef<L.LayerGroup | null>(null);
  const selectionGroup = useRef<L.LayerGroup | null>(null);
  const onSelectRef = useRef(onSelectHex);
  onSelectRef.current = onSelectHex;

  useEffect(() => {
    if (!el.current) return;
    // No zoom buttons: they'd sit under the floating cards; scroll/pinch still zoom.
    const m = L.map(el.current, { zoomControl: false, attributionControl: true });
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

    const group = L.featureGroup().addTo(m);
    for (const cell of world.hexes) {
      const ring = cellToBoundary(cell.hex) as [number, number][];
      const fill = L.polygon(ring, { weight: 1, color: '#ffffff', fillOpacity: 0.1 });
      const hatch = L.polygon(ring, { stroke: false, fillOpacity: 1, interactive: false });
      fill.on('click', () => onSelectRef.current(cell.hex));
      fill.addTo(group);
      layers.current.set(cell.hex, { fill, hatch });
    }
    // Selection outlines get their own pane so neighbouring hexes can't paint over them.
    m.createPane('selection');
    m.getPane('selection')!.style.zIndex = '420';
    m.getPane('selection')!.style.pointerEvents = 'none';
    selectionGroup.current = L.layerGroup().addTo(m);
    labelGroup.current = L.layerGroup().addTo(m);
    m.fitBounds(group.getBounds(), { paddingTopLeft: [24, 24], paddingBottomRight: [padRight, 24] });
    map.current = m;
    return () => {
      m.remove();
      layers.current.clear();
      map.current = null;
    };
    // padRight only matters for the initial fit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);

  // Restyle on estimate / layer / selection change.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const [id, l] of layers.current) {
      const h = hexById.get(id);
      if (!h) continue;
      let fillColor: string;
      let fillOpacity: number;
      if (layer === 'fused') {
        fillColor = PRIORITY_COLOR[h.priority];
        fillOpacity = h.priority === 'P0' ? 0.72 : h.priority === 'P1' ? 0.62 : 0.12;
      } else {
        fillColor = '#111111';
        fillOpacity = 0.04 + 0.76 * layerValue(h, layer);
      }
      l.fill.setStyle({ fillColor, fillOpacity, color: '#ffffff', weight: 1, opacity: 0.9 });
      const wantHatch = layer === 'fused' && h.priority !== 'P2' && h.verification === 'needs_verification';
      if (wantHatch) {
        l.hatch.setStyle({ fillColor: h.priority === 'P0' ? 'url(#hatch-light)' : 'url(#hatch-dark)' });
        if (!m.hasLayer(l.hatch)) l.hatch.addTo(m);
        l.hatch.bringToFront();
      } else if (m.hasLayer(l.hatch)) {
        l.hatch.remove();
      }
    }
  }, [hexById, layer]);

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
    for (const lb of labels) {
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

  return (
    <>
      {/* Patterns live in their own SVG; url(#id) resolves document-wide. */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
        <defs>
          <pattern id="hatch-light" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.75)" strokeWidth="2" />
          </pattern>
          <pattern id="hatch-dark" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(0,0,0,0.45)" strokeWidth="1.5" />
          </pattern>
        </defs>
      </svg>
      <div ref={el} className="map" />
    </>
  );
}
