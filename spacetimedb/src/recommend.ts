// Adjuster "Next best" list: gathers candidates, ranks them (recommend-rank.ts) and stores the result.
// The list changes only on the adjusters' own actions, never on the tick, so it cannot slow the replay.
import type { Identity } from 'spacetimedb';
import type { Ctx } from './schema';
import { simNow } from './state';
import { rankCandidates, type Candidate } from './recommend-rank';

function hasOpenAssignment(ctx: Ctx, householdId: string): boolean {
  return [...ctx.db.assignment.householdId.filter(householdId)].some(a => a.status === 'assigned');
}

function gatherCandidates(ctx: Ctx): Candidate[] {
  const out: Candidate[] = [];
  for (const q of ctx.db.unaccountedQueue.iter()) {
    if (q.escalation !== 'field_visit') continue;
    const h = ctx.db.household.id.find(q.householdId);
    if (!h) continue;
    out.push({
      kind: 'welfare',
      householdId: q.householdId,
      hex: q.hex,
      lat: h.lat,
      lng: h.lng,
      priority: q.cellPriority,
      weight: q.weight,
      waitSinceMin: q.waitSinceMin,
      vulnerable: q.vulnerable,
    });
  }
  for (const c of ctx.db.inspectionCandidate.iter()) {
    if (c.escalation === 'closed') continue;
    const h = ctx.db.household.id.find(c.householdId);
    if (!h) continue;
    out.push({
      kind: 'inspection',
      householdId: c.householdId,
      hex: c.hex,
      lat: h.lat,
      lng: h.lng,
      priority: c.cellPriority,
      inspectScore: c.inspectScore,
      pSevere: c.pSevere,
      verifiedInCell: ctx.db.hexStats.hex.find(c.hex)?.verifiedHouseholds ?? 0,
    });
  }
  return out;
}

export function setAdjusterLocation(ctx: Ctx, adjuster: Identity, lat: number, lng: number, source: string) {
  const row = { identity: adjuster, lat, lng, source, updatedAt: ctx.timestamp };
  if (ctx.db.adjusterLocation.identity.find(adjuster)) ctx.db.adjusterLocation.identity.update(row);
  else ctx.db.adjusterLocation.insert(row);
}

export function recomputeRecommendations(ctx: Ctx, adjuster: Identity) {
  for (const r of [...ctx.db.adjusterRecommendation.adjuster.filter(adjuster)]) ctx.db.adjusterRecommendation.id.delete(r.id);
  const from = ctx.db.adjusterLocation.identity.find(adjuster);
  if (!from) return;
  const open = new Set<string>();
  for (const a of ctx.db.assignment.iter()) if (a.status === 'assigned') open.add(a.householdId);
  for (const r of rankCandidates(gatherCandidates(ctx), from, simNow(ctx), open))
    ctx.db.adjusterRecommendation.insert({ id: 0n, adjuster, createdAt: ctx.timestamp, ...r });
}

export function dropFromAllLists(ctx: Ctx, householdId: string) {
  for (const r of [...ctx.db.adjusterRecommendation.householdId.filter(householdId)]) ctx.db.adjusterRecommendation.id.delete(r.id);
}

/** False when a reply, the simulated staff or another adjuster has already taken care of this household. */
export function stillNeeded(ctx: Ctx, householdId: string): boolean {
  if (hasOpenAssignment(ctx, householdId)) return false;
  if (ctx.db.unaccountedQueue.householdId.find(householdId)?.escalation === 'field_visit') return true;
  const c = ctx.db.inspectionCandidate.householdId.find(householdId);
  return !!c && c.escalation !== 'closed';
}

/** A demo adjuster is now standing at the reported household; a GPS position stays what the phone says. */
export function afterFieldReport(ctx: Ctx, adjuster: Identity, householdId: string) {
  dropFromAllLists(ctx, householdId);
  const loc = ctx.db.adjusterLocation.identity.find(adjuster);
  if (!loc) return;
  const h = ctx.db.household.id.find(householdId);
  if (loc.source === 'demo' && h) setAdjusterLocation(ctx, adjuster, h.lat, h.lng, loc.source);
  recomputeRecommendations(ctx, adjuster);
}

export function forgetAdjuster(ctx: Ctx, adjuster: Identity) {
  ctx.db.adjusterLocation.identity.delete(adjuster);
  for (const r of [...ctx.db.adjusterRecommendation.adjuster.filter(adjuster)]) ctx.db.adjusterRecommendation.id.delete(r.id);
}
