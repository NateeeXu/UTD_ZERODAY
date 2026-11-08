// v3 truth and reply labels shared by the Harbor Bend and real-geography simulators:
//   - what kind of help a household needs (life safety vs. assistance),
//   - where its people are during the response (people and the house are tracked separately),
//   - which concrete needs it would mention, and the structured labels of one reply.
// All rates are simulator assumptions (see docs/DATA.md), not measured values.

import type { Damage, Household, Need, NeedType, Whereabouts } from '../../shared/types.ts';
import type { Rng } from './rng.ts';

export interface NeedContext {
  safety: 'safe' | 'needs_help';
  damage: Damage;
  floodFt: number;
  outagePct: number;
  hazard: 'hurricane' | 'earthquake';
}

/** Life safety = in danger now (trapped, injured, medical device without power, deep water, frail in a badly damaged home).
 *  power_for_device (medicalDevice && outage > 40) therefore always implies life safety. */
export function truthNeedType(rng: Rng, hh: Household, c: NeedContext): NeedType {
  if (c.safety !== 'needs_help') return 'none';
  const urgent =
    c.damage === 3 ||
    c.floodFt > 4 ||
    (!!hh.medicalDevice && c.outagePct > 40) || // a powered medical device without power is life safety
    (!!(hh.age75 || hh.disability) && c.damage >= 2);
  return urgent || rng.chance(0.2) ? 'life_safety' : 'assistance';
}

/**
 * Where the people are during the response. away = not home when it hit (work / school), cannot see the
 * house; displaced = left because the home is badly damaged (knows the damage); home otherwise.
 * People in danger at home stay home (that is why they need help).
 */
export function truthLocation(rng: Rng, awayNow: boolean, damage: Damage, needType: NeedType): Whereabouts {
  if (awayNow) return 'away';
  if (needType === 'life_safety') return 'home';
  if (damage === 3) return rng.chance(0.8) ? 'displaced' : 'home';
  if (damage === 2) return rng.chance(0.4) ? 'displaced' : 'home';
  return 'home';
}

/** Away people get home 4-12 h after it hit (commute disruption; assumption). */
export function truthReturnMin(rng: Rng, location: Whereabouts): number | undefined {
  return location === 'away' ? rng.int(240, 720) : undefined;
}

/** Where the people are at sim minute t: away people come home at returnMin, and leave again if the home is badly damaged. */
export function locationAt(truth: { location?: Whereabouts; returnMin?: number; damage: Damage }, t: number): Whereabouts {
  const loc = truth.location ?? 'home';
  if (loc === 'away' && truth.returnMin !== undefined && t >= truth.returnMin) return truth.damage >= 2 ? 'displaced' : 'home';
  return loc;
}

/** Concrete needs the household would mention (not life safety by themselves). */
export function householdNeeds(hh: Household, c: { damage: Damage; outagePct: number; hazard: string }): Need[] {
  const needs: Need[] = [];
  if (hh.medicalDevice) needs.push(c.outagePct > 40 ? 'power_for_device' : 'medical');
  if (c.damage >= 2) needs.push('shelter');
  if (hh.noVehicle && (c.hazard === 'hurricane' || c.damage >= 2)) needs.push('transport');
  if (c.outagePct > 60) needs.push('water_food');
  return needs;
}

export interface ReplyLabels {
  lifeSafety: boolean;
  needs: Need[];
  notHome: boolean;
  /** null when the person cannot see the house (away when it hit) */
  damage: Damage | null;
}

/**
 * Structured labels of one reply, consistent with the truth:
 * needs_help + life-safety truth -> lifeSafety; needs_help otherwise -> concrete needs (assistance);
 * safe with damage -> sometimes asks for an inspection. Away people do not know the damage.
 */
export function replyLabels(
  rng: Rng,
  hh: Household,
  reply: { safety: 'safe' | 'needs_help'; damage: Damage },
  truth: { needType: NeedType; location: Whereabouts },
  c: { outagePct: number; hazard: string }
): ReplyLabels {
  const notHome = truth.location !== 'home';
  const damage = truth.location === 'away' && rng.chance(0.85) ? null : reply.damage;
  const own = householdNeeds(hh, { damage: reply.damage, outagePct: c.outagePct, hazard: c.hazard });
  if (reply.safety === 'needs_help') {
    if (truth.needType === 'life_safety') return { lifeSafety: true, needs: own.slice(0, 1), notHome, damage };
    // Not life safety (assistance truth, or a "needs help" reply from a household that is actually fine):
    // concrete needs only; a powered device without power would read as life safety, so it is excluded.
    const assist = own.filter((n) => n !== 'power_for_device').slice(0, 2);
    const needs: Need[] = assist.length > 0 ? assist : reply.damage >= 1 ? ['inspection'] : ['other'];
    return { lifeSafety: false, needs, notHome, damage };
  }
  // Safe replies may ask for an inspection, nothing else.
  const needs: Need[] = [];
  if (reply.damage >= 1 && damage !== null && rng.chance(0.3)) needs.push('inspection');
  return { lifeSafety: false, needs, notHome, damage };
}

/**
 * SMS delivery receipts. A household that replied clearly received the text. For the others, the carrier
 * reports "not delivered" with a probability that grows with the cell's tower / power outage (phone dead,
 * no signal) and with a destroyed home (phone lost or broken); otherwise the text was delivered and the
 * silence is the person's (busy, away, or unable to answer). Uses its own random stream ('delivery'), so
 * every other simulated value is unchanged. All rates are simulator assumptions (docs/DATA.md).
 */
export function markDelivery(
  events: { kind: string; householdId: string; delivered?: boolean }[],
  rng: Rng,
  info: (householdId: string) => { outagePct: number; damage: Damage }
): void {
  const replied = new Set(events.filter((e) => e.kind === 'sms_reply').map((e) => e.householdId));
  for (const e of events) {
    if (e.kind !== 'sms_sent') continue;
    if (replied.has(e.householdId)) { e.delivered = true; continue; }
    const i = info(e.householdId);
    const p = Math.min(0.9, 0.05 + 0.7 * (i.outagePct / 100) + (i.damage === 3 ? 0.4 : 0));
    e.delivered = !rng.chance(p);
  }
}
