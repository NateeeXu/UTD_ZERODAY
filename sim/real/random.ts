// Random (hypothetical) disaster for one of the real regions, on demand: a new hurricane track for
// Corpus Christi or a new parametric earthquake for the Bay Area, new households and new events.
// The calibrated model has never seen it, so every run is an out-of-sample test.
//
//   node real/random.ts tx [--seed 42] [--category 4] [--landfall-lat 27.6] [--heading -45] [--forward 9]
//                          [--hour 2] [--weekday true|false] [--preset <id>] [--households 20000] [--out <file>]
//   node real/random.ts ca [--seed 42] [--fault Hayward] [--magnitude 7.0] [--hour 17] [--weekday true]
//                          [--preset <id>] [--households 30000] [--out <file>]
//   node real/random.ts list            # presets and faults
// A fully random draw is redrawn until at least 3 % of households are severely damaged (--any to keep any draw).
// Keeps only the area the event hits (--full-county for the whole county).
// Writes data/real/<region>/scenarios/<eventId>.json (gitignored) and prints the path on the last line.

import { gridDisk } from 'h3-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Rng } from '../src/rng.ts';
import { REGIONS } from './regions.ts';
import type { RegionDef } from './regions.ts';
import { loadRegion } from './load.ts';
import { buildBaseWorld } from './world.ts';
import { TX_SCENARIOS } from './scenarios.ts';
import type { HurricaneScenario, QuakeScenario, Scenario } from './scenarios.ts';
import { localTime, simulate } from './simulate.ts';
import { dataSources, serialize } from './bundle-io.ts';
import { OUT_DIR } from './sources.ts';
import { HURRICANE_PRESETS, HURRICANE_SPEC, QUAKE_PRESETS, QUAKE_SPEC } from './random-spec.ts';
import type { Tri } from './random-spec.ts';
import type { EventBundle } from '../../shared/types.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const num = (name: string) => (flag(name) === undefined ? undefined : Number(flag(name)));
const bool = (name: string) => (flag(name) === undefined ? undefined : flag(name) === 'true');

if (argv[0] === 'list') {
  console.log('hurricane presets:', HURRICANE_PRESETS.map((p) => `${p.id} (${p.name})`).join(', ') || '(none yet)');
  console.log('earthquake presets:', QUAKE_PRESETS.map((p) => `${p.id} (${p.name})`).join(', ') || '(none yet)');
  console.log('faults:', QUAKE_SPEC.faults.map((f) => f.name).join(', '));
  process.exit(0);
}

const alias: Record<string, RegionDef['id']> = { tx: 'tx-corpus-christi', ca: 'ca-bay-area' };
const regionId = alias[argv[0] ?? ''];
if (!regionId) throw new Error('usage: node real/random.ts <tx|ca|list> [options] (see the header of real/random.ts)');
const region = REGIONS[regionId];
let seed = num('--seed') ?? (Date.now() % 1_000_000);
let rng = new Rng(seed * 7919 + 17);

const tri = (t: Tri): number => {
  const u = rng.float();
  const c = (t.mode - t.min) / (t.max - t.min);
  return u < c ? t.min + Math.sqrt(u * (t.max - t.min) * (t.mode - t.min)) : t.max - Math.sqrt((1 - u) * (t.max - t.min) * (t.max - t.mode));
};
const r1 = (v: number) => Math.round(v * 10) / 10;

/** UTC ISO time with the given local hour and weekday/weekend in September (DST): CDT = UTC-5, PDT = UTC-7. */
function isoFor(hour: number, weekday: boolean, tz: string): string {
  const offset = tz === 'America/Los_Angeles' ? 7 : 5;
  for (let day = 14; day < 21; day++) {
    const iso = new Date(Date.UTC(2026, 8, day, hour + offset, 0, 0)).toISOString();
    const lt = localTime(iso, tz);
    if (lt.weekday === weekday && lt.hour === hour) return iso;
  }
  throw new Error('could not build an event time');
}

/** Landfall longitude on the coast at a latitude, interpolated between the known landfall points. */
function coastLng(lat: number): number {
  const pts = TX_SCENARIOS.map((s) => s.landfall).sort((a, b) => a.lat - b.lat);
  if (lat <= pts[0]!.lat) return pts[0]!.lng;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    if (lat <= b.lat) return a.lng + ((lat - a.lat) / Math.max(1e-6, b.lat - a.lat)) * (b.lng - a.lng);
  }
  return pts[pts.length - 1]!.lng;
}

function randomHurricane(): HurricaneScenario {
  const preset = flag('--preset') ? HURRICANE_PRESETS.find((p) => p.id === flag('--preset')) : undefined;
  if (flag('--preset') && !preset) throw new Error(`unknown preset ${flag('--preset')} (try: node real/random.ts list)`);
  const hour = num('--hour') ?? preset?.localHour ?? rng.int(0, 23);
  const weekday = bool('--weekday') ?? preset?.weekday ?? rng.chance(5 / 7);
  let cat = num('--category') ?? preset?.category;
  if (cat === undefined) {
    let u = rng.float();
    cat = 1;
    for (const k of ['1', '2', '3', '4', '5'] as const) {
      u -= HURRICANE_SPEC.categories[k].p;
      if (u <= 0) { cat = Number(k); break; }
    }
  }
  const c = HURRICANE_SPEC.categories[String(Math.min(5, Math.max(1, Math.round(cat)))) as '1'];
  const forward = num('--forward') ?? preset?.forwardKmh ?? tri(HURRICANE_SPEC.forwardKmh);
  const lat = num('--landfall-lat') ?? preset?.landfall.lat ?? rng.range(HURRICANE_SPEC.landfallLat[0], HURRICANE_SPEC.landfallLat[1]);
  const lng = preset && num('--landfall-lat') === undefined ? preset.landfall.lng : coastLng(lat);
  const rf = HURRICANE_SPEC.rainFt;
  const rain = preset?.rainFt ?? Math.min(4, rng.range(rf.min, rf.max) * (forward < rf.slowBoostBelowKmh ? rf.slowBoost : 1));
  const name = preset
    ? `${preset.name}: hypothetical, inspired by ${preset.analog.split(' (')[0]}`
    : `Random hypothetical Cat-${cat} hurricane #${seed}`;
  return {
    kind: 'hurricane',
    eventId: preset ? preset.id : `random-${seed}`,
    name,
    seed: 70_000_000 + seed,
    landfallIso: isoFor(hour, weekday, region.tz),
    landfall: { lat: Math.round(lat * 1000) / 1000, lng: Math.round(lng * 1000) / 1000 },
    headingDeg: Math.round(num('--heading') ?? preset?.headingDeg ?? tri(HURRICANE_SPEC.headingDeg)),
    vmaxMph: Math.round(preset?.vmaxMph ?? rng.range(c.vmaxMph[0], c.vmaxMph[1])),
    rmaxKm: Math.round(preset?.rmaxKm ?? rng.range(c.rmaxKm[0], c.rmaxKm[1])),
    forwardKmh: Math.round(forward),
    surgeFt: r1(preset?.surgeFt ?? rng.range(c.surgeFt[0], c.surgeFt[1])),
    surgeInlandKm: r1(rng.range(HURRICANE_SPEC.surgeInlandKm[0], HURRICANE_SPEC.surgeInlandKm[1])),
    rainFt: r1(rain),
    extraOutageClusters: rng.int(1, 3),
  };
}

function randomQuake(): QuakeScenario {
  const preset = flag('--preset') ? QUAKE_PRESETS.find((p) => p.id === flag('--preset')) : undefined;
  if (flag('--preset') && !preset) throw new Error(`unknown preset ${flag('--preset')} (try: node real/random.ts list)`);
  const hour = num('--hour') ?? preset?.localHour ?? rng.int(0, 23);
  const weekday = bool('--weekday') ?? preset?.weekday ?? rng.chance(5 / 7);
  let fault = QUAKE_SPEC.faults.find((f) => f.name.toLowerCase().startsWith((flag('--fault') ?? preset?.faultName ?? '\u0000').toLowerCase()));
  if (!fault) {
    let u = rng.float() * QUAKE_SPEC.faults.reduce((a, f) => a + f.weight, 0);
    fault = QUAKE_SPEC.faults[QUAKE_SPEC.faults.length - 1]!;
    for (const f of QUAKE_SPEC.faults) { u -= f.weight; if (u <= 0) { fault = f; break; } }
  }
  const t = rng.range(0.2, 0.8);
  const epicenter = preset?.epicenter ?? { lat: fault.a.lat + t * (fault.b.lat - fault.a.lat), lng: fault.a.lng + t * (fault.b.lng - fault.a.lng) };
  const kmLng = Math.cos((epicenter.lat * Math.PI) / 180);
  const strike = (Math.atan2((fault.b.lng - fault.a.lng) * kmLng, fault.b.lat - fault.a.lat) * 180) / Math.PI;
  const magnitude = num('--magnitude') ?? preset?.magnitude ?? r1(rng.range(fault.magnitude[0], fault.magnitude[1]));
  const name = preset
    ? `${preset.name}: hypothetical, inspired by ${preset.analog.split(' (')[0]}`
    : `Random hypothetical M${magnitude} ${fault.name} earthquake #${seed}`;
  return {
    kind: 'earthquake',
    eventId: preset ? preset.id : `random-${seed}`,
    name,
    seed: 60_000_000 + seed,
    landfallIso: isoFor(hour, weekday, region.tz),
    parametric: {
      faultName: preset?.faultName ?? fault.name,
      epicenter: { lat: Math.round(epicenter.lat * 1000) / 1000, lng: Math.round(epicenter.lng * 1000) / 1000 },
      magnitude,
      strikeDeg: Math.round(preset?.strikeDeg ?? strike),
      depthKm: r1(preset?.depthKm ?? rng.range(QUAKE_SPEC.depthKm[0], QUAKE_SPEC.depthKm[1])),
    },
    extraOutageClusters: rng.int(1, 3),
  };
}

const t0 = Date.now();
const data = loadRegion(region);
const base = buildBaseWorld(data);
const households = num('--households') ?? (region.hazardType === 'hurricane' ? 20000 : 30000);
const sources = dataSources(data);
if (region.hazardType === 'earthquake')
  sources.push('Parametric shaking for this random event: finite rupture (Wells & Coppersmith 1994 length scaling) and an intensity prediction equation (Atkinson & Wald 2007, California). Hypothetical event, not a USGS scenario.');
// A fully random draw (no preset, no --seed, no scenario options) is redrawn until at least MIN_SEVERE of the
// households are severely damaged, so a demo never lands on a quake that misses the county; --any disables it.
const MIN_SEVERE = 0.03;
const SCENARIO_FLAGS = ['--preset', '--seed', '--category', '--landfall-lat', '--heading', '--forward', '--fault', '--magnitude'];
const fullyRandom = !argv.includes('--any') && !SCENARIO_FLAGS.some((f) => argv.includes(f));
let sc: Scenario;
let result: ReturnType<typeof simulate>;
let redraws = 0;
for (;;) {
  sc = region.hazardType === 'hurricane' ? randomHurricane() : randomQuake();
  result = simulate(base, data, sc, { regionPrefix: region.id.slice(0, 2), households, fieldReports: false, dataSources: sources });
  const share = result.bundle.truth.filter((r) => r.damage >= 2).length / households;
  if (!fullyRandom || share >= MIN_SEVERE || redraws >= 15) break;
  redraws++;
  seed = (seed + 7919) % 1_000_000;
  rng = new Rng(seed * 7919 + 17);
}
// Footprint: keep only the area this event actually hits (hazard index >= max(0.2, 40 % of the event's peak),
// plus one ring of neighbours), so every disaster has its own shape on the map. --full-county keeps it all.
const MIN_CELLS = 40;
const MIN_KEPT_HOUSEHOLDS = 12000;
const MAX_HOUSEHOLDS = 60000;
function footprintHexes(b: EventBundle): Set<string> {
  const hexes = b.world.hexes;
  const peak = Math.max(...hexes.map((h) => h.hazardIndex ?? 0));
  const cutoff = Math.max(0.2, 0.4 * peak);
  let core = hexes.filter((h) => (h.hazardIndex ?? 0) >= cutoff).map((h) => h.hex);
  if (core.length < MIN_CELLS) core = [...hexes].sort((a, c) => (c.hazardIndex ?? 0) - (a.hazardIndex ?? 0)).slice(0, MIN_CELLS).map((h) => h.hex);
  const all = new Set(hexes.map((h) => h.hex));
  const keep = new Set<string>();
  for (const h of core) for (const n of gridDisk(h, 1)) if (all.has(n)) keep.add(n);
  return keep;
}
function applyFootprint(b: EventBundle, keep: Set<string>): EventBundle {
  const households = b.world.households.filter((h) => keep.has(h.hex));
  const ids = new Set(households.map((h) => h.id));
  const hexes = b.world.hexes.filter((h) => keep.has(h.hex));
  const center = { lat: hexes.reduce((a, h) => a + h.lat, 0) / hexes.length, lng: hexes.reduce((a, h) => a + h.lng, 0) / hexes.length };
  return {
    ...b,
    world: { ...b.world, center, hexes, households, ...(b.world.facilities ? { facilities: b.world.facilities.filter((f) => keep.has(f.hex)) } : {}) },
    events: b.events.filter((e) => ids.has(e.householdId)),
    truth: b.truth.filter((t) => ids.has(t.householdId)),
  };
}
let footprintNote = '';
if (!argv.includes('--full-county')) {
  let keep = footprintHexes(result.bundle);
  let kept = result.bundle.world.households.filter((h) => keep.has(h.hex)).length;
  if (kept < MIN_KEPT_HOUSEHOLDS) {
    // Same event (hazard does not depend on the household count), denser households, so the numbers stay at scale.
    const scaled = Math.min(MAX_HOUSEHOLDS, Math.round((households * MIN_KEPT_HOUSEHOLDS) / Math.max(1, kept)));
    result = simulate(base, data, sc, { regionPrefix: region.id.slice(0, 2), households: scaled, fieldReports: false, dataSources: sources });
    keep = footprintHexes(result.bundle);
    kept = result.bundle.world.households.filter((h) => keep.has(h.hex)).length;
  }
  footprintNote = `  footprint: ${keep.size} of ${result.bundle.world.hexes.length} cells, ${kept} households (--full-county keeps the whole county)`;
  result = { ...result, bundle: applyFootprint(result.bundle, keep) };
}
const { bundle, meta } = result;
const text = serialize(bundle);
JSON.parse(text);
const out = flag('--out') ?? join(OUT_DIR, region.id, 'scenarios', `${sc.eventId}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
const lt = localTime(sc.landfallIso, region.tz);
const severe = bundle.truth.filter((r) => r.damage >= 2).length;
console.log(`[${region.id}] ${sc.name}`);
if (footprintNote) console.log(footprintNote);
console.log(`  ${lt.weekday ? 'weekday' : 'weekend'} ${String(lt.hour).padStart(2, '0')}:00 local; ${bundle.world.households.length} households, ${bundle.events.length} events, true severe ${severe} (${((100 * severe) / bundle.world.households.length).toFixed(1)}%)`);
for (const n of meta.notes ?? []) console.log(`  ${n}`);
if (redraws > 0) console.log(`  redrew ${redraws} time(s): skipped random events with under ${MIN_SEVERE * 100}% severe households (--any keeps them)`);
console.log(`  ${(text.length / 1e6).toFixed(1)} MB in ${Date.now() - t0} ms`);
console.log(out);
