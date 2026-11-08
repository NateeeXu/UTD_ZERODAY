// Export per-cell engine results for the map style preview (docs/preview/).
//   node scripts/preview-data.ts            -> ../docs/preview/preview-data.js
// Runs the engine on each live world at a few snapshot times and writes a small JS file
// (window.PREVIEW_DATA) so the preview HTML also opens straight from disk.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateAll } from '../src/infer.ts';
import { loadBundle, loadModel } from './io.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const TIMES = [120, 360, 1440];

const regions = [
  { id: 'tx', dir: 'data/real/tx-corpus-christi', title: 'Corpus Christi, TX', subtitle: 'Hypothetical Cat 4 hurricane' },
  { id: 'ca', dir: 'data/real/ca-bay-area', title: 'Alameda County, CA', subtitle: 'USGS HayWired M7.05 scenario, Hayward Fault' },
];

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const out: Record<string, unknown> = {};

for (const r of regions) {
  const bundle = loadBundle(join(root, r.dir, 'live.json'));
  const params = loadModel(join(root, r.dir, 'model.json'));
  const w = bundle.world;
  const snapshots: Record<string, unknown[]> = {};
  for (const t of TIMES) {
    const est = estimateAll(w, bundle.events, t, params);
    snapshots[String(t)] = est.hexes.map((h) => ({
      hex: h.hex,
      p: h.priority,
      v: h.verification,
      c: round(h.confidence, 2),
      s: round(h.severity, 2),
      si: round(h.silence, 2),
      hz: round(h.hazard ?? 0, 2),
      sc: h.silenceCause ?? null,
      r: h.reason ?? '',
      n: h.households,
      ex: round(h.expectedSevere, 1),
      rep: h.counts.smsReplies,
      sent: h.counts.smsSent,
      cl: h.counts.claims,
    }));
  }
  const facilities = (w.facilities ?? [])
    .filter((f) => f.kind === 'school' || f.kind === 'university' || f.kind === 'hospital')
    .map((f) => ({ k: f.kind, n: f.name, lat: round(f.lat, 5), lng: round(f.lng, 5), e: f.enrollment ?? null }));
  out[r.id] = {
    title: r.title,
    subtitle: r.subtitle,
    center: w.center,
    hazardType: w.hazardType ?? 'hurricane',
    eventLocalHour: w.eventLocalHour ?? null,
    eventWeekday: w.eventWeekday ?? null,
    households: w.households.length,
    cells: w.hexes.length,
    modelVersion: params.version,
    snapshots,
    facilities,
  };
}

const target = join(root, 'docs/preview/preview-data.js');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `window.PREVIEW_DATA = ${JSON.stringify({ times: TIMES, regions: out })};\n`);
console.log(`wrote ${target}`);
