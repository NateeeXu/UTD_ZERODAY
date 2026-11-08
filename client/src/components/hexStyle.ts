// Visual treatments for priority + verification on the map. Several variants
// exist so we can compare them side by side on #/lab before picking one.
import type L from 'leaflet';
import type { HexView } from '../engine/placeholderEstimate';

export type VariantId = '0' | 'A' | 'B' | 'C' | 'D';
export type SeaMode = 'hide' | 'faint';

export const VARIANTS: { id: VariantId; name: string; blurb: string }[] = [
  { id: '0', name: 'Current', blurb: 'What the dashboard uses today, for comparison. Ignores the sea mask.' },
  { id: 'A', name: 'Tint + bold hatch', blurb: 'See-through fills. Unverified gets thicker, darker diagonal lines in its own shade.' },
  { id: 'B', name: 'Hollow = unverified', blurb: 'Verified is filled. Unverified is a faint fill with a colored outline, inset so outlines never merge.' },
  { id: 'C', name: 'Dots', blurb: 'See-through fills. Unverified gets a dot grid, which reads as "uncertain" and survives small sizes.' },
  { id: 'D', name: 'Solid vs striped', blurb: 'Deeper red / bright yellow. Verified is solid; unverified is wide stripes of the same color over a pale fill.' },
];

export interface HexPaint {
  base: L.PathOptions;
  overlay: L.PathOptions | null;   // full-size pattern layer
  inset: L.PathOptions | null;     // shrunk outline layer
}

// Coast / sea handling: land < 0.15 counts as sea; partial land is dimmed.
export function seaClass(land: number | undefined): 'land' | 'coast' | 'sea' {
  if (land == null || land >= 0.6) return 'land';
  return land < 0.15 ? 'sea' : 'coast';
}

const NONE = { fillOpacity: 0, opacity: 0 };

const palette = {
  '0': { P0: '#DC2626', P1: '#F59E0B' },
  A: { P0: '#DC2626', P1: '#F5B301' },
  B: { P0: '#DC2626', P1: '#F5B301' },
  C: { P0: '#DC2626', P1: '#F5B301' },
  D: { P0: '#B91C1C', P1: '#FACC15' },
} as const;

export function paintFused(h: HexView, v: VariantId, dim: number): HexPaint {
  const unverified = h.priority !== 'P2' && h.verification === 'needs_verification';
  const edge = { color: '#ffffff', weight: 1, opacity: 0.9 * dim };
  if (h.priority === 'P2' && v === '0') {
    return { base: { ...edge, fillColor: '#9CA3AF', fillOpacity: 0.12 }, overlay: null, inset: null };
  }
  if (h.priority === 'P2') {
    return {
      base: { ...edge, color: '#9CA3AF', opacity: 0.35 * dim, fillColor: '#9CA3AF', fillOpacity: 0.04 * dim },
      overlay: null,
      inset: null,
    };
  }
  const p = h.priority;
  const col = palette[v][p];

  switch (v) {
    case '0':
      return {
        base: { ...edge, fillColor: col, fillOpacity: p === 'P0' ? 0.72 : 0.62 },
        overlay: unverified ? { stroke: false, fillColor: p === 'P0' ? 'url(#hatch-light)' : 'url(#hatch-dark)', fillOpacity: 1 } : null,
        inset: null,
      };
    case 'A':
      return {
        base: { ...edge, fillColor: col, fillOpacity: (p === 'P0' ? 0.45 : 0.42) * dim },
        overlay: unverified ? { stroke: false, fillColor: `url(#hatchA-${p})`, fillOpacity: dim } : null,
        inset: null,
      };
    case 'B':
      return unverified
        ? {
            base: { ...edge, fillColor: col, fillOpacity: 0.12 * dim },
            overlay: null,
            inset: { fill: false, color: col, weight: 2.5, opacity: dim },
          }
        : { base: { ...edge, fillColor: col, fillOpacity: 0.5 * dim }, overlay: null, inset: null };
    case 'C':
      return {
        base: { ...edge, fillColor: col, fillOpacity: 0.42 * dim },
        overlay: unverified ? { stroke: false, fillColor: `url(#dotsC-${p})`, fillOpacity: dim } : null,
        inset: null,
      };
    case 'D':
      return unverified
        ? {
            base: { ...edge, fillColor: col, fillOpacity: 0.14 * dim },
            overlay: { stroke: false, fillColor: `url(#stripeD-${p})`, fillOpacity: dim },
            inset: null,
          }
        : { base: { ...edge, fillColor: col, fillOpacity: 0.55 * dim }, overlay: null, inset: null };
  }
}

export function paintSea(mode: SeaMode): HexPaint {
  return mode === 'hide'
    ? { base: NONE, overlay: null, inset: null }
    : { base: { color: '#9CA3AF', weight: 1, opacity: 0.5, dashArray: '2 3', fillOpacity: 0 }, overlay: null, inset: null };
}

// SVG patterns referenced by url(#id). Rendered once per page.
export const PATTERN_DEFS = [
  { id: 'hatchA-P0', kind: 'line', size: 8, stroke: '#7F1D1D', width: 2.4, opacity: 0.75 },
  { id: 'hatchA-P1', kind: 'line', size: 8, stroke: '#78350F', width: 2.4, opacity: 0.7 },
  { id: 'dotsC-P0', kind: 'dot', size: 6, stroke: '#7F1D1D', width: 1.5, opacity: 0.85 },
  { id: 'dotsC-P1', kind: 'dot', size: 6, stroke: '#78350F', width: 1.5, opacity: 0.8 },
  { id: 'stripeD-P0', kind: 'line', size: 9, stroke: '#B91C1C', width: 4, opacity: 0.75 },
  { id: 'stripeD-P1', kind: 'line', size: 9, stroke: '#EAB308', width: 4, opacity: 0.9 },
] as const;
