// Per-scenario simulation on a real-geography base world: hazard footprint per cell, analyst zones
// (with the same deliberate mistakes as the synthetic simulator), synthetic households, truth and
// the SMS / claim / field-report event stream.

import { greatCircleDistance } from 'h3-js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Damage, EventBundle, HexCell, HexId, Peril, SimEvent, TruthRow } from '../../shared/types.ts';
import { Rng, subSeed } from '../src/rng.ts';
import type { RegionData } from './load.ts';
import type { BaseWorld, CellInfo } from './world.ts';
import { ringIn, round, sampleHouseholds } from './world.ts';
import type { HurricaneScenario, Scenario } from './scenarios.ts';
import { parseShakeMapGrid } from './geo.ts';
import { RAW_DIR } from './sources.ts';
import { replyLanguage, replyText } from './textgen.ts';
import { distanceToSegmentKm, ipeMmi, ruptureLengthKm, ruptureSegment } from './quake-model.ts';
import { replyLabels, truthLocation, truthNeedType, truthReturnMin, locationAt } from '../src/needs.ts';

export const HORIZON_MIN = 4320;
export const HOLDOUT_SHARE = 0.15;
export const FIELD_REPORT_SHARE = 0.12;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Local hour (0-23) and weekday flag of an ISO instant in an IANA time zone. */
export function localTime(iso: string, tz: string): { hour: number; weekday: boolean } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(iso));
  const hour = Number(parts.find((p) => p.type === 'hour')!.value) % 24;
  const wd = parts.find((p) => p.type === 'weekday')!.value;
  return { hour, weekday: wd !== 'Sat' && wd !== 'Sun' };
}
const clampDamage = (v: number): Damage => clamp(Math.round(v), 0, 3) as Damage;
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

interface Blob { x: number; y: number; r: number; amp: number }
const blobSum = (blobs: Blob[], x: number, y: number): number => {
  let s = 0;
  for (const b of blobs) s += b.amp * Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (2 * b.r * b.r));
  return s;
};

// ---- shared hazard scores (~0-3 scale; 1 ~ minor damage, 2 ~ severe, 3 ~ uninhabitable) ----
export const windScore = (wind: number): number => Math.max(0, (wind - 60) / 26);
export const floodScore = (depth: number): number => Math.max(0, depth / 2.7);
export const shakeScore = (mmi: number): number => Math.max(0, (mmi - 6.8) / 1.6);
/** Hurricane cell score: dominant of wind / flood plus 30% of the other. */
export const hurricaneScore = (wind: number, flood: number): number => {
  const w = windScore(wind), f = floodScore(flood);
  return Math.max(w, f) + 0.3 * Math.min(w, f);
};
/** Earthquake cell score: shaking plus a liquefaction term that switches on above MMI ~6.5. */
export const quakeScore = (mmi: number, liq: number): number => shakeScore(mmi) + 0.8 * liq * clamp((mmi - 6.5) / 1.5, 0, 1);
/** hazardIndex (0-1) = cell score / 3.2, same definition for both hazard types. */
export const hazardIndexOf = (score: number): number => round(clamp(score / 3.2, 0, 1), 3);

// ---- hurricane geometry ----
class HurricaneTrack {
  private ux: number; private uy: number; private lx: number; private ly: number;
  private landKmAt: (s: number) => number;
  readonly sc: HurricaneScenario;
  constructor(sc: HurricaneScenario, base: BaseWorld, lateralShiftKm = 0) {
    this.sc = sc;
    const h = (sc.headingDeg * Math.PI) / 180;
    this.ux = Math.sin(h); this.uy = Math.cos(h);
    // right-hand normal of the motion direction
    this.lx = base.proj.x(sc.landfall.lng) + this.uy * lateralShiftKm;
    this.ly = base.proj.y(sc.landfall.lat) - this.ux * lateralShiftKm;
    // cumulative over-land distance along the track after landfall (OSM coastline side test)
    const step = 0.5, land: number[] = [];
    let acc = 0;
    for (let s = 0; s <= 120; s += step) {
      const x = this.lx + this.ux * s, y = this.ly + this.uy * s;
      const isLand = base.coast.n ? base.coast.nearest(x, y).land : true;
      if (isLand) acc += step;
      land.push(acc);
    }
    this.landKmAt = (s: number) => (s <= 0 ? 0 : land[Math.min(land.length - 1, Math.floor(s / step))]!);
  }
  /** along-track coordinate s (km, + = after landfall) and signed cross-track distance d (+ = right). */
  coords(x: number, y: number): { s: number; d: number } {
    const dx = x - this.lx, dy = y - this.ly;
    return { s: dx * this.ux + dy * this.uy, d: dx * this.uy - dy * this.ux };
  }
  /** intensity (mph) at along-track position s; Kaplan-DeMaria-style decay with time over land. */
  vmaxAt(s: number): number {
    const tLand = this.landKmAt(s) / this.sc.forwardKmh;
    return 30 + (this.sc.vmaxMph - 30) * Math.exp(-0.095 * tLand);
  }
  wind(c: CellInfo): number {
    const { s, d } = this.coords(c.x, c.y);
    const ad = Math.abs(d), R = this.sc.rmaxKm;
    const g = ad <= R ? 1 : (R / ad) ** 0.6;
    const asym = 0.925 + 0.075 * Math.tanh(d / (0.5 * R));
    const exposure = 0.82 + 0.18 * Math.exp(-c.coastKm / 2.5);
    return this.vmaxAt(s) * g * asym * exposure;
  }
  /** still-water level (ft above ground datum) near the cell, before subtracting ground elevation. */
  waterLevelFt(c: CellInfo): number {
    const { d } = this.coords(c.x, c.y);
    const R = this.sc.rmaxKm;
    let along = Math.exp(-(((d - R) / (2.2 * R)) ** 2));
    if (d < 0) along *= 0.35;
    along = Math.max(0.12, along);
    return this.sc.surgeFt * along * Math.exp(-c.coastKm / this.sc.surgeInlandKm);
  }
}

const elevFt = (c: CellInfo): number => (Number.isFinite(c.elevM) ? c.elevM * 3.281 : 10);

export interface SimMeta {
  eventId: string;
  hazardType: 'hurricane' | 'earthquake';
  trackOutageCenterHex: HexId;
  underMarkedCenterHex: HexId; underMarkedHexes: HexId[];
  overMarkedCenterHex: HexId; overMarkedHexes: HexId[];
  overReportingDistrictCenterHex: HexId; overReportingDistrictHexes: HexId[];
  reunificationHouseholds: number;
  notes: string[];
}

export interface SimOptions {
  regionPrefix: string;      // 'tx' | 'ca' (household id prefix)
  households: number;
  fieldReports: boolean;
  dataSources: string[];
}

export function simulate(base: BaseWorld, data: RegionData, sc: Scenario, opt: SimOptions): { bundle: EventBundle; meta: SimMeta } {
  const hazardRng = new Rng(subSeed(sc.seed, 'hazard'));
  const truthRng = new Rng(subSeed(sc.seed, 'truth'));
  const smsRng = new Rng(subSeed(sc.seed, 'sms'));
  const textRng = new Rng(subSeed(sc.seed, 'text'));
  const claimRng = new Rng(subSeed(sc.seed, 'claims'));
  const fieldRng = new Rng(subSeed(sc.seed, 'field'));
  const quirkRng = new Rng(subSeed(sc.seed, 'quirks'));
  // v3 labels use their own streams so the truth / sms / text streams above do not shift.
  const needsRng = new Rng(subSeed(sc.seed, 'needs'));
  const labelRng = new Rng(subSeed(sc.seed, 'labels'));
  const notes: string[] = [];
  const cells = base.cells;
  const hexSet = new Set(cells.map((c) => c.hex));
  const isQuake = sc.kind === 'earthquake';

  // ---- hazard per cell ----
  const wind = new Map<HexId, number>(), flood = new Map<HexId, number>(), mmi = new Map<HexId, number>();
  let track: HurricaneTrack | null = null;
  if (sc.kind === 'hurricane') {
    track = new HurricaneTrack(sc, base);
    // rain pockets centred on real low-lying inland cells
    const low = cells.filter((c) => c.coastKm > 1.5).sort((a, b) => elevFt(a) - elevFt(b) || (a.hex < b.hex ? -1 : 1));
    const lowPool = low.slice(0, Math.max(5, Math.floor(low.length * 0.3)));
    const rainBlobs: Blob[] = [];
    for (let i = 0; i < 6 && lowPool.length; i++) {
      const c = hazardRng.pick(lowPool);
      rainBlobs.push({ x: c.x, y: c.y, r: hazardRng.range(1.2, 2.2), amp: sc.rainFt * hazardRng.range(0.6, 1.2) });
    }
    for (const c of cells) {
      const w = clamp(track.wind(c) + hazardRng.normal(0, 3), 30, 165);
      const surgeDepth = track.waterLevelFt(c) - elevFt(c);
      const lowness = clamp((12 - (Number.isFinite(c.elevM) ? c.elevM : 6)) / 10, 0.2, 1);
      let f = Math.max(0, surgeDepth) + blobSum(rainBlobs, c.x, c.y) * lowness + hazardRng.normal(0, 0.25);
      if (f < 0.5) f = 0;
      wind.set(c.hex, w);
      flood.set(c.hex, f);
    }
    notes.push(`Track: landfall ${sc.landfall.lat},${sc.landfall.lng}, heading ${sc.headingDeg} deg, ${sc.vmaxMph} mph, Rmax ${sc.rmaxKm} km, surge ${sc.surgeFt} ft.`);
  } else if (sc.parametric) {
    // Random event: finite rupture + intensity prediction equation (real/quake-model.ts), small cell noise.
    const q = sc.parametric;
    const len = ruptureLengthKm(q.magnitude);
    const [ra, rb] = ruptureSegment(q.epicenter, q.strikeDeg, len);
    for (const c of cells) {
      const d = distanceToSegmentKm({ lat: c.lat, lng: c.lng }, ra, rb);
      mmi.set(c.hex, clamp(ipeMmi(q.magnitude, d) + hazardRng.normal(0, 0.15), 1, 10));
    }
    notes.push(`Parametric M${q.magnitude} on ${q.faultName}: epicentre ${q.epicenter.lat},${q.epicenter.lng}, strike ${q.strikeDeg} deg, rupture ${len.toFixed(0)} km, depth ${q.depthKm} km.`);
  } else {
    const g = parseShakeMapGrid(readFileSync(join(RAW_DIR, 'usgs', `grid_${sc.usgsEventId}.xml`), 'utf8'));
    for (const c of cells) mmi.set(c.hex, clamp(g.grid.sample(c.lat, c.lng), 1, 10));
    notes.push(`USGS ShakeMap ${sc.usgsEventId}: "${g.description}", M${g.magnitude}, epicentre ${g.lat},${g.lon}.`);
  }
  const scoreOf = (c: CellInfo) => (isQuake ? quakeScore(mmi.get(c.hex)!, c.liquefaction) : hurricaneScore(wind.get(c.hex)!, flood.get(c.hex)!));

  // ---- tower outage ----
  const masts = base.masts.slice().sort((a, b) => (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : a.x - b.x));
  const nearestCell = (x: number, y: number) => {
    let best = cells[0]!, bd = Infinity;
    for (const c of cells) { const d = (c.x - x) ** 2 + (c.y - y) ** 2; if (d < bd) { bd = d; best = c; } }
    return best;
  };
  let primary: { x: number; y: number };
  if (sc.kind === 'hurricane') {
    // the hardest-hit comms site: a real mast right of track, 1-6 km from the coast, with the highest wind
    const cand = masts.filter((m) => {
      const { d, s } = track!.coords(m.x, m.y);
      const c = nearestCell(m.x, m.y);
      return d >= 0 && d <= 1.5 * sc.rmaxKm && s > -5 && c.coastKm >= 0.5 && c.coastKm <= 6;
    }).sort((a, b) => track!.wind(nearestCell(b.x, b.y)) - track!.wind(nearestCell(a.x, a.y)));
    if (cand.length) primary = { x: cand[0]!.x, y: cand[0]!.y };
    else {
      const c = cells.slice().sort((a, b) => scoreOf(b) - scoreOf(a))[0]!;
      primary = { x: c.x, y: c.y };
      notes.push('No OSM mast near the track; primary outage cluster placed at the highest-hazard cell.');
    }
  } else {
    // quake: the mast with the strongest shaking plus liquefaction
    const scored = masts.map((m) => ({ m, z: scoreOf(nearestCell(m.x, m.y)) })).sort((a, b) => b.z - a.z);
    const top = scored.slice(0, 5);
    const p = top.length ? hazardRng.pick(top).m : null;
    if (p) primary = { x: p.x, y: p.y };
    else { const c = cells.slice().sort((a, b) => scoreOf(b) - scoreOf(a))[0]!; primary = { x: c.x, y: c.y }; }
  }
  const outageBlobs: Blob[] = [{ x: primary.x, y: primary.y, r: 1.7, amp: 95 }];
  const exposedMasts = masts.filter((m) => scoreOf(nearestCell(m.x, m.y)) > 0.8 && Math.hypot(m.x - primary.x, m.y - primary.y) > 4);
  for (let i = 0; i < sc.extraOutageClusters; i++) {
    const m = exposedMasts.length ? hazardRng.pick(exposedMasts) : hazardRng.pick(cells);
    outageBlobs.push({ x: m.x, y: m.y, r: hazardRng.range(0.9, 1.7), amp: hazardRng.range(45, 80) });
  }
  const hexes: HexCell[] = [];
  const cellOut = new Map<HexId, HexCell>();
  for (const c of cells) {
    const base85 = isQuake ? 80 * sigmoid((mmi.get(c.hex)! - 9.2) / 0.25) : 85 * sigmoid((wind.get(c.hex)! - 116) / 8);
    const outage = clamp(base85 + blobSum(outageBlobs, c.x, c.y) + hazardRng.normal(0, 4), 0, 100);
    const score = scoreOf(c);
    const hc: HexCell = {
      hex: c.hex, lat: round(c.lat, 6), lng: round(c.lng, 6),
      windMph: isQuake ? 0 : Math.round(wind.get(c.hex)!),
      floodDepthFt: isQuake ? 0 : round(flood.get(c.hex)!, 1),
      towerOutagePct: Math.round(outage), analystZone: 0,
      hazardIndex: hazardIndexOf(score),
    };
    if (isQuake) { hc.shakingMmi = round(mmi.get(c.hex)!, 2); hc.liquefaction = round(c.liquefaction, 2); }
    hc.tractGeoid = c.tract;
    hc.daytimeWorkers = c.jobs;
    hc.residentWorkers = c.workers;
    hc.k12Enrollment = c.k12Enrollment;
    hc.collegeEnrollment = c.collegeEnrollment;
    hexes.push(hc);
    cellOut.set(c.hex, hc);
  }
  const trackOutageCenterHex = nearestCell(primary.x, primary.y).hex;

  // ---- analyst zones: coarse, lagged forecast plus two deliberate mistakes ----
  const forecast = new Map<HexId, number>();
  if (sc.kind === 'hurricane') {
    const lag = (quirkRng.chance(0.5) ? 1 : -1) * quirkRng.range(1.0, 2.0);
    const ft = new HurricaneTrack(sc, base, lag);
    for (const c of cells) forecast.set(c.hex, hurricaneScore(ft.wind(c), Math.max(0, ft.waterLevelFt(c) - elevFt(c))));
    notes.push(`Analyst zones use the forecast track shifted ${lag.toFixed(2)} km sideways, no rain pockets, smoothed over neighbours.`);
  } else {
    // analysts map a smoothed ShakeMap (radius-2 mean) and ignore liquefaction
    for (const c of cells) {
      const ring = ringIn(hexSet, c.hex, 2);
      // x1.5 maps the zone cut-offs (1.0 / 1.9) to smoothed MMI ~7.9 (zone 1) and ~8.8 (zone 2)
      forecast.set(c.hex, 1.5 * shakeScore(ring.reduce((a, n) => a + mmi.get(n)!, 0) / ring.length));
    }
    notes.push('Analyst zones use the ShakeMap smoothed over a radius-2 neighbourhood and ignore liquefaction.');
  }
  for (const h of hexes) {
    const ring = ringIn(hexSet, h.hex, 1);
    const mean = ring.reduce((a, n) => a + forecast.get(n)!, 0) / ring.length;
    h.analystZone = mean >= 1.9 ? 2 : mean >= 1.0 ? 1 : 0;
  }
  const cellByHex = base.cellByHex;
  const kmBetween = (a: HexId, b: HexId) => {
    const ca = cellByHex.get(a)!, cb = cellByHex.get(b)!;
    return greatCircleDistance([ca.lat, ca.lng], [cb.lat, cb.lng], 'km');
  };
  const interiorAll = cells.map((c) => c.hex).filter((h) => ringIn(hexSet, h, 2).length >= 16);
  const interior = interiorAll.length ? interiorAll : cells.map((c) => c.hex);
  const scoreHex = (h: HexId) => scoreOf(cellByHex.get(h)!);
  const hard = interior.filter((h) => kmBetween(h, trackOutageCenterHex) > 3.5).sort((a, b) => scoreHex(b) - scoreHex(a)).slice(0, 12);
  const underMarkedCenterHex = quirkRng.pick(hard.length ? hard : interior);
  const underMarkedHexes = ringIn(hexSet, underMarkedCenterHex, 2).sort();
  for (const h of underMarkedHexes) {
    const c = cellOut.get(h)!;
    c.analystZone = (quirkRng.chance(0.7) ? Math.min(c.analystZone, 1) : 0) as 0 | 1 | 2;
  }
  const lowC = interior.filter((h) => kmBetween(h, underMarkedCenterHex) > 3.5 && scoreHex(h) < 0.6);
  const overMarkedCenterHex = quirkRng.pick(lowC.length ? lowC : interior);
  const overMarkedHexes = ringIn(hexSet, overMarkedCenterHex, 2).sort();
  for (const h of overMarkedHexes) cellOut.get(h)!.analystZone = quirkRng.chance(0.75) ? 2 : 1;
  const distC = interior.filter((h) => { const z = scoreHex(h); return z >= 0.4 && z <= 1.6 && kmBetween(h, overMarkedCenterHex) > 2.5; });
  const overReportingDistrictCenterHex = quirkRng.pick(distC.length ? distC : interior);
  const overReportingDistrictHexes = ringIn(hexSet, overReportingDistrictCenterHex, 3).sort();
  const districtSet = new Set(overReportingDistrictHexes);

  // ---- households ----
  const { households, hidden } = sampleHouseholds(base, data, {
    eventId: `${opt.regionPrefix}-${sc.eventId}`, seed: sc.seed, households: opt.households,
    holdoutShare: HOLDOUT_SHARE, hazardType: sc.kind,
  });
  // Local clock: hurricanes are forecast days ahead (schools/offices closed, people sheltering), so
  // work/school-hours effects apply only to earthquakes, which strike without warning.
  const { hour: eventLocalHour, weekday: eventWeekday } = localTime(sc.landfallIso, data.region.tz);
  const workHours = eventWeekday && eventLocalHour >= 8 && eventLocalHour < 18;
  const schoolHours = eventWeekday && eventLocalHour >= 8 && eventLocalHour < 15;
  const daytime = isQuake && workHours;
  const schoolInSession = isQuake && schoolHours;
  const schoolHex = new Map(base.schools.map((f) => [f.id, f.hex]));
  /** Parents with school-age children whose nearest school is in a high-hazard cell (reunification need). */
  const reunify = (hh: { schoolAgeChildren?: number; nearestSchoolId?: string }) => {
    if (!schoolInSession || !hh.schoolAgeChildren || !hh.nearestSchoolId) return false;
    const h = schoolHex.get(hh.nearestSchoolId);
    return h !== undefined && (cellOut.get(h)?.hazardIndex ?? 0) >= 0.5;
  };

  // ---- truth ----
  const truth: TruthRow[] = [];
  const truthById = new Map<string, TruthRow>();
  const houseFlood = new Map<string, number>();
  for (const hh of households) {
    const c = cellByHex.get(hh.hex)!;
    const hc = cellOut.get(hh.hex)!;
    const hid = hidden.get(hh.id)!;
    let sev: number;
    let peril: Peril;
    let hf = 0;
    if (sc.kind === 'hurricane') {
      const hw = hc.windMph * (1 + truthRng.normal(0, 0.05));
      hf = hc.floodDepthFt > 0 ? Math.max(0, hc.floodDepthFt + truthRng.normal(0, 0.8)) : 0;
      const w = windScore(hw) + truthRng.normal(0, 0.35) + (hh.mobileHome ? 0.9 : 0) + (hid.olderBuilding ? 0.15 : 0);
      const f = floodScore(hf) + (hf > 0 ? truthRng.normal(0, 0.35) : 0);
      sev = Math.max(w, f) + 0.25 * Math.max(0, Math.min(w, f)) + (hid.vulnerable ? 0.7 : 0) + truthRng.normal(0, 0.3);
      peril = f > w ? 'flood' : 'wind';
    } else {
      const hm = mmi.get(hh.hex)! + truthRng.normal(0, 0.3);
      const inLiq = truthRng.chance(c.liquefaction);
      sev = shakeScore(hm) + (hid.olderBuilding ? 0.35 : 0) + (hh.mobileHome ? 0.4 : 0) + (hid.vulnerable ? 0.7 : 0)
        + (inLiq && hm >= 7 ? Math.max(0, truthRng.normal(0.8, 0.3)) : 0) + truthRng.normal(0, 0.3);
      peril = 'earthquake';
    }
    houseFlood.set(hh.id, hf);
    const damage: Damage = sev < 1.0 ? 0 : sev < 1.8 ? 1 : sev < 2.6 ? 2 : 3;
    const awayNow = daytime && hh.awayDaytime === true;
    const z = -4.6
      + (damage === 3 ? 1.9 : damage === 2 ? 0.8 : 0)
      + (hh.age65 ? 0.5 : 0)
      + (hh.age65 && hh.livesAlone ? 1.2 : 0)
      + (hh.age75 ? 0.5 : 0)
      + (hh.disability ? 0.7 : 0)
      + (hh.medicalDevice && hc.towerOutagePct > 60 ? 1.8 : hh.medicalDevice ? 0.5 : 0)
      + (hh.noVehicle ? (sc.kind === 'hurricane' ? 0.4 + (hf > 4 ? 0.6 : 0) : 0.2) : 0)
      + (hf > 4 ? 0.6 : 0)
      + (awayNow ? -1.8 : 0);
    const safety = truthRng.chance(sigmoid(z)) ? 'needs_help' : 'safe';
    const needType = truthNeedType(needsRng, hh, { safety, damage, floodFt: hf, outagePct: hc.towerOutagePct, hazard: sc.kind });
    const location = truthLocation(needsRng, awayNow, damage, needType);
    const returnMin = truthReturnMin(needsRng, location);
    const row: TruthRow = { householdId: hh.id, damage, safety, peril: damage === 0 ? 'none' : peril, needType, location, ...(returnMin !== undefined ? { returnMin } : {}) };
    truth.push(row);
    truthById.set(hh.id, row);
  }

  // ---- events ----
  const events: SimEvent[] = [];
  let texts = 0;
  for (const hh of households) {
    const hc = cellOut.get(hh.hex)!;
    const tr = truthById.get(hh.id)!;
    const o = hc.towerOutagePct / 100;
    const awayNow = daytime && hh.awayDaytime === true;
    if (hh.phoneOnFile) {
      const tSent = smsRng.int(isQuake ? 20 : 60, isQuake ? 120 : 180);
      events.push({ kind: 'sms_sent', t: tSent, householdId: hh.id });
      let p = 0.78 * Math.pow(Math.max(0, 1 - o), 1.6);
      if (hh.age65) p *= 0.7;
      if (hh.age75) p *= 0.85;
      if (tr.damage === 3) p *= 0.6;
      if (tr.safety === 'needs_help') p *= 0.5;
      if (hh.limitedEnglish) p *= 0.55; // check-in SMS is English-only
      if (awayNow) p *= 0.6;            // not home: silence without danger
      const parentCheckIn = reunify(hh);
      if (parentCheckIn) p = Math.min(0.95, p * 1.25); // parents check in quickly when they can
      if (smsRng.chance(p)) {
        const delay = smsRng.lognormal(40 * (1 + 20 * o * o), 1.1) * (parentCheckIn ? 0.5 : 1);
        const tReply = Math.round(tSent + delay);
        let dmg = tr.damage + (smsRng.chance(awayNow ? 0.5 : 0.3) ? (smsRng.chance(0.5) ? 1 : -1) : 0);
        if (districtSet.has(hh.hex) && smsRng.chance(0.45)) dmg += 1;
        if (hh.age65 && smsRng.chance(0.3)) dmg -= 1;
        const safety = tr.safety === 'needs_help'
          ? (smsRng.chance(0.85) ? 'needs_help' : 'safe')
          : (smsRng.chance(0.03) ? 'needs_help' : 'safe');
        const damage = clampDamage(dmg);
        // free text for ~25% of replies (fixed draw order keeps the structured stream identical with/without text)
        const wantText = smsRng.chance(0.25);
        if (tReply <= HORIZON_MIN) {
          const l = replyLabels(labelRng, hh, { safety, damage }, { needType: tr.needType!, location: locationAt(tr, tReply) }, { outagePct: hc.towerOutagePct, hazard: sc.kind });
          const ev: SimEvent = {
            kind: 'sms_reply', t: tReply, householdId: hh.id, safety, damage: l.damage,
            lifeSafety: l.lifeSafety, needs: l.needs, notHome: l.notHome, channel: 'sms',
          };
          if (wantText) {
            const lang = replyLanguage(textRng, hh);
            // The text renders the labels; its damage is what the words actually say (null if the house is not described).
            const out = replyText(textRng, lang, {
              hh, safety, damage: l.damage, lifeSafety: l.lifeSafety, needs: l.needs, location: locationAt(tr, tReply),
              hazardType: sc.kind, outagePct: hc.towerOutagePct, floodFt: houseFlood.get(hh.id)!,
            });
            ev.text = out.text;
            ev.damage = out.damage;
            ev.needs = out.needs;
            ev.language = lang;
            texts++;
          }
          events.push(ev);
        }
      }
    }
    // claims
    let peril: Peril;
    if (tr.peril !== 'none') peril = tr.peril;
    else peril = isQuake ? 'earthquake' : (floodScore(hc.floodDepthFt) > windScore(hc.windMph) ? 'flood' : 'wind');
    let pc = [0.03, 0.35, 0.75, 0.9][tr.damage]!;
    if (peril === 'flood' && !hh.floodPolicy) pc *= 0.15;
    if (peril === 'wind' && !hh.windCovered) pc *= 0.2;
    if (peril === 'earthquake' && !hh.earthquakeEndorsement) pc *= 0.08;
    // renters insure contents / additional living expense only (structure is the landlord's policy);
    // condo (HO-6) policies cover the interior only (assumptions)
    if (hh.policyType === 'renters') pc *= [1, 0.3, 0.5, 0.7][tr.damage]!;
    else if (hh.policyType === 'condo') pc *= [1, 0.8, 0.8, 0.9][tr.damage]!;
    if (claimRng.chance(pc)) {
      const medianH = 8 * Math.exp(3 * o * o) * (1 + 0.3 * tr.damage) * (awayNow ? 1.3 : 1);
      const tClaim = Math.round(30 + claimRng.lognormal(medianH, 0.8) * 60);
      const r = claimRng.float();
      const reported = clampDamage(tr.damage + (r < 0.15 ? 1 : r < 0.25 ? -1 : 0));
      if (tClaim <= HORIZON_MIN) events.push({ kind: 'claim', t: tClaim, householdId: hh.id, peril, reportedDamage: reported });
    }
  }
  if (opt.fieldReports) {
    const pool = households.filter((hh) => !hh.holdout);
    const n = Math.round(FIELD_REPORT_SHARE * pool.length);
    const adjusters = Array.from({ length: 20 }, (_, i) => `adj-${String(i + 1).padStart(2, '0')}`);
    for (const hh of fieldRng.shuffle(pool).slice(0, n)) {
      const tr = truthById.get(hh.id)!;
      const tField = fieldRng.int(1440, HORIZON_MIN);
      events.push({
        kind: 'field_report', t: tField, householdId: hh.id,
        // Nobody home (away / displaced at that time): the adjuster inspects the house but cannot see the occupants.
        adjusterId: fieldRng.pick(adjusters), safety: fieldRng.chance(0.06) || locationAt(tr, tField) !== 'home' ? 'unsure' : tr.safety, damage: tr.damage,
      });
    }
  }
  const kindOrder: Record<SimEvent['kind'], number> = { sms_sent: 0, sms_reply: 1, claim: 2, field_report: 3 };
  events.sort((a, b) => a.t - b.t || kindOrder[a.kind] - kindOrder[b.kind] || (a.householdId < b.householdId ? -1 : a.householdId > b.householdId ? 1 : 0));
  notes.push(`${texts} sms_reply events carry free text.`);
  const reunifyCountAll = households.filter(reunify).length;
  notes.push(`Local time ${eventLocalHour}:00 ${eventWeekday ? 'weekday' : 'weekend'} (${data.region.tz}); work hours ${daytime ? 'apply' : 'do not apply'}; school in session: ${schoolInSession}. Households with a reunification need (school-age children, nearest school in a cell with hazardIndex >= 0.5, school in session): ${reunifyCountAll}.`);

  const r = data.region;
  const bundle: EventBundle = {
    world: {
      eventId: sc.eventId,
      name: sc.name,
      landfallIso: sc.landfallIso,
      center: { lat: r.center.lat, lng: r.center.lng },
      hexes,
      households,
      region: r.id,
      hazardType: sc.kind,
      facilities: base.facilities,
      dataSources: opt.dataSources,
      eventLocalHour,
      eventWeekday,
    },
    events,
    truth,
  };
  return {
    bundle,
    meta: {
      eventId: sc.eventId, hazardType: sc.kind, trackOutageCenterHex,
      underMarkedCenterHex, underMarkedHexes, overMarkedCenterHex, overMarkedHexes,
      overReportingDistrictCenterHex, overReportingDistrictHexes, reunificationHouseholds: reunifyCountAll, notes,
    },
  };
}

