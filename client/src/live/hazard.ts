// The disaster itself on the map, from world.hazardGeometryJson (docs/SPACETIME_API.md "Hazard on the map"):
// hurricane = forecast cone (issued before landfall), forecast track, storm position when issued, landfall;
// earthquake = epicentre and, when known, the rupture line. '' (Harbor Bend) = nothing to draw.
import type { HazardGeometry } from '@shared/types';

type LatLng = { lat: number; lng: number };
const isPoint = (p: unknown): p is LatLng =>
  !!p && typeof p === 'object' && Number.isFinite((p as LatLng).lat) && Number.isFinite((p as LatLng).lng);
const points = (a: unknown): LatLng[] => (Array.isArray(a) ? a.filter(isPoint) : []);

// Parsed defensively: a malformed or unknown value draws nothing instead of breaking the map.
export function parseHazard(json: string | undefined): HazardGeometry | null {
  if (!json) return null;
  try {
    const g = JSON.parse(json);
    if (g?.kind === 'hurricane' && isPoint(g.landfall)) {
      const cone = g.cone && points(g.cone.polygon).length >= 3
        ? { ...g.cone, polygon: points(g.cone.polygon) }
        : { polygon: [], issuedHoursBeforeLandfall: 0, radiusAtLandfallKm: 0 };
      return { ...g, track: points(g.track), cone };
    }
    if (g?.kind === 'earthquake' && isPoint(g.epicenter)) {
      const rupture = points(g.rupture);
      return { ...g, rupture: rupture.length === 2 ? [rupture[0], rupture[1]] : null };
    }
  } catch {
    /* fall through */
  }
  return null;
}

export const hasCone = (h: HazardGeometry | null): boolean => h?.kind === 'hurricane' && h.cone.polygon.length >= 3;

// "Cat 4 · 132 mph" / "M7.05 · Hayward"
export function hazardLabel(h: HazardGeometry): string {
  if (h.kind === 'hurricane') return `Cat ${h.category} · ${Math.round(h.vmaxMph)} mph`;
  return `M${h.magnitude} · ${h.faultName}`;
}
