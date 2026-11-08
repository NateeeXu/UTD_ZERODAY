// Small Leaflet map for the adjuster phone. Same basemap as the dashboard (Esri Light Gray).
// Draws areas (H3 cell outlines) with pill markers, my position, and a dashed route. Never house points:
// the households are synthetic but their coordinates fall on real streets.
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { cellToBoundary } from 'h3-js';
import { cellCenter, type LatLng } from './derive';
import { addBasemap } from '../../basemap';

export interface MapArea {
  hex: string;
  color: string;
  label?: string;
  pill?: 'dark' | 'light' | 'done';
}

export function PhoneMap({ areas, me, route, padTop = 80, padBottom = 40, fitKey, className, onAreaClick, onMapClick, fallbackCenter }: {
  areas: MapArea[];
  me?: LatLng | null;
  route?: LatLng[];
  padTop?: number;
  padBottom?: number;
  /** Re-fit the view only when this changes (not on every live update). */
  fitKey: string;
  className?: string;
  /** Tap an area (outline or pin) to select it. */
  onAreaClick?: (hex: string) => void;
  /** Tap anywhere on the map (e.g. to set the demo start position). */
  onMapClick?: (at: LatLng) => void;
  /** Where to look when there is nothing to fit (no areas, no position yet). */
  fallbackCenter?: LatLng | null;
}) {
  const clickRef = useRef(onAreaClick);
  clickRef.current = onAreaClick;
  const mapClickRef = useRef(onMapClick);
  mapClickRef.current = onMapClick;
  const clickable = !!onAreaClick;
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const lastFit = useRef<string | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { zoomControl: false, attributionControl: true, zoomSnap: 0.25 });
    addBasemap(m); // base tiles + a 'labels' pane (450) above the area polygons, below the pins
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    m.setView([27.8, -97.4], 11);
    m.on('click', (e: L.LeafletMouseEvent) => mapClickRef.current?.([e.latlng.lat, e.latlng.lng]));
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      layer.current = null;
      lastFit.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const pts: L.LatLngExpression[] = [];
    if (route && route.length > 1) {
      L.polyline(route, { color: '#222', weight: 2.5, dashArray: '1 8', lineCap: 'round', interactive: false }).addTo(g);
    }
    for (const a of areas) {
      const ring = cellToBoundary(a.hex) as LatLng[];
      ring.forEach((p) => pts.push(p));
      const poly = L.polygon(ring, { color: a.color, weight: 2.5, fillColor: a.color, fillOpacity: a.pill === 'done' ? 0.06 : 0.12, interactive: clickable }).addTo(g);
      if (clickable) poly.on('click', () => clickRef.current?.(a.hex));
      if (a.pill) {
        const inner = a.pill === 'done'
          ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'
          : (a.label ?? '');
        const pin = L.marker(cellCenter(a.hex), {
          icon: L.divIcon({ className: 'adj-pin', html: `<span class="${a.pill}">${inner}</span>`, iconSize: [0, 0] }),
          interactive: clickable, keyboard: false,
        }).addTo(g);
        if (clickable) pin.on('click', () => clickRef.current?.(a.hex));
      }
    }
    if (me) {
      L.circleMarker(me, { radius: 6, color: '#fff', weight: 2.5, fillColor: '#2f7bf6', fillOpacity: 1, interactive: false }).addTo(g);
      pts.push(me);
    }
    if (lastFit.current !== fitKey && pts.length) {
      lastFit.current = fitKey;
      const b = L.latLngBounds(pts);
      // The map runs under the status bar and the browser toolbar: add the safe-area insets (adjuster.css sets them as scroll-padding).
      const cs = el.current ? getComputedStyle(el.current) : null;
      const inTop = parseFloat(cs?.scrollPaddingTop ?? '') || 0;
      const inBot = parseFloat(cs?.scrollPaddingBottom ?? '') || 0;
      m.fitBounds(b, { paddingTopLeft: [24, padTop + inTop], paddingBottomRight: [24, padBottom + inBot], maxZoom: 15, animate: false });
    } else if (lastFit.current !== fitKey && fallbackCenter) {
      lastFit.current = fitKey;
      m.setView(fallbackCenter, 11, { animate: false });
    }
  }, [areas, me, route, fitKey, padTop, padBottom, clickable, fallbackCenter]);

  return <div ref={el} className={className ?? 'adj-map'} aria-label="Map of task areas" role="img" />;
}
