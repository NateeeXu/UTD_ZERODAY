// Summary statistics shared by main.ts (meta output) and check.ts (validation table).

import type { EventBundle, HexId } from '../../shared/types.ts';

export interface HexStat {
  hex: HexId;
  households: number;
  smsSent: number;
  smsReplies: number;
  claims: number;
  fieldReports: number;
  severeOrNeedsHelp: number; // truth: damage >= 2 or needs_help
}

export function hexStats(b: EventBundle): Map<HexId, HexStat> {
  const out = new Map<HexId, HexStat>();
  for (const c of b.world.hexes) {
    out.set(c.hex, { hex: c.hex, households: 0, smsSent: 0, smsReplies: 0, claims: 0, fieldReports: 0, severeOrNeedsHelp: 0 });
  }
  const hexOf = new Map<string, HexId>();
  for (const h of b.world.households) {
    hexOf.set(h.id, h.hex);
    out.get(h.hex)!.households++;
  }
  for (const t of b.truth) {
    if (t.damage >= 2 || t.safety === 'needs_help') out.get(hexOf.get(t.householdId)!)!.severeOrNeedsHelp++;
  }
  for (const e of b.events) {
    const s = out.get(hexOf.get(e.householdId)!)!;
    if (e.kind === 'sms_sent') s.smsSent++;
    else if (e.kind === 'sms_reply') s.smsReplies++;
    else if (e.kind === 'claim') s.claims++;
    else s.fieldReports++;
  }
  return out;
}

/** "Silent severe": high hazard, heavy outage, reply rate < 10%, truth severe share > 40%. */
export function silentSevereCells(b: EventBundle): Array<HexStat & { windMph: number; floodDepthFt: number; towerOutagePct: number; analystZone: number }> {
  const stats = hexStats(b);
  const out = [];
  for (const c of b.world.hexes) {
    const s = stats.get(c.hex)!;
    const highHazard = c.windMph >= 110 || c.floodDepthFt >= 4;
    const heavyOutage = c.towerOutagePct >= 80;
    const replyRate = s.smsSent > 0 ? s.smsReplies / s.smsSent : 0;
    const severeShare = s.households > 0 ? s.severeOrNeedsHelp / s.households : 0;
    if (highHazard && heavyOutage && replyRate < 0.1 && severeShare > 0.4) {
      out.push({ ...s, windMph: c.windMph, floodDepthFt: c.floodDepthFt, towerOutagePct: c.towerOutagePct, analystZone: c.analystZone });
    }
  }
  return out;
}
