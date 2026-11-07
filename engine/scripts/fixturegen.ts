// Small contract-conforming synthetic worlds for engine testing. This is NOT
// the project simulator (see sim/); it only exists so the engine can be
// exercised before data/ is produced. Pure: seeded RNG, no I/O.

import type { Damage, EventBundle, HexCell, Household, SimEvent, TruthRow } from '../../shared/types.ts';
import { chance, hashString, mulberry32, randInt, randNormal } from '../src/rng.ts';
import type { Rng } from '../src/rng.ts';
import { clamp, clamp01 } from '../src/config.ts';

export interface FixtureOptions {
  eventId: string;
  name: string;
  seed: number;
  households: number;
  /** Hex grid radius: 2 -> 19 cells, 3 -> 37 cells, 4 -> 61 cells. */
  gridRadius: number;
  withFieldReports: boolean;
  landfallIso: string;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function sampleDamage(sev: number): Damage {
  if (sev < 1.0) return 0;
  if (sev < 1.8) return 1;
  if (sev < 2.6) return 2;
  return 3;
}

export function generateBundle(opts: FixtureOptions): EventBundle {
  const rng: Rng = mulberry32((opts.seed ^ hashString(opts.eventId)) >>> 0);
  const center = { lat: 28.7 + randNormal(rng) * 0.05, lng: -96.2 + randNormal(rng) * 0.05 };
  const R = opts.gridRadius;

  // Hex grid in axial coordinates, flat local km projection; south edge is the coast.
  const cells: HexCell[] = [];
  const axial: { q: number; r: number }[] = [];
  const trackAngle = ((randInt(rng, -30, 30) * Math.PI) / 180);
  const trackOffset = randNormal(rng) * 1.5;
  const vmax = 100 + randInt(rng, 0, 40);
  const surge = 3 + rng.next() * 5;
  const outageCluster = { q: randInt(rng, -1, 1), r: R - 1 - randInt(rng, 0, 1) };
  for (let q = -R; q <= R; q++) {
    for (let r = -R; r <= R; r++) {
      if (Math.abs(q + r) > R) continue;
      const x = 1.6 * (q + r / 2); // km east
      const y = -1.4 * r; // km north (r grows southwards -> coast at r = R)
      const dc = 1.4 * (R - r) + 0.5; // distance inland from coast
      const d = Math.abs(Math.cos(trackAngle) * x - Math.sin(trackAngle) * y - trackOffset);
      const side = Math.cos(trackAngle) * x - Math.sin(trackAngle) * y - trackOffset > 0 ? 1 : 0.82;
      const wind = clamp(Math.round(40 + (vmax - 40) * Math.exp(-d / 4.5) * side * (1 - 0.011 * dc) + randNormal(rng) * 3.5), 30, 160);
      let flood = surge * Math.exp(-dc / 3) * (0.3 + 0.7 * clamp01(1 - d / 8)) + randNormal(rng) * 0.25;
      flood = flood < 0.5 ? 0 : Math.round(flood * 10) / 10;
      const dOut = Math.hypot(q - outageCluster.q, r - outageCluster.r);
      let outage = 85 * sigmoid((wind - 116) / 8) + 95 * Math.exp(-(dOut * dOut) / 1.2) + randNormal(rng) * 4;
      outage = Math.round(clamp(outage, 0, 100));
      const score = Math.max((wind - 60) / 26, flood / 2.7) + randNormal(rng) * 0.2;
      let zone: 0 | 1 | 2 = score >= 1.9 ? 2 : score >= 1.0 ? 1 : 0;
      if (chance(rng, 0.08)) zone = 0; // analyst miss
      cells.push({
        hex: `fx${opts.eventId.replace(/[^a-z0-9]/gi, '')}-${q + R}-${r + R}`,
        lat: center.lat + y / 111,
        lng: center.lng + x / (111 * Math.cos((center.lat * Math.PI) / 180)),
        windMph: wind,
        floodDepthFt: flood,
        towerOutagePct: outage,
        analystZone: zone,
      });
      axial.push({ q, r });
    }
  }

  // Households: each cell gets at least 2, the rest weighted toward the middle.
  const weights = axial.map(({ q, r }) => 1 + 3 * Math.exp(-(q * q + r * r + q * r) / (R * R)) * (0.5 + rng.next()));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const counts = cells.map(() => 2);
  for (let i = cells.length * 2; i < opts.households; i++) {
    let u = rng.next() * wsum;
    let k = 0;
    while (k < weights.length - 1 && u > weights[k]) {
      u -= weights[k];
      k++;
    }
    counts[k]++;
  }
  const households: Household[] = [];
  const truth: TruthRow[] = [];
  const events: SimEvent[] = [];
  let n = 0;
  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c];
    const dc = 1.4 * (R - axial[c].r) + 0.5;
    for (let k = 0; k < counts[c]; k++) {
      n++;
      const id = `${opts.eventId}-h${String(n).padStart(5, '0')}`;
      const age65 = chance(rng, 0.2);
      const livesAlone = chance(rng, age65 ? 0.25 : 0.1);
      const medicalDevice = chance(rng, age65 ? 0.09 : 0.0275);
      const h: Household = {
        id,
        hex: cell.hex,
        lat: cell.lat + randNormal(rng) * 0.004,
        lng: cell.lng + randNormal(rng) * 0.004,
        age65,
        livesAlone,
        medicalDevice,
        windCovered: chance(rng, 0.97),
        floodPolicy: chance(rng, 0.1 + 0.5 * Math.exp(-dc / 5)),
        earthquakeEndorsement: chance(rng, 0.05),
        phoneOnFile: chance(rng, 0.88),
        holdout: false,
      };
      households.push(h);

      // Truth, following the same shape as the project simulator.
      const wind = cell.windMph * (1 + randNormal(rng) * 0.05);
      const depth = cell.floodDepthFt > 0 ? Math.max(0, cell.floodDepthFt + randNormal(rng) * 0.8) : 0;
      const w = (wind - 60) / 26 + randNormal(rng) * 0.35;
      const f = depth / 2.7 + randNormal(rng) * 0.35;
      const sev = Math.max(w, f) + 0.25 * Math.min(w, f) + (chance(rng, 0.06) ? 0.7 : 0) + randNormal(rng) * 0.3;
      const damage = sampleDamage(sev);
      const outage = cell.towerOutagePct / 100;
      const zHelp =
        -4.6 +
        (damage === 3 ? 1.9 : damage === 2 ? 0.8 : 0) +
        (age65 ? 0.5 : 0) +
        (age65 && livesAlone ? 1.2 : 0) +
        (medicalDevice ? (outage > 0.6 ? 1.8 : 0.5) : 0) +
        (depth > 4 ? 0.6 : 0);
      const needsHelp = chance(rng, sigmoid(zHelp));
      const peril = damage === 0 ? 'none' : f > w ? 'flood' : 'wind';
      truth.push({ householdId: id, damage, safety: needsHelp ? 'needs_help' : 'safe', peril });

      // Events.
      if (h.phoneOnFile) {
        const tSent = randInt(rng, 60, 180);
        events.push({ kind: 'sms_sent', t: tSent, householdId: id });
        let pReply = 0.78 * Math.pow(1 - outage, 1.6);
        if (age65) pReply *= 0.7;
        if (damage === 3) pReply *= 0.6;
        if (needsHelp) pReply *= 0.5;
        if (chance(rng, pReply)) {
          const delay = Math.exp(Math.log(40 * (1 + 20 * outage * outage)) + randNormal(rng) * 1.1);
          const tReply = Math.round(tSent + Math.max(1, delay));
          let rd = damage + (chance(rng, 0.3) ? (chance(rng, 0.5) ? 1 : -1) : 0);
          rd = clamp(rd, 0, 3);
          const saysHelp = needsHelp ? chance(rng, 0.85) : chance(rng, 0.03);
          if (tReply <= 4320) {
            events.push({ kind: 'sms_reply', t: tReply, householdId: id, safety: saysHelp ? 'needs_help' : 'safe', damage: rd as Damage });
          }
        }
      }
      let pClaim = [0.03, 0.35, 0.75, 0.9][damage];
      if (peril === 'flood' && !h.floodPolicy) pClaim *= 0.15;
      if (peril === 'wind' && !h.windCovered) pClaim *= 0.2;
      if (chance(rng, pClaim)) {
        const median = 8 * 60 * Math.exp(3 * outage * outage) * (1 + 0.3 * damage);
        const tClaim = Math.round(30 + Math.exp(Math.log(median) + randNormal(rng) * 0.8));
        let rd = damage + (chance(rng, 0.15) ? 1 : chance(rng, 0.1) ? -1 : 0);
        rd = clamp(rd, 0, 3);
        const claimPeril = peril === 'none' ? (cell.floodDepthFt > 0 ? 'flood' : 'wind') : peril;
        if (tClaim <= 4320) {
          events.push({ kind: 'claim', t: tClaim, householdId: id, peril: claimPeril, reportedDamage: rd as Damage });
        }
      }
    }
  }

  // Holdout: exactly 15%, uniform.
  const idx = households.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    const tmp = idx[i];
    idx[i] = idx[j];
    idx[j] = tmp;
  }
  const nHold = Math.round(households.length * 0.15);
  for (let i = 0; i < nHold; i++) households[idx[i]].holdout = true;

  if (opts.withFieldReports) {
    const truthById = new Map(truth.map((r) => [r.householdId, r]));
    const nonHoldout = households.filter((h) => !h.holdout);
    const want = Math.round(nonHoldout.length * 0.12);
    for (let i = nonHoldout.length - 1; i > 0; i--) {
      const j = randInt(rng, 0, i);
      const tmp = nonHoldout[i];
      nonHoldout[i] = nonHoldout[j];
      nonHoldout[j] = tmp;
    }
    for (let i = 0; i < want; i++) {
      const h = nonHoldout[i];
      const tr = truthById.get(h.id)!;
      events.push({
        kind: 'field_report',
        t: randInt(rng, 1440, 4320),
        householdId: h.id,
        adjusterId: `adj-${String(1 + (i % 10)).padStart(2, '0')}`,
        safety: chance(rng, 0.06) ? 'unsure' : tr.safety,
        damage: tr.damage,
      });
    }
  }

  const kindRank: Record<SimEvent['kind'], number> = { sms_sent: 0, sms_reply: 1, claim: 2, field_report: 3 };
  events.sort((a, b) => a.t - b.t || kindRank[a.kind] - kindRank[b.kind] || (a.householdId < b.householdId ? -1 : a.householdId > b.householdId ? 1 : 0));

  return {
    world: { eventId: opts.eventId, name: opts.name, landfallIso: opts.landfallIso, center, hexes: cells, households },
    events,
    truth,
  };
}

/** Standard fixture set: 3 backtests with field reports + 1 live world without. */
export function fixtureSet(households = 300, gridRadius = 3): { backtests: EventBundle[]; live: EventBundle } {
  const names = ['Pelican Point, TX', 'Salt Marsh, TX', 'Gull Harbor, TX'];
  const backtests = names.map((name, i) =>
    generateBundle({
      eventId: `backtest-${i + 1}`,
      name,
      seed: 1000 + i,
      households,
      gridRadius,
      withFieldReports: true,
      landfallIso: `20${18 + i}-09-01T06:00:00.000Z`,
    }),
  );
  const live = generateBundle({
    eventId: 'live',
    name: 'Harbor Bend, TX',
    seed: 4242,
    households,
    gridRadius,
    withFieldReports: false,
    landfallIso: '2026-11-07T04:00:00.000Z',
  });
  return { backtests, live };
}
