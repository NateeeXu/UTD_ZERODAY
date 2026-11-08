// Builds one EventBundle (world + events + truth) from an EventConfig.
// All data is synthetic. See data/README.md for the generation model.

import { cellToLatLng, gridDisk, latLngToCell, greatCircleDistance } from 'h3-js';
import type {
  Damage, EventBundle, HexCell, HexId, Household, Peril, SimEvent, TruthRow,
} from '../../shared/types.ts';
import type { EventConfig, StormConfig } from './config.ts';
import {
  FIELD_REPORT_SHARE, GRID_RADIUS, H3_RESOLUTION, HOLDOUT_SHARE, HORIZON_MIN,
} from './config.ts';
import { Rng, subSeed } from './rng.ts';
import { replyLabels, truthLocation, truthNeedType, locationAt } from './needs.ts';

/** Diagnostics about deliberate quirks, written to data/sim-meta.json (not part of the contract). */
export interface WorldMeta {
  eventId: string;
  trackOutageCenterHex: HexId;
  underMarkedCenterHex: HexId;
  underMarkedHexes: HexId[];
  overMarkedCenterHex: HexId;
  overMarkedHexes: HexId[];
  overReportingDistrictCenterHex: HexId;
  overReportingDistrictHexes: HexId[];
}

const KM_PER_DEG_LAT = 110.574;

const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clampDamage = (v: number): Damage => clamp(Math.round(v), 0, 3) as Damage;
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** Local flat projection (km) around the event center. */
class Projection {
  private lat0: number;
  private lng0: number;
  private kmPerDegLng: number;
  constructor(lat0: number, lng0: number) {
    this.lat0 = lat0;
    this.lng0 = lng0;
    this.kmPerDegLng = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  }
  x(lng: number): number { return (lng - this.lng0) * this.kmPerDegLng; }
  y(lat: number): number { return (lat - this.lat0) * KM_PER_DEG_LAT; }
}

interface Blob { x: number; y: number; r: number; amp: number }
const blobSum = (blobs: Blob[], x: number, y: number): number => {
  let s = 0;
  for (const b of blobs) {
    const d2 = (x - b.x) ** 2 + (y - b.y) ** 2;
    s += b.amp * Math.exp(-d2 / (2 * b.r * b.r));
  }
  return s;
};

/** Storm geometry in local km; y is measured from the coastline (south edge). */
class Track {
  private s: StormConfig;
  private tanH: number;
  private cosH: number;
  constructor(s: StormConfig) {
    this.s = s;
    const h = (s.headingDeg * Math.PI) / 180;
    this.tanH = Math.tan(h);
    this.cosH = Math.cos(h);
  }
  /** Track x position at distance `dc` km inland. */
  xAt(dc: number): number {
    return this.s.coastCrossKm + this.tanH * dc + this.s.curvature * dc * dc;
  }
  /** Signed perpendicular distance (km); positive = right of track (stronger side). */
  signedDist(x: number, dc: number): number {
    return (x - this.xAt(dc)) * this.cosH;
  }
}

/** Wind / flood scores on a shared ~0-3 scale; used by truth damage and analyst zones. */
const windScore = (wind: number): number => Math.max(0, (wind - 60) / 26);
const floodScore = (depth: number): number => Math.max(0, depth / 2.7);

function windField(s: StormConfig, track: Track, x: number, dc: number): number {
  const sd = track.signedDist(x, dc);
  const side = sd > 0 ? 1 : 0.82;
  const inland = 1 - 0.011 * dc;
  return 40 + (s.vmaxMph - 40) * Math.exp(-Math.abs(sd) / s.windDecayKm) * side * inland;
}

function surgeField(s: StormConfig, track: Track, x: number, dc: number): number {
  const sd = track.signedDist(x, dc);
  const along = Math.exp(-(((sd - 3) / 9) ** 2));
  return s.surgeFt * Math.exp(-dc / s.surgeInlandKm) * (0.3 + 0.7 * along);
}

export function generateBundle(cfg: EventConfig): { bundle: EventBundle; meta: WorldMeta } {
  const hazardRng = new Rng(subSeed(cfg.seed, 'hazard'));
  const placeRng = new Rng(subSeed(cfg.seed, 'place'));
  const attrRng = new Rng(subSeed(cfg.seed, 'attrs'));
  const truthRng = new Rng(subSeed(cfg.seed, 'truth'));
  const smsRng = new Rng(subSeed(cfg.seed, 'sms'));
  const claimRng = new Rng(subSeed(cfg.seed, 'claims'));
  const fieldRng = new Rng(subSeed(cfg.seed, 'field'));
  const quirkRng = new Rng(subSeed(cfg.seed, 'quirks'));
  // v3 labels use their own streams so the truth / sms / claim streams above do not shift.
  const needsRng = new Rng(subSeed(cfg.seed, 'needs'));
  const labelRng = new Rng(subSeed(cfg.seed, 'labels'));

  const s = cfg.storm;
  const track = new Track(s);
  const proj = new Projection(cfg.center.lat, cfg.center.lng);

  // ---- Grid ------------------------------------------------------------
  const centerHex = latLngToCell(cfg.center.lat, cfg.center.lng, H3_RESOLUTION);
  const hexIds = gridDisk(centerHex, GRID_RADIUS).slice().sort();
  const hexSet = new Set(hexIds);
  const geo = new Map<HexId, { lat: number; lng: number; x: number; y: number }>();
  for (const h of hexIds) {
    const [lat, lng] = cellToLatLng(h);
    geo.set(h, { lat, lng, x: proj.x(lng), y: proj.y(lat) });
  }
  const yCoast = Math.min(...[...geo.values()].map((g) => g.y)) - 0.3;
  const ys = [...geo.values()].map((g) => g.y - yCoast);
  const xs = [...geo.values()].map((g) => g.x);
  const dcMax = Math.max(...ys);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const g = (h: HexId) => geo.get(h)!;
  const dcOf = (h: HexId) => g(h).y - yCoast;

  // ---- Hazard ----------------------------------------------------------
  // Rain-driven flooding pockets (bayous / low-lying streets).
  const rainBlobs: Blob[] = [];
  for (let i = 0; i < 3; i++) {
    rainBlobs.push({
      x: hazardRng.range(xMin, xMax), y: hazardRng.range(2, dcMax),
      r: hazardRng.range(0.8, 1.6), amp: hazardRng.range(1.2, 3.0) * (s.surgeFt / 10),
    });
  }
  // Tower outage clusters: one on the track near the coast (the hardest-hit area loses towers),
  // plus a few random ones.
  const trackDc = hazardRng.range(1.5, 4.5);
  const outageBlobs: Blob[] = [
    { x: track.xAt(trackDc) + 1.0, y: trackDc, r: 1.7, amp: 95 },
  ];
  for (let i = 0; i < s.extraOutageClusters; i++) {
    outageBlobs.push({
      x: hazardRng.range(xMin, xMax), y: hazardRng.range(0, dcMax),
      r: hazardRng.range(0.9, 1.7), amp: hazardRng.range(45, 80),
    });
  }

  const hexes: HexCell[] = [];
  const hexByIdx = new Map<HexId, HexCell>();
  for (const h of hexIds) {
    const { lat, lng, x } = g(h);
    const dc = dcOf(h);
    const wind = clamp(windField(s, track, x, dc) + hazardRng.normal(0, 3.5), 35, 155);
    let flood = surgeField(s, track, x, dc) + blobSum(rainBlobs, x, dc) + hazardRng.normal(0, 0.25);
    if (flood < 0.5) flood = 0;
    const baseOutage = 85 * sigmoid((wind - 116) / 8);
    const outage = clamp(baseOutage + blobSum(outageBlobs, x, dc) + hazardRng.normal(0, 4), 0, 100);
    const cell: HexCell = {
      hex: h, lat: round(lat, 6), lng: round(lng, 6),
      windMph: Math.round(wind), floodDepthFt: round(flood, 1),
      towerOutagePct: Math.round(outage), analystZone: 0,
    };
    hexes.push(cell);
    hexByIdx.set(h, cell);
  }
  const cellOf = (h: HexId) => hexByIdx.get(h)!;
  const cellHazard = (c: HexCell) => {
    const w = windScore(c.windMph);
    const f = floodScore(c.floodDepthFt);
    return Math.max(w, f) + 0.3 * Math.min(w, f);
  };

  // ---- Analyst zones ---------------------------------------------------
  // Coarse and lagged: computed from the pre-landfall forecast track (shifted ~1.5 km, no
  // rain pockets, no local noise), then smoothed over neighbours.
  const lagShift = (quirkRng.chance(0.5) ? 1 : -1) * quirkRng.range(1.0, 2.0);
  const forecastScore = new Map<HexId, number>();
  for (const h of hexIds) {
    const x = g(h).x - lagShift;
    const dc = dcOf(h);
    const w = windScore(windField(s, track, x, dc));
    const f = floodScore(surgeField(s, track, x, dc));
    forecastScore.set(h, Math.max(w, f) + 0.3 * Math.min(w, f));
  }
  for (const c of hexes) {
    const ring = gridDisk(c.hex, 1).filter((n) => hexSet.has(n));
    const mean = ring.reduce((a, n) => a + forecastScore.get(n)!, 0) / ring.length;
    c.analystZone = mean >= 1.9 ? 2 : mean >= 1.0 ? 1 : 0;
  }
  // Deliberate mistake 1: a genuinely hard-hit cluster left (mostly) unmarked.
  // Chosen among high-hazard cells away from the track outage cluster so the two quirks are distinct.
  const kmPerDegLng = 111.32 * Math.cos((cfg.center.lat * Math.PI) / 180);
  const outageCenter = latLngToCell(
    cfg.center.lat + (outageBlobs[0]!.y + yCoast) / KM_PER_DEG_LAT,
    cfg.center.lng + outageBlobs[0]!.x / kmPerDegLng,
    H3_RESOLUTION,
  );
  const trackOutageCenterHex = hexSet.has(outageCenter)
    ? outageCenter
    : hexes.slice().sort((a, b) => b.towerOutagePct - a.towerOutagePct)[0]!.hex;
  const interior = hexIds.filter((h) => gridDisk(h, 2).every((n) => hexSet.has(n)));
  const farFrom = (h: HexId, other: HexId, km: number) => {
    const a = g(h);
    const b = g(other);
    return greatCircleDistance([a.lat, a.lng], [b.lat, b.lng], 'km') > km;
  };
  const hardCandidates = interior
    .filter((h) => farFrom(h, trackOutageCenterHex, 3.5))
    .sort((a, b) => cellHazard(cellOf(b)) - cellHazard(cellOf(a)))
    .slice(0, 12);
  const underMarkedCenterHex = quirkRng.pick(hardCandidates.length ? hardCandidates : interior);
  const underMarkedHexes = gridDisk(underMarkedCenterHex, 2).filter((n) => hexSet.has(n)).sort();
  for (const h of underMarkedHexes) {
    const c = cellOf(h);
    c.analystZone = (quirkRng.chance(0.7) ? Math.min(c.analystZone, 1) : 0) as 0 | 1 | 2;
  }
  // Deliberate mistake 2: an over-marked low-hazard area.
  const lowCandidates = interior
    .filter((h) => farFrom(h, underMarkedCenterHex, 3.5) && cellHazard(cellOf(h)) < 0.6);
  const overMarkedCenterHex = quirkRng.pick(lowCandidates.length ? lowCandidates : interior);
  const overMarkedHexes = gridDisk(overMarkedCenterHex, 2).filter((n) => hexSet.has(n)).sort();
  for (const h of overMarkedHexes) {
    cellOf(h).analystZone = quirkRng.chance(0.75) ? 2 : 1;
  }
  // Over-reporting district (SMS bias): a moderate-hazard area.
  const districtCandidates = interior.filter((h) => {
    const z = cellHazard(cellOf(h));
    return z >= 0.4 && z <= 1.6 && farFrom(h, overMarkedCenterHex, 2.5);
  });
  const overReportingDistrictCenterHex = quirkRng.pick(districtCandidates.length ? districtCandidates : interior);
  const overReportingDistrictHexes = gridDisk(overReportingDistrictCenterHex, 3).filter((n) => hexSet.has(n)).sort();
  const districtSet = new Set(overReportingDistrictHexes);

  // ---- Households ------------------------------------------------------
  // Population density: a couple of town centres plus lognormal cell noise; min 2 per cell.
  const townBlobs: Blob[] = [];
  for (let i = 0; i < 3; i++) {
    townBlobs.push({ x: placeRng.range(xMin * 0.7, xMax * 0.7), y: placeRng.range(1, dcMax * 0.8), r: placeRng.range(1.5, 3), amp: placeRng.range(1, 2.5) });
  }
  const weights = hexIds.map((h) => placeRng.lognormal(1, 0.6) * (0.4 + blobSum(townBlobs, g(h).x, dcOf(h))));
  const minPer = 2;
  const remaining = cfg.households - minPer * hexIds.length;
  const wSum = weights.reduce((a, b) => a + b, 0);
  const counts = weights.map((w) => minPer + Math.floor((w / wSum) * remaining));
  let deficit = cfg.households - counts.reduce((a, b) => a + b, 0);
  while (deficit > 0) {
    counts[placeRng.int(0, counts.length - 1)]! += 1;
    deficit--;
  }

  const households: Household[] = [];
  let seq = 0;
  hexIds.forEach((h, i) => {
    const c = g(h);
    for (let k = 0; k < counts[i]!; k++) {
      let lat = c.lat;
      let lng = c.lng;
      for (let attempt = 0; attempt < 30; attempt++) {
        const r = 0.45 * Math.sqrt(placeRng.float());
        const a = placeRng.range(0, 2 * Math.PI);
        const la = c.lat + (r * Math.sin(a)) / KM_PER_DEG_LAT;
        const ln = c.lng + (r * Math.cos(a)) / kmPerDegLng;
        if (latLngToCell(la, ln, H3_RESOLUTION) === h) { lat = la; lng = ln; break; }
      }
      seq++;
      const dc = clamp(proj.y(lat) - yCoast, 0, 99);
      const age65 = attrRng.chance(0.2);
      const livesAlone = attrRng.chance(age65 ? 0.25 : 0.1);
      const medicalDevice = attrRng.chance(age65 ? 0.09 : 0.0275);
      const windCovered = attrRng.chance(0.97);
      const floodPolicy = attrRng.chance(0.1 + 0.5 * Math.exp(-dc / 5));
      const earthquakeEndorsement = attrRng.chance(0.05);
      const phoneOnFile = attrRng.chance(0.88);
      households.push({
        id: `${cfg.eventId}-h${String(seq).padStart(5, '0')}`,
        hex: h, lat: round(lat, 6), lng: round(lng, 6),
        age65, livesAlone, medicalDevice, windCovered, floodPolicy, earthquakeEndorsement, phoneOnFile,
        holdout: false,
      });
    }
  });
  // Holdout: exactly 15%, chosen uniformly at random.
  const holdoutCount = Math.round(HOLDOUT_SHARE * households.length);
  for (const hh of attrRng.shuffle(households).slice(0, holdoutCount)) hh.holdout = true;

  // ---- Truth -----------------------------------------------------------
  const truth: TruthRow[] = [];
  const truthById = new Map<string, TruthRow>();
  for (const hh of households) {
    const c = cellOf(hh.hex);
    const houseWind = c.windMph * (1 + truthRng.normal(0, 0.05));
    const houseFlood = c.floodDepthFt > 0 ? Math.max(0, c.floodDepthFt + truthRng.normal(0, 0.8)) : 0;
    const vulnerable = truthRng.chance(0.06) ? 0.7 : 0; // e.g. mobile homes, older construction
    const w = windScore(houseWind) + truthRng.normal(0, 0.35);
    const f = floodScore(houseFlood) + (houseFlood > 0 ? truthRng.normal(0, 0.35) : 0);
    const sev = Math.max(w, f) + 0.25 * Math.max(0, Math.min(w, f)) + vulnerable + truthRng.normal(0, 0.3);
    const damage: Damage = sev < 1.0 ? 0 : sev < 1.8 ? 1 : sev < 2.6 ? 2 : 3;
    const peril: Peril | 'none' = damage === 0 ? 'none' : f > w ? 'flood' : 'wind';
    const z = -4.6
      + (damage === 3 ? 1.9 : damage === 2 ? 0.8 : 0)
      + (hh.age65 ? 0.5 : 0)
      + (hh.age65 && hh.livesAlone ? 1.2 : 0)
      + (hh.medicalDevice && c.towerOutagePct > 60 ? 1.8 : hh.medicalDevice ? 0.5 : 0)
      + (houseFlood > 4 ? 0.6 : 0);
    const safety = truthRng.chance(sigmoid(z)) ? 'needs_help' : 'safe';
    const needType = truthNeedType(needsRng, hh, { safety, damage, floodFt: houseFlood, outagePct: c.towerOutagePct, hazard: 'hurricane' });
    const location = truthLocation(needsRng, false, damage, needType); // night-time storm: nobody is away
    const row: TruthRow = { householdId: hh.id, damage, safety, peril, needType, location };
    truth.push(row);
    truthById.set(hh.id, row);
  }

  // ---- Events ----------------------------------------------------------
  const events: SimEvent[] = [];
  for (const hh of households) {
    const c = cellOf(hh.hex);
    const tr = truthById.get(hh.id)!;
    const o = c.towerOutagePct / 100;

    // SMS check-in: only to policyholders with a phone on file.
    if (hh.phoneOnFile) {
      const tSent = smsRng.int(60, 180);
      events.push({ kind: 'sms_sent', t: tSent, householdId: hh.id });
      let p = 0.78 * Math.pow(Math.max(0, 1 - o), 1.6);
      if (hh.age65) p *= 0.7;
      if (tr.damage === 3) p *= 0.6;
      if (tr.safety === 'needs_help') p *= 0.5;
      if (smsRng.chance(p)) {
        const delay = smsRng.lognormal(40 * (1 + 20 * o * o), 1.1);
        const tReply = Math.round(tSent + delay);
        let dmg = tr.damage + (smsRng.chance(0.3) ? (smsRng.chance(0.5) ? 1 : -1) : 0);
        if (districtSet.has(hh.hex) && smsRng.chance(0.45)) dmg += 1; // over-reporting district
        if (hh.age65 && smsRng.chance(0.3)) dmg -= 1; // seniors under-report
        const safety = tr.safety === 'needs_help'
          ? (smsRng.chance(0.85) ? 'needs_help' : 'safe')
          : (smsRng.chance(0.03) ? 'needs_help' : 'safe');
        if (tReply <= HORIZON_MIN) {
          const l = replyLabels(labelRng, hh, { safety, damage: clampDamage(dmg) }, { needType: tr.needType!, location: locationAt(tr, tReply) }, { outagePct: c.towerOutagePct, hazard: 'hurricane' });
          events.push({
            kind: 'sms_reply', t: tReply, householdId: hh.id, safety, damage: l.damage,
            lifeSafety: l.lifeSafety, needs: l.needs, notHome: l.notHome, channel: 'sms',
          });
        }
      }
    }

    // Claims: more likely with damage; rare for uncovered perils; delayed by outage and severity.
    const peril: Peril = tr.peril !== 'none'
      ? tr.peril
      : (floodScore(c.floodDepthFt) > windScore(c.windMph) ? 'flood' : 'wind');
    let pc = [0.03, 0.35, 0.75, 0.9][tr.damage]!;
    if (peril === 'flood' && !hh.floodPolicy) pc *= 0.15;
    if (peril === 'wind' && !hh.windCovered) pc *= 0.2;
    if (claimRng.chance(pc)) {
      const medianH = 8 * Math.exp(3 * o * o) * (1 + 0.3 * tr.damage);
      const tClaim = Math.round(30 + claimRng.lognormal(medianH, 0.8) * 60);
      const r = claimRng.float();
      const reported = clampDamage(tr.damage + (r < 0.15 ? 1 : r < 0.25 ? -1 : 0));
      if (tClaim <= HORIZON_MIN) {
        events.push({ kind: 'claim', t: tClaim, householdId: hh.id, peril, reportedDamage: reported });
      }
    }
  }

  // Field reports (backtests only): random non-holdout sample, days 1-3, equal to truth
  // except that a few safety answers are 'unsure'.
  if (cfg.fieldReports) {
    const pool = households.filter((hh) => !hh.holdout);
    const n = Math.round(FIELD_REPORT_SHARE * pool.length);
    const adjusters = Array.from({ length: 10 }, (_, i) => `adj-${String(i + 1).padStart(2, '0')}`);
    for (const hh of fieldRng.shuffle(pool).slice(0, n)) {
      const tr = truthById.get(hh.id)!;
      const tField = fieldRng.int(1440, HORIZON_MIN);
      events.push({
        kind: 'field_report',
        t: tField,
        householdId: hh.id,
        adjusterId: fieldRng.pick(adjusters),
        // Nobody home (displaced): the adjuster inspects the house but cannot see the occupants.
        safety: fieldRng.chance(0.06) || locationAt(tr, tField) !== 'home' ? 'unsure' : tr.safety,
        damage: tr.damage,
      });
    }
  }

  const kindOrder: Record<SimEvent['kind'], number> = { sms_sent: 0, sms_reply: 1, claim: 2, field_report: 3 };
  events.sort((a, b) => a.t - b.t || kindOrder[a.kind] - kindOrder[b.kind] || (a.householdId < b.householdId ? -1 : a.householdId > b.householdId ? 1 : 0));

  const bundle: EventBundle = {
    world: {
      eventId: cfg.eventId,
      name: cfg.name,
      landfallIso: cfg.landfallIso,
      center: { lat: cfg.center.lat, lng: cfg.center.lng },
      hexes,
      households,
    },
    events,
    truth,
  };
  const meta: WorldMeta = {
    eventId: cfg.eventId,
    trackOutageCenterHex,
    underMarkedCenterHex, underMarkedHexes,
    overMarkedCenterHex, overMarkedHexes,
    overReportingDistrictCenterHex, overReportingDistrictHexes,
  };
  return { bundle, meta };
}
