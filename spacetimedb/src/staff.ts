// Simulated staff (demo only): who works the "no one overlooked" queues while the replay runs.
// Every STAFF_STEP_MIN sim minutes, in this order:
//   1. Referral desk (no capacity limit, life safety first): refers every new life-safety report;
//      the agency acknowledges after AGENCY_ACK_MIN and resolves after AGENCY_RESOLVE_MIN.
//   2. Adjusters (visitsPerHour): visit the highest-scored queue households that calls could not reach.
//      A visit always inspects the PROPERTY; the PEOPLE are seen only if they are home (sim truth
//      location), otherwise the report says 'unsure' and the household moves to 'locate'.
//   3. Agents (callsPerHour): call the highest-scored queue households past the SMS window, with retries.
//      Phones travel with people, so a call reaches them wherever they are; someone who is away cannot
//      say how the house is (damage unknown). 'locate' households: the emergency contact is tried.
//   4. Property inspections (inspectionsPerHour): adjusters inspect the top of inspection_candidate across
//      all cells (severity x uncertainty), the property track that shrinks the cells' severe-count intervals.
//      Occupants are seen only if they are home at that time.
// Outcomes come from the private sim truth (the simulated world), never from the model. A reached call
// is an sms_reply with channel 'call'; a visit is a field_report from 'sim-adjuster'.
import type { Ctx } from './schema';
import { flushBatch, newBatch, onEvent } from './ingest';
import { QUEUE_AGING_MIN, recomputeCells } from './fusion';
import { SINGLETON } from './state';
import type { Damage, Safety } from './fusion/contract';

export const STAFF_STEP_MIN = 30;
const CALL_AFTER_MIN = 60; // give the outreach text an hour before calling
const RETRY_MIN = 120; // between calls to the same household
const MAX_FAILED_CALLS = 3;
const MAX_LOCATE_TRIES = 3; // emergency-contact attempts after a visit found nobody home, then closure
const VISIT_AFTER_MIN = 240; // one failed call + 4 h of silence -> visit (two failed calls -> visit now)
const AGENCY_ACK_MIN = 30;
const AGENCY_RESOLVE_MIN = 360;
// P(call answered) = base x factors (simulator assumptions, see docs/DATA.md).
const REACH = { phone: 0.75, noPhone: 0.4, needsHelp: 0.5, limitedEnglish: 0.8, destroyed: 0.7, emergencyContact: 0.6 };
const REFERRAL_STATES = ['emergency_referral', 'referral_overdue', 'referral_pending', 'referral_acknowledged'];

/**
 * Default capacity per hour: calls 2%, welfare visits 0.3%, property inspections 0.2% of households
 * (e.g. 600 calls, 90 visits, 60 inspections for 30,000).
 */
export function defaultCapacity(households: number) {
  return {
    callsPerHour: Math.max(20, Math.round(households * 0.02)),
    visitsPerHour: Math.max(5, Math.round(households * 0.003)),
    inspectionsPerHour: Math.max(3, Math.round(households * 0.002)),
  };
}

export function getStaff(ctx: Ctx) {
  const row = ctx.db.staffSim.id.find(SINGLETON);
  if (row) return row;
  const cap = defaultCapacity(Number(ctx.db.household.count()));
  return ctx.db.staffSim.insert({
    id: SINGLETON,
    enabled: true,
    ...cap,
    lastRunMin: 0,
    callsMade: 0,
    callsReached: 0,
    visitsMade: 0,
    referralsMade: 0,
    referralsResolved: 0,
    helpFound: 0,
    visitsNobodyHome: 0,
    inspectionsMade: 0,
    updatedAt: ctx.timestamp,
  });
}

/** Demo reset: keep enabled / capacity, zero the counters and the clock. */
export function resetStaffCounters(ctx: Ctx) {
  const st = getStaff(ctx);
  ctx.db.staffSim.id.update({
    ...st,
    lastRunMin: 0,
    callsMade: 0,
    callsReached: 0,
    visitsMade: 0,
    referralsMade: 0,
    referralsResolved: 0,
    helpFound: 0,
    visitsNobodyHome: 0,
    inspectionsMade: 0,
    updatedAt: ctx.timestamp,
  });
}

/** Run every staff step due up to `nowMin` (no-op when disabled). */
export function runStaffUpTo(ctx: Ctx, nowMin: number) {
  let st = getStaff(ctx);
  if (!st.enabled) return;
  while (st.lastRunMin + STAFF_STEP_MIN <= nowMin) {
    staffStep(ctx, st.lastRunMin + STAFF_STEP_MIN);
    st = getStaff(ctx);
  }
}

/** Deterministic pseudo-random number in [0, 1) (reproducible demos; no Math.random in reducers). */
function rand01(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function setReferral(ctx: Ctx, householdId: string, hex: string, status: string, atMin: number) {
  const prev = ctx.db.householdFollowup.householdId.find(householdId);
  const row = {
    householdId,
    hex,
    memberMissing: prev?.memberMissing ?? false,
    reportedSimMinutes: prev?.reportedSimMinutes ?? 0,
    referralStatus: status,
    referralSimMinutes: atMin,
    closureReason: prev?.closureReason ?? '',
    closureNote: prev?.closureNote ?? '',
    closedBy: prev?.closedBy ?? '',
    updatedAt: ctx.timestamp,
  };
  if (prev) ctx.db.householdFollowup.householdId.update(row);
  else ctx.db.householdFollowup.insert(row);
}

/** Was the person last known to be away from the house (latest reply notHome)? */
function lastReplyNotHome(ctx: Ctx, householdId: string): boolean {
  let latest: { id: bigint; t: number; notHome: boolean } | null = null;
  for (const r of ctx.db.smsReply.householdId.filter(householdId))
    if (!latest || r.t > latest.t || (r.t === latest.t && r.id > latest.id)) latest = r;
  return !!latest?.notHome;
}

/** Where the people are at sim minute t (mirrors sim/src/needs.ts locationAt). */
function locationAt(truth: { location: string; returnMin: number; damage: number }, t: number): string {
  const loc = truth.location || 'home';
  if (loc === 'away' && truth.returnMin >= 0 && t >= truth.returnMin) return truth.damage >= 2 ? 'displaced' : 'home';
  return loc;
}

/** Self-reported damage: the truth, off by one level 25% of the time (deterministic). */
function noisyDamage(householdId: string, at: number, damage: Damage): Damage {
  const r = rand01(`${householdId}:${at}:dmg`);
  const d = damage + (r < 0.125 ? 1 : r < 0.25 ? -1 : 0);
  return Math.max(0, Math.min(3, d)) as Damage;
}

/** Needs the person mentions on the call (same rules as sim/src/needs.ts). */
function callNeeds(
  hh: { id: string; medicalDevice: boolean; noVehicle?: boolean },
  truth: { safety: string; damage: number; needType: string },
  knownDamage: Damage | null,
  outagePct: number,
  hazard: string
): string[] {
  const own: string[] = [];
  if (hh.medicalDevice) own.push(outagePct > 40 ? 'power_for_device' : 'medical');
  if (truth.damage >= 2) own.push('shelter');
  if (hh.noVehicle && (hazard === 'hurricane' || truth.damage >= 2)) own.push('transport');
  if (outagePct > 60) own.push('water_food');
  if (truth.safety === 'needs_help') {
    if (truth.needType === 'life_safety') return own.slice(0, 1);
    // A powered device without power would read as life safety, so assistance replies leave it out.
    const assist = own.filter((n) => n !== 'power_for_device').slice(0, 2);
    return assist.length > 0 ? assist : truth.damage >= 1 ? ['inspection'] : ['other'];
  }
  return knownDamage !== null && knownDamage >= 1 && rand01(`${hh.id}:inspection`) < 0.3 ? ['inspection'] : [];
}

/** Staff-sim closure after a visit found nobody and the emergency contact could not be reached. */
function closeUnreachable(ctx: Ctx, householdId: string, hex: string) {
  const prev = ctx.db.householdFollowup.householdId.find(householdId);
  const row = {
    householdId,
    hex,
    memberMissing: prev?.memberMissing ?? false,
    reportedSimMinutes: prev?.reportedSimMinutes ?? 0,
    referralStatus: prev?.referralStatus ?? '',
    referralSimMinutes: prev?.referralSimMinutes ?? 0,
    closureReason: 'unreachable_after_visit',
    closureNote: `visited, nobody home; emergency contact unreachable after ${MAX_LOCATE_TRIES} tries`,
    closedBy: 'sim-staff',
    updatedAt: ctx.timestamp,
  };
  if (prev) ctx.db.householdFollowup.householdId.update(row);
  else ctx.db.householdFollowup.insert(row);
}

function staffStep(ctx: Ctx, at: number) {
  const st = getStaff(ctx);
  const followupHexes = new Set<string>();

  // 1. Referral desk (life-safety reports, missing members; assistance requests go to customer care, not 911).
  for (const esc of REFERRAL_STATES) {
    for (const e of [...ctx.db.householdEstimate.escalation.filter(esc)]) {
      const f = ctx.db.householdFollowup.householdId.find(e.householdId);
      const status = f?.referralStatus ?? '';
      if (status === '' || status === 'resolved') {
        setReferral(ctx, e.householdId, e.hex, 'referred', at);
        st.referralsMade++;
      } else if (status === 'referred' && at - f!.referralSimMinutes >= AGENCY_ACK_MIN) {
        setReferral(ctx, e.householdId, e.hex, 'acknowledged', f!.referralSimMinutes);
      } else if (status === 'acknowledged' && at - f!.referralSimMinutes >= AGENCY_RESOLVE_MIN) {
        setReferral(ctx, e.householdId, e.hex, 'resolved', at);
        st.referralsResolved++;
      } else continue;
      followupHexes.add(e.hex);
    }
  }

  // 2 + 3. Visits and calls down the outreach queue, highest score first.
  const callBudget = Math.round((st.callsPerHour * STAFF_STEP_MIN) / 60);
  const visitBudget = Math.round((st.visitsPerHour * STAFF_STEP_MIN) / 60);
  const score = (q: { weight: number; waitSinceMin: number }) => q.weight * (1 + (at - q.waitSinceMin) / QUEUE_AGING_MIN);
  const queue = [...ctx.db.unaccountedQueue.iter()].sort((a, b) => score(b) - score(a) || (a.householdId < b.householdId ? -1 : 1));
  const hazard = ctx.db.world.id.find(SINGLETON)?.hazardType === 'earthquake' ? 'earthquake' : 'hurricane';
  const batch = newBatch(ctx);
  let calls = 0;
  let visits = 0;
  const visited = new Set<string>();
  for (const q of queue) {
    if (calls >= callBudget && visits >= visitBudget) break;
    const hh = ctx.db.household.id.find(q.householdId);
    const truth = ctx.db.simTruth.householdId.find(q.householdId);
    if (!hh || !truth) continue;
    const safety = (truth.safety === 'needs_help' ? 'needs_help' : 'safe') as 'safe' | 'needs_help';
    const damage = truth.damage as Damage;
    const where = locationAt(truth, at);
    const home = where === 'home';
    const c = ctx.db.staffContact.householdId.find(q.householdId);
    const failed = c?.failedCalls ?? 0;
    const locateTries = c?.locateTries ?? 0;
    const wait = at - q.waitSinceMin;
    const recheck = q.escalation === 'recheck';
    const locate = q.escalation === 'locate';
    const outagePct = ctx.db.hex.hex.find(hh.hex)?.towerOutagePct ?? 0;

    // Visits: never for 'locate' (already visited); a re-check only if the person was last known at home.
    const visitDue =
      !locate &&
      (recheck ? failed >= 2 && !lastReplyNotHome(ctx, hh.id) : failed >= 2 || (failed >= 1 && wait >= VISIT_AFTER_MIN));
    if (visitDue && visits < visitBudget) {
      visits++;
      visited.add(hh.id);
      const seen = home;
      if (!seen) st.visitsNobodyHome++;
      else if (safety === 'needs_help') st.helpFound++;
      const visitSafety: Safety = seen ? safety : 'unsure';
      const note = seen ? 'simulated staff visit: occupants seen' : 'simulated staff visit: property inspected, nobody home';
      onEvent(ctx, { kind: 'field_report', t: at, householdId: hh.id, adjusterId: 'sim-adjuster', safety: visitSafety, damage, note }, 'staff_sim', batch);
      continue;
    }

    // Calls: the household's phone, or the emergency contact when the person could not be found or reached.
    const viaContact = locate || (recheck && failed >= MAX_FAILED_CALLS);
    const retryOk = !c || at - c.lastCallMin >= RETRY_MIN;
    const callDue = viaContact
      ? locateTries < MAX_LOCATE_TRIES && retryOk
      : failed < MAX_FAILED_CALLS && retryOk && (recheck || wait >= CALL_AFTER_MIN);
    if (!callDue || calls >= callBudget) continue;
    calls++;
    const pReach = viaContact
      ? REACH.emergencyContact
      : (hh.phoneOnFile ? REACH.phone : REACH.noPhone) *
        (safety === 'needs_help' ? REACH.needsHelp : 1) *
        (hh.limitedEnglish ? REACH.limitedEnglish : 1) *
        (damage === 3 ? REACH.destroyed : 1);
    const reached = rand01(`${hh.id}:${at}`) < pReach;
    const contact = {
      householdId: hh.id,
      failedCalls: reached ? 0 : viaContact ? failed : failed + 1,
      lastCallMin: at,
      locateTries: viaContact ? (reached ? 0 : locateTries + 1) : locateTries,
    };
    if (c) ctx.db.staffContact.householdId.update(contact);
    else ctx.db.staffContact.insert(contact);
    if (!reached) {
      if (locate && contact.locateTries >= MAX_LOCATE_TRIES) {
        // Documented closure, never a silent one: visited, nobody home, emergency contact unreachable.
        closeUnreachable(ctx, hh.id, hh.hex);
        followupHexes.add(hh.hex);
      }
      continue;
    }
    st.callsReached++;
    if (safety === 'needs_help') st.helpFound++;
    // The person answers wherever they are: away people cannot say how the house is.
    const notHome = viaContact || !home;
    const knownDamage = where === 'away' || viaContact ? null : noisyDamage(hh.id, at, damage);
    onEvent(
      ctx,
      {
        kind: 'sms_reply',
        t: at,
        householdId: hh.id,
        safety,
        damage: knownDamage,
        lifeSafety: safety === 'needs_help' && truth.needType === 'life_safety',
        needs: callNeeds(hh, truth, knownDamage, outagePct, hazard),
        notHome,
        channel: 'call',
      },
      'staff_sim',
      batch
    );
  }
  st.callsMade += calls;
  st.visitsMade += visits;

  // 4. Property inspections: the top unverified inspection candidates across all cells.
  const inspBudget = Math.round((st.inspectionsPerHour * STAFF_STEP_MIN) / 60);
  if (inspBudget > 0) {
    const candidates = [...ctx.db.inspectionCandidate.iter()].sort(
      (a, b) => b.inspectScore - a.inspectScore || (a.householdId < b.householdId ? -1 : 1)
    );
    let inspections = 0;
    for (const cnd of candidates) {
      if (inspections >= inspBudget) break;
      if (visited.has(cnd.householdId)) continue;
      // Skip houses already assessed (a people-only visit leaves the property to inspect).
      if ([...ctx.db.fieldReport.householdId.filter(cnd.householdId)].some((r) => r.damageKnown)) continue;
      const hh = ctx.db.household.id.find(cnd.householdId);
      const truth = ctx.db.simTruth.householdId.find(cnd.householdId);
      if (!hh || !truth) continue;
      const safety = (truth.safety === 'needs_help' ? 'needs_help' : 'safe') as 'safe' | 'needs_help';
      const seen = locationAt(truth, at) === 'home';
      if (seen && safety === 'needs_help') st.helpFound++;
      const note = seen ? 'simulated property inspection: occupants seen' : 'simulated property inspection: nobody home';
      onEvent(
        ctx,
        { kind: 'field_report', t: at, householdId: hh.id, adjusterId: 'sim-adjuster', safety: seen ? safety : 'unsure', damage: truth.damage as Damage, note },
        'staff_sim',
        batch
      );
      visited.add(hh.id);
      inspections++;
    }
    st.inspectionsMade += inspections;
  }

  if (batch.stats.size > 0) flushBatch(ctx, batch);
  const rest = [...followupHexes].filter((h) => !batch.stats.has(h));
  if (rest.length > 0) recomputeCells(ctx, rest);

  st.lastRunMin = at;
  st.updatedAt = ctx.timestamp;
  ctx.db.staffSim.id.update(st);
}
