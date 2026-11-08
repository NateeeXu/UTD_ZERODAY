// Estimates how much of each hex is land by sampling basemap pixels.
// Esri's light-grey canvas paints water ~rgb(208,207,211) and land ~rgb(236,236,236),
// and serves tiles with CORS, so we can read them back from a canvas.
// Stopgap until the data carries a land fraction per hex (ask A: HexCell.landFraction).
import { useEffect, useState } from 'react';
import { cellToBoundary, cellToLatLng } from 'h3-js';
import type { HexId, World } from '@shared/types';

const Z = 13;
const TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile';

function project(lat: number, lng: number) {
  const n = 2 ** Z;
  const x = ((lng + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { tx: Math.floor(x), ty: Math.floor(y), px: Math.floor((x % 1) * 256), py: Math.floor((y % 1) * 256) };
}

function loadTile(tx: number, ty: number): Promise<ImageData | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0);
      try {
        resolve(ctx.getImageData(0, 0, 256, 256));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = `${TILE}/${Z}/${ty}/${tx}`;
  });
}

const isWater = (r: number, g: number, b: number) => (r + g + b) / 3 < 222 && b >= r - 2;

// Center plus points 60% of the way to each vertex.
function samplePoints(hex: HexId): [number, number][] {
  const [clat, clng] = cellToLatLng(hex);
  const pts: [number, number][] = [[clat, clng]];
  for (const [lat, lng] of cellToBoundary(hex)) {
    pts.push([clat + (lat - clat) * 0.6, clng + (lng - clng) * 0.6]);
    pts.push([clat + (lat - clat) * 0.3, clng + (lng - clng) * 0.3]);
  }
  return pts;
}

export async function computeLandFraction(world: World): Promise<Map<HexId, number>> {
  const samples = world.hexes.map((h) => ({ hex: h.hex, pts: samplePoints(h.hex).map(([la, ln]) => project(la, ln)) }));
  const keys = new Set<string>();
  for (const s of samples) for (const p of s.pts) keys.add(`${p.tx}/${p.ty}`);
  const tiles = new Map<string, ImageData | null>();
  await Promise.all(
    [...keys].map(async (k) => {
      const [tx, ty] = k.split('/').map(Number);
      tiles.set(k, await loadTile(tx, ty));
    }),
  );
  const out = new Map<HexId, number>();
  for (const s of samples) {
    let land = 0;
    let n = 0;
    for (const p of s.pts) {
      const img = tiles.get(`${p.tx}/${p.ty}`);
      if (!img) continue;
      const i = (p.py * 256 + p.px) * 4;
      n++;
      if (!isWater(img.data[i], img.data[i + 1], img.data[i + 2])) land++;
    }
    out.set(s.hex, n ? land / n : 1); // unknown → treat as land
  }
  return out;
}

export function useLandFraction(world: World | undefined): Map<HexId, number> | null {
  const [mask, setMask] = useState<Map<HexId, number> | null>(null);
  useEffect(() => {
    if (!world) return;
    let live = true;
    computeLandFraction(world).then((m) => live && setMask(m));
    return () => {
      live = false;
    };
  }, [world]);
  return mask;
}
