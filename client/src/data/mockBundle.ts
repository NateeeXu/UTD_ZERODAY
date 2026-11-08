// Stand-in for A's data/live.json so the frontend can be built before the
// simulator exists. Same shape (EventBundle), fixed seed, so the demo replays
// identically. Delete once data/live.json is committed.
import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import type {
  Damage, EventBundle, HexCell, Household, SimEvent, TruthRow,
} from '@shared/types';

export const H3_RES = 8;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const kmBetween = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const dLat = (a.lat - b.lat) * 111;
  const dLng = (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
};

export function generateMockBundle(seed = 2026): EventBundle {
  const rnd = mulberry32(seed);
  const gauss = () => {
    const u = 1 - rnd();
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const center = { lat: 28.98, lng: -95.37 };
  const eye = { lat: center.lat - 0.02, lng: center.lng + 0.035 };
  const coastLat = center.lat - 0.075;
  // A cluster of failed cell towers north-east of the eye: the "silent" zone.
  const outageCenter = { lat: center.lat + 0.03, lng: center.lng + 0.06 };
  // One district that over-reports damage by self-report.
  const inflatedCenter = { lat: center.lat + 0.04, lng: center.lng - 0.06 };

  const cells = gridDisk(latLngToCell(center.lat, center.lng, H3_RES), 10);

  const hexes: HexCell[] = cells.map((hex) => {
    const [lat, lng] = cellToLatLng(hex);
    const p = { lat, lng };
    const dEye = kmBetween(p, eye);
    const windMph = Math.round(clamp(55 + 95 * Math.exp(-((dEye / 3.8) ** 2)) + 6 * gauss(), 30, 160));
    const floodDepthFt = Math.round(clamp((0.04 - (lat - coastLat)) * 110 + 0.6 * gauss(), 0, 9) * 10) / 10;
    const dOut = kmBetween(p, outageCenter);
    const towerOutagePct = Math.round(clamp(95 * Math.exp(-((dOut / 3.2) ** 2)) + windMph / 6 + 5 * gauss(), 0, 100));
    const hazard = (windMph - 60) / 80 + floodDepthFt / 5;
    let analystZone: 0 | 1 | 2 = hazard > 1.0 ? 2 : hazard > 0.45 ? 1 : 0;
    if (rnd() < 0.08) analystZone = (Math.max(0, Math.min(2, analystZone + (rnd() < 0.5 ? -1 : 1)))) as 0 | 1 | 2;
    return { hex, lat, lng, windMph, floodDepthFt, towerOutagePct, analystZone };
  });

  const households: Household[] = [];
  const truth: TruthRow[] = [];
  const events: SimEvent[] = [];
  let n = 0;

  for (const h of hexes) {
    const count = Math.max(2, Math.round(9 + 4 * gauss()));
    const inflated = kmBetween(h, inflatedCenter) < 2.5;
    for (let i = 0; i < count; i++) {
      const id = `hh-${String(++n).padStart(4, '0')}`;
      const [lat, lng] = [h.lat + (rnd() - 0.5) * 0.006, h.lng + (rnd() - 0.5) * 0.007];
      const age65 = rnd() < 0.22;
      const hh: Household = {
        id, hex: h.hex, lat, lng,
        age65,
        livesAlone: rnd() < (age65 ? 0.4 : 0.15),
        medicalDevice: rnd() < (age65 ? 0.12 : 0.03),
        windCovered: rnd() < 0.96,
        floodPolicy: rnd() < 0.18 + h.floodDepthFt * 0.04,
        earthquakeEndorsement: rnd() < 0.02,
        phoneOnFile: rnd() < 0.92,
        holdout: rnd() < 0.15,
      };
      households.push(hh);

      // Truth
      const windHit = (h.windMph - 95) / 20;
      const floodHit = h.floodDepthFt / 1.8;
      const score = Math.max(windHit, floodHit) + 0.5 * gauss();
      const damage = clamp(Math.round(score), 0, 3) as Damage;
      const vuln = (age65 ? 0.25 : 0) + (hh.livesAlone ? 0.15 : 0) + (hh.medicalDevice ? 0.3 : 0);
      const pHelp = clamp(0.03 + 0.18 * damage + vuln * (damage >= 2 ? 1 : 0.3), 0, 0.95);
      const safety = rnd() < pHelp ? 'needs_help' : 'safe';
      const peril = damage === 0 ? 'none' : floodHit > windHit ? 'flood' : 'wind';
      truth.push({ householdId: id, damage, safety, peril });

      // SMS check-in: sent ~30–90 min after landfall to everyone with a phone.
      if (hh.phoneOnFile) {
        const tSent = 30 + Math.floor(rnd() * 60);
        events.push({ kind: 'sms_sent', t: tSent, householdId: id });
        const pReply = 0.75 * (1 - h.towerOutagePct / 110) * (age65 ? 0.55 : 1);
        if (rnd() < pReply) {
          const tReply = tSent + Math.round(-Math.log(1 - rnd()) * 180);
          const bias = inflated ? 1 : rnd() < 0.15 ? -1 : 0;
          events.push({
            kind: 'sms_reply', t: tReply, householdId: id,
            safety: rnd() < 0.9 ? safety : safety === 'safe' ? 'needs_help' : 'safe',
            damage: clamp(damage + bias, 0, 3) as Damage,
          });
        }
      }

      // Claims: more likely with damage, delayed, suppressed in outage areas.
      const pClaim = damage === 0 ? 0.02 : (0.35 + 0.2 * damage) * (1 - h.towerOutagePct / 160);
      if (peril !== 'none' && rnd() < pClaim) {
        const tClaim = 120 + Math.round(rnd() * 2400 * (1 + h.towerOutagePct / 100));
        if (tClaim <= 2880) {
          events.push({
            kind: 'claim', t: tClaim, householdId: id, peril,
            reportedDamage: clamp(damage + (rnd() < 0.2 ? 1 : 0), 0, 3) as Damage,
          });
        }
      }
    }
  }

  events.sort((a, b) => a.t - b.t);
  return {
    world: {
      eventId: 'live-mock',
      name: 'Harbor Bend, TX',
      landfallIso: '2026-09-12T03:00:00-05:00',
      center,
      hexes,
      households,
    },
    events,
    truth,
  };
}
