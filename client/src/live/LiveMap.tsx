import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { cellToBoundary, cellToLatLng } from 'h3-js';
import type { FacilityRow, HexStatsRow } from './rows';
import type { HazardGeometry } from '@shared/types';
import { COLOR, LOD_ZOOM, cellSetKey, intensity, pulsingCells, tooltipHtml, unitsFor, type MapMode, type MapUnit } from './mapModel';
import { hazardLabel } from './hazard';
import { addBasemap } from '../basemap';

// The hazard is drawn in slate so it never reads as a priority colour (red / orange / yellow).
const HAZARD_FILL = '#3b5b8c';
const HAZARD_INK = '#1e2a3a';
export type FitTarget = { target: 'cells' | 'cone'; n: number };

type FacilityKind = 'school' | 'university' | 'hospital';
// Letter badges so the kind reads without hovering: H = hospital (green square), S = school and
// U = university (blue circles). Same look as FacilityKey in the toggle chip.
export const FACILITY_GLYPH: Record<FacilityKind, string> = { hospital: 'H', school: 'S', university: 'U' };
function facilityIcon(kind: FacilityKind): L.DivIcon {
  const size = kind === 'university' ? 20 : 16;
  return L.divIcon({
    className: `fac-icon fac-${kind}`,
    html: FACILITY_GLYPH[kind],
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

interface Props {
  cells: readonly HexStatsRow[];
  facilities: readonly FacilityRow[];
  showFacilities: boolean;
  labelFor: (u: MapUnit) => string;
  selected: string | null;              // res-8 hex or res-7 district id
  onSelect: (unit: MapUnit) => void;
  flash: { hex: string; key: number } | null; // a fresh live event landed here
  fitKey: string;                       // refit when this changes (region switch, new world)
  padRight?: number;
  padLeft?: number;                     // px covered by the left rail, for fitBounds
  onResChange?: (res: 7 | 8) => void;
  mode?: MapMode;
  hazard?: HazardGeometry | null;       // the disaster itself (world.hazardGeometryJson)
  fitTo?: FitTarget | null;             // explicit fit request: forecast cone, or back to the cells
}

// Leaflet internals used for smooth wheel zoom (same calls its own pinch-zoom handler makes).
type MapInternals = L.Map & {
  _move(center: L.LatLng, zoom: number): void;
  _moveStart(zoomChanged: boolean, noMoveStart: boolean): void;
  _moveEnd(zoomChanged: boolean): void;
  _stop(): void;
};

// Smooth wheel / trackpad zoom. Leaflet's built-in wheel zoom jumps in steps; this eases the zoom
// toward a goal every frame and keeps the point under the cursor still.
function smoothWheelZoom(m: L.Map): () => void {
  const map = m as MapInternals;
  const box = map.getContainer();
  let goal = 0;
  let raf = 0;
  let timer = 0;
  let active = false;
  let finishing = false;
  let pt = L.point(0, 0);
  let at = L.latLng(0, 0);

  const finish = () => {
    active = false;
    finishing = false;
    map._moveEnd(true);
  };
  const frame = () => {
    const z = map.getZoom();
    const next = Math.abs(goal - z) < 0.003 ? goal : z + (goal - z) * 0.28;
    const offset = pt.subtract(map.getSize().divideBy(2));
    map._move(map.unproject(map.project(at, next).subtract(offset), next), next);
    if (next !== goal) raf = requestAnimationFrame(frame);
    else {
      raf = 0;
      if (finishing) finish();
    }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    if (!px) return;
    if (!active) {
      map._stop();
      active = true;
      goal = map.getZoom();
      map._moveStart(true, false);
    }
    finishing = false;
    pt = map.mouseEventToContainerPoint(e);
    at = map.containerPointToLatLng(pt);
    // Pinch on a trackpad arrives as ctrl+wheel with small deltas.
    goal = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), goal - px * (e.ctrlKey ? 0.01 : 0.004)));
    if (!raf) raf = requestAnimationFrame(frame);
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (raf) finishing = true;
      else if (active) finish();
    }, 160);
  };
  box.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    box.removeEventListener('wheel', onWheel);
    cancelAnimationFrame(raf);
    clearTimeout(timer);
  };
}

export function LiveMap({ cells, facilities, showFacilities, labelFor, selected, onSelect, flash, fitKey, padRight = 24, padLeft = 24, onResChange, mode = 'priority', hazard = null, fitTo = null }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const groups = useRef<{ cells: L.LayerGroup; rings: L.LayerGroup; sel: L.LayerGroup; fac: L.LayerGroup; hazard: L.LayerGroup } | null>(null);
  const lastFitN = useRef(0);
  // Polygons are kept and restyled in place; rebuilt only when the level of detail changes.
  const polys = useRef<{ res: 7 | 8; byId: Map<string, { poly: L.Polygon; shape: MapUnit['shape'] }> } | null>(null);
  const unitById = useRef(new Map<string, MapUnit>());
  const ringKey = useRef('');
  const fitted = useRef<{ key: string; cells: string } | null>(null);
  const touched = useRef(false); // the user moved the map since the last automatic fit
  const [zoom, setZoom] = useState(0);
  const cb = useRef({ onSelect, labelFor, onResChange });
  cb.current = { onSelect, labelFor, onResChange };

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { zoomControl: false, zoomSnap: 0.25, scrollWheelZoom: false });
    L.control.zoom({ position: 'bottomleft' }).addTo(m);
    addBasemap(m, { keepBuffer: 4 }); // base tiles + a 'labels' pane (450) above the cells
    // Hazard panes: the forecast cone under the cells (overlayPane is 400), track / markers / label above
    // them. Neither takes clicks, so cells stay selectable through the hazard.
    for (const [name, z] of [['hazardBelow', '350'], ['hazardAbove', '455']] as const) {
      m.createPane(name);
      m.getPane(name)!.style.zIndex = z;
      m.getPane(name)!.style.pointerEvents = 'none';
    }
    groups.current = {
      cells: L.layerGroup().addTo(m),
      rings: L.layerGroup().addTo(m),
      sel: L.layerGroup().addTo(m),
      fac: L.layerGroup(),
      hazard: L.layerGroup().addTo(m),
    };
    const stopWheel = smoothWheelZoom(m);
    m.on('zoomend', () => setZoom(m.getZoom()));
    const box = m.getContainer();
    const touch = () => { touched.current = true; };
    box.addEventListener('pointerdown', touch);
    box.addEventListener('wheel', touch, { passive: true });
    box.addEventListener('keydown', touch);
    map.current = m;
    return () => {
      stopWheel();
      box.removeEventListener('pointerdown', touch);
      box.removeEventListener('wheel', touch);
      box.removeEventListener('keydown', touch);
      m.remove();
      map.current = null;
      fitted.current = null;
      polys.current = null;
      ringKey.current = '';
    };
  }, []);

  // Fit when a region or world first shows cells. While its cell set keeps changing (a new disaster
  // is seeded in batches), refit until the user moves the map themselves.
  const setKey = useMemo(() => cellSetKey(cells), [cells]);
  useEffect(() => {
    const m = map.current;
    if (!m || !cells.length) return;
    const f = fitted.current;
    const sameKey = f !== null && f.key === fitKey;
    if (f !== null && sameKey && (f.cells === setKey || touched.current)) return;
    if (!sameKey) touched.current = false;
    const b = L.latLngBounds(cells.flatMap((c) => cellToBoundary(c.hex) as [number, number][]));
    m.invalidateSize();
    m.fitBounds(b, { paddingTopLeft: [padLeft, 24], paddingBottomRight: [padRight, 24], animate: false });
    fitted.current = { key: fitKey, cells: setKey };
    setZoom(m.getZoom());
  }, [cells, setKey, fitKey, padRight, padLeft]);

  const ready = zoom > 0;
  const res: 7 | 8 = zoom < LOD_ZOOM ? 7 : 8;
  useEffect(() => cb.current.onResChange?.(res), [res]);
  const units = useMemo(() => (ready ? unitsFor(cells, res) : []), [cells, res, ready]);

  // Cells / districts, colored by priority, opacity by confidence (style A). Restyled in place on
  // every data tick (no redraw), so zooming and the running replay stay smooth.
  useEffect(() => {
    const g = groups.current;
    if (!g || !ready) return;
    let cur = polys.current;
    if (!cur || cur.res !== res) {
      g.cells.clearLayers();
      cur = polys.current = { res, byId: new Map() };
    }
    unitById.current = new Map(units.map((u) => [u.id, u]));
    for (const u of units) {
      const color = COLOR[u.p];
      const k = intensity(u, mode);
      const style = { color, weight: res === 7 ? 1 : 0.6, opacity: 0.35 + 0.5 * k, fillColor: color, fillOpacity: 0.12 + 0.73 * k };
      const have = cur.byId.get(u.id);
      if (!have) {
        const id = u.id;
        const poly = L.polygon(u.shape as L.LatLngExpression[][], style);
        // Tooltip text is built when it opens, from the latest data.
        poly.bindTooltip(() => {
          const now = unitById.current.get(id);
          return now ? tooltipHtml(now, cb.current.labelFor(now)) : '';
        }, { sticky: true, className: 'tip' });
        poly.on('click', () => {
          const now = unitById.current.get(id);
          if (now) cb.current.onSelect(now);
        });
        poly.addTo(g.cells);
        cur.byId.set(id, { poly, shape: u.shape });
        continue;
      }
      // Cached geometry is shared by reference, so a new object means a different child set.
      if (have.shape !== u.shape) {
        have.poly.setLatLngs(u.shape as L.LatLngExpression[][]);
        have.shape = u.shape;
      }
      have.poly.setStyle(style);
      const tip = have.poly.getTooltip();
      if (tip?.isOpen()) tip.update();
    }
    for (const [id, have] of cur.byId) {
      if (!unitById.current.has(id)) {
        have.poly.remove();
        cur.byId.delete(id);
      }
    }
  }, [units, res, mode, ready]);

  // Pulse rings (style C) on the most urgent silent cells; rebuilt only when that set changes so
  // the animation does not restart every tick.
  useEffect(() => {
    const g = groups.current;
    if (!g || !ready) return;
    const top = pulsingCells(cells);
    const ringed = units.filter((u) => u.kids.some((k) => top.has(k.hex)));
    const key = `${res}|${ringed.map((u) => u.id).sort().join(',')}`;
    if (key === ringKey.current) return;
    ringKey.current = key;
    g.rings.clearLayers();
    for (const u of ringed) {
      L.polygon(u.shape as L.LatLngExpression[][], { color: COLOR.P0, weight: 2.5, fill: false, interactive: false, className: 'pulse-ring' }).addTo(g.rings);
      L.polygon(u.shape as L.LatLngExpression[][], { color: '#7a1714', weight: 1.6, fill: false, interactive: false }).addTo(g.rings);
    }
  }, [units, cells, res, ready]);

  // Selection outline.
  const selUnit = useMemo(
    () => (selected ? units.find((u) => u.id === selected || u.kids.some((k) => k.hex === selected)) ?? null : null),
    [units, selected],
  );
  const selId = selUnit?.id ?? null;
  useEffect(() => {
    const g = groups.current;
    if (!g) return;
    g.sel.clearLayers();
    const u = selId ? unitById.current.get(selId) : null;
    if (u) {
      // White halo under a heavy black line, so the selection reads clearly next to the red pulse rings.
      L.polygon(u.shape as L.LatLngExpression[][], { color: '#ffffff', weight: 6.5, opacity: 0.95, fill: false, interactive: false, lineJoin: 'round' }).addTo(g.sel);
      L.polygon(u.shape as L.LatLngExpression[][], { color: '#111111', weight: 3, fill: false, interactive: false, lineJoin: 'round' }).addTo(g.sel);
    }
  }, [selId, res]);

  // The disaster itself. Redrawn whenever the world's hazard changes (a new disaster also remounts the map).
  useEffect(() => {
    const g = groups.current;
    if (!g) return;
    g.hazard.clearLayers();
    if (!hazard) return;
    const ll = (p: { lat: number; lng: number }): [number, number] => [p.lat, p.lng];
    const below = { pane: 'hazardBelow', interactive: false };
    const above = { pane: 'hazardAbove', interactive: false };
    let at: [number, number];
    if (hazard.kind === 'hurricane') {
      if (hazard.cone.polygon.length >= 3) {
        L.polygon(hazard.cone.polygon.map(ll), { ...below, color: HAZARD_FILL, weight: 1, opacity: 0.6, fillColor: HAZARD_FILL, fillOpacity: 0.09 }).addTo(g.hazard);
      }
      if (hazard.track.length >= 2) {
        L.polyline(hazard.track.map(ll), { ...above, color: HAZARD_INK, weight: 2, opacity: 0.85, dashArray: '6 6' }).addTo(g.hazard);
      }
      // track[0]: where the storm was when the forecast was issued (hollow); landfall (solid).
      if (hazard.track.length) {
        L.circleMarker(ll(hazard.track[0]), { ...above, radius: 5, color: HAZARD_INK, weight: 2, fillColor: '#ffffff', fillOpacity: 1 }).addTo(g.hazard);
      }
      L.circleMarker(ll(hazard.landfall), { ...above, radius: 6, color: '#ffffff', weight: 2, fillColor: HAZARD_INK, fillOpacity: 1 }).addTo(g.hazard);
      at = ll(hazard.landfall);
    } else {
      if (hazard.rupture) {
        L.polyline(hazard.rupture.map(ll), { ...above, color: HAZARD_INK, weight: 4, opacity: 0.85, lineCap: 'round' }).addTo(g.hazard);
      }
      L.circleMarker(ll(hazard.epicenter), { ...above, radius: 11, color: HAZARD_INK, weight: 1.5, fill: false }).addTo(g.hazard);
      L.circleMarker(ll(hazard.epicenter), { ...above, radius: 5, color: '#ffffff', weight: 2, fillColor: HAZARD_INK, fillOpacity: 1 }).addTo(g.hazard);
      at = ll(hazard.epicenter);
    }
    const text = hazardLabel(hazard);
    const tag = document.createElement('span'); // textContent: the fault name comes from data, never parsed as HTML
    tag.textContent = text;
    tag.title = text;
    L.marker(at, {
      pane: 'hazardAbove', interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'hazard-label', html: tag, iconSize: [0, 0], iconAnchor: [-14, 11] }),
    }).addTo(g.hazard);
  }, [hazard]);

  // "Show forecast cone" / "Back to affected areas": one fit per request.
  useEffect(() => {
    const m = map.current;
    if (!m || !fitTo || fitTo.n === lastFitN.current) return;
    lastFitN.current = fitTo.n;
    const pts: [number, number][] = fitTo.target === 'cone' && hazard?.kind === 'hurricane'
      ? hazard.cone.polygon.map((p) => [p.lat, p.lng])
      : cells.flatMap((c) => cellToBoundary(c.hex) as [number, number][]);
    if (pts.length < 2) return;
    touched.current = true; // a chosen view: don't snap back to the cells while they stream in
    m.flyToBounds(L.latLngBounds(pts), { paddingTopLeft: [padLeft, 24], paddingBottomRight: [padRight, 24], duration: 0.6 });
  }, [fitTo, hazard, cells, padLeft, padRight]);

  // Schools / universities / hospitals.
  useEffect(() => {
    const m = map.current;
    const g = groups.current;
    if (!m || !g) return;
    g.fac.clearLayers();
    // Schools, universities and hospitals only (the table also has fire stations, shelters, masts).
    // Drawn as markers (markerPane, z 600), so they always sit above the hexes even after the cells
    // are rebuilt on a zoom level-of-detail change.
    for (const f of facilities.filter((x) => x.kind === 'school' || x.kind === 'university' || x.kind === 'hospital')) {
      const kind = f.kind as FacilityKind;
      const what = kind === 'hospital' ? 'Hospital' : kind === 'university' ? 'University' : 'School';
      const tip = document.createElement('span'); // textContent: names come from data, never parsed as HTML
      tip.textContent = `${what} · ${f.name}${f.enrollment != null ? ` · ${f.enrollment.toLocaleString()} students` : ''}`;
      L.marker([f.lat, f.lng], { icon: facilityIcon(kind), keyboard: false, title: '' })
        .bindTooltip(tip, { direction: 'top', offset: [0, -8] })
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

/** Toggle-chip label that doubles as the map key for the facility icons. */
export function FacilityKey() {
  const badge = (k: FacilityKind) => <i className={`fac-icon fac-${k}`} aria-hidden>{FACILITY_GLYPH[k]}</i>;
  return (
    <span className="fac-key">
      {badge('school')}{badge('university')} Schools &amp; universities · {badge('hospital')} Hospitals
    </span>
  );
}
