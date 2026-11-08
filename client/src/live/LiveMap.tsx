import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { cellToBoundary, cellToLatLng } from 'h3-js';
import type { FacilityRow, HexStatsRow } from './rows';
import { COLOR, LOD_ZOOM, pulsingCells, tooltipHtml, unitsFor, type MapUnit } from './mapModel';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';

interface Props {
  cells: readonly HexStatsRow[];
  facilities: readonly FacilityRow[];
  showFacilities: boolean;
  labelFor: (u: MapUnit) => string;
  selected: string | null;              // res-8 hex or res-7 district id
  onSelect: (unit: MapUnit) => void;
  flash: { hex: string; key: number } | null; // a fresh live event landed here
  fitKey: string;                       // refit when this changes (region switch)
  padRight?: number;
  onResChange?: (res: 7 | 8) => void;
}

export function LiveMap({ cells, facilities, showFacilities, labelFor, selected, onSelect, flash, fitKey, padRight = 24, onResChange }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const groups = useRef<{ cells: L.LayerGroup; rings: L.LayerGroup; sel: L.LayerGroup; fac: L.LayerGroup } | null>(null);
  const fitted = useRef<string | null>(null);
  const [zoom, setZoom] = useState(0);
  const cb = useRef({ onSelect, labelFor, onResChange });
  cb.current = { onSelect, labelFor, onResChange };

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { zoomControl: false, zoomSnap: 0.25 });
    L.control.zoom({ position: 'bottomleft' }).addTo(m);
    L.tileLayer(`${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
      attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors',
      maxZoom: 16,
    }).addTo(m);
    m.createPane('labels');
    m.getPane('labels')!.style.zIndex = '450';
    m.getPane('labels')!.style.pointerEvents = 'none';
    L.tileLayer(`${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16, pane: 'labels' }).addTo(m);
    groups.current = {
      cells: L.layerGroup().addTo(m),
      rings: L.layerGroup().addTo(m),
      sel: L.layerGroup().addTo(m),
      fac: L.layerGroup(),
    };
    m.on('zoomend', () => setZoom(m.getZoom()));
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      fitted.current = null;
    };
  }, []);

  // Fit once per region when its cells first arrive.
  useEffect(() => {
    const m = map.current;
    if (!m || !cells.length || fitted.current === fitKey) return;
    const b = L.latLngBounds(cells.flatMap((c) => cellToBoundary(c.hex) as [number, number][]));
    m.invalidateSize();
    m.fitBounds(b, { paddingTopLeft: [24, 24], paddingBottomRight: [padRight, 24], animate: false });
    fitted.current = fitKey;
    setZoom(m.getZoom());
  }, [cells, fitKey, padRight]);

  const res: 7 | 8 = zoom < LOD_ZOOM ? 7 : 8;
  useEffect(() => cb.current.onResChange?.(res), [res]);

  // Cells / districts, colored by priority, opacity by confidence (style A), pulse rings (style C).
  useEffect(() => {
    const g = groups.current;
    if (!g || !zoom) return;
    g.cells.clearLayers();
    g.rings.clearLayers();
    g.sel.clearLayers();
    const topKids = pulsingCells(cells);
    for (const u of unitsFor(cells, res)) {
      const color = COLOR[u.p];
      const poly = L.polygon(u.shape as L.LatLngExpression[][], {
        color,
        weight: res === 7 ? 1 : 0.6,
        opacity: 0.35 + 0.5 * u.c,
        fillColor: color,
        fillOpacity: 0.12 + 0.73 * u.c,
      });
      poly.bindTooltip(tooltipHtml(u, cb.current.labelFor(u)), { sticky: true, className: 'tip' });
      poly.on('click', () => cb.current.onSelect(u));
      poly.addTo(g.cells);
      if (u.kids.some((k) => topKids.has(k.hex))) {
        L.polygon(u.shape as L.LatLngExpression[][], { color: COLOR.P0, weight: 2.5, fill: false, interactive: false, className: 'pulse-ring' }).addTo(g.rings);
        L.polygon(u.shape as L.LatLngExpression[][], { color: '#7a1714', weight: 1.6, fill: false, interactive: false }).addTo(g.rings);
      }
      if (selected && (u.id === selected || u.kids.some((k) => k.hex === selected))) {
        L.polygon(u.shape as L.LatLngExpression[][], { color: '#111111', weight: 2.5, fill: false, interactive: false }).addTo(g.sel);
      }
    }
  }, [cells, res, zoom, selected, labelFor]); // labelFor: rebuild tooltips when names change (e.g. world row arrives)

  // Schools / universities / hospitals.
  useEffect(() => {
    const m = map.current;
    const g = groups.current;
    if (!m || !g) return;
    g.fac.clearLayers();
    for (const f of facilities) {
      const school = f.kind !== 'hospital';
      L.circleMarker([f.lat, f.lng], {
        radius: f.kind === 'university' ? 5 : 3,
        color: school ? '#2b5fb4' : '#0f7a55',
        weight: 1.5,
        fillColor: '#fff',
        fillOpacity: 1,
      })
        .bindTooltip(`${f.name}${f.enrollment != null ? ` · ${f.enrollment.toLocaleString()} students` : ''}`, { direction: 'top' })
        .addTo(g.fac);
    }
    if (showFacilities) g.fac.addTo(m);
    else g.fac.remove();
  }, [facilities, showFacilities]);

  // Short black pulse where a live event (SMS reply / field report) just landed.
  useEffect(() => {
    const m = map.current;
    if (!m || !flash) return;
    const [lat, lng] = cellToLatLng(flash.hex);
    const mk = L.marker([lat, lng], {
      interactive: false,
      icon: L.divIcon({ className: 'pulse', html: '<i></i><i></i>', iconSize: [0, 0] }),
    }).addTo(m);
    const id = setTimeout(() => mk.remove(), 4500);
    return () => {
      clearTimeout(id);
      mk.remove();
    };
  }, [flash]);

  return <div ref={el} className="map" />;
}
