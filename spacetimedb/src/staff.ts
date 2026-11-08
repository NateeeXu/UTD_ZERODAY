// Simulated staff (demo only): who works the "no one overlooked" queues while the replay runs.
// Every STAFF_STEP_MIN sim minutes, in this order:
//   1. Referral desk (no capacity limit, life safety first): refers every new needs-help report;
//      the agency acknowledges after AGENCY_ACK_MIN and resolves after AGENCY_RESOLVE_MIN.
//   2. Adjusters (visitsPerHour): visit the highest-scored queue households that calls could not reach.
//   3. Agents (callsPerHour): call the highest-scored queue households past the SMS window, with retries.
// Outcomes come from the private sim truth (the simulated world), never from the model. A reached call
// is stored as an sms_reply with text '[agent call]'; a visit as a field_report from 'sim-adjuster'.
import type { Ctx } from './schema';
import { flushBatch, newBatch, onEvent } from './ingest';
import { QUEUE_AGING_MIN, recomputeCells } from './fusion';
import { SINGLETON } from './state';
import type { Damage, Safety } from './fusion/contract';

export const STAFF_STEP_MIN = 30;
const CALL_AFTER_MIN = 60; // give the outreach text an hour before calling
const RETRY_MIN = 120; // between calls to the same household
const MAX_FAILED_CALLS = 3;
const VISIT_AFTER_MIN = 240; // one failed call + 4 h of silence -> visit (two failed calls -> visit now)
const AGENCY_ACK_MIN = 30;
const AGENCY_RESOLVE_MIN = 360;
const REACH = { phone: 0.75, phoneNeedsHelp: 0.35, noPhone: 0.4 }; // P(call answered)
const REFERRAL_STATES = ['emergency_referral', 'referral_overdue', 'referral_pending', 'referral_acknowledged'];

/** Default capacity: calls 2% and visits 0.3% of households per hour (e.g. 600 calls, 90 visits for 30,000). */
export function defaultCapacity(households: number) {
  return { callsPerHour: Math.max(20, Math.round(households * 0.02)), visitsPerHour: Math.max(5, Math.round(households * 0.003)) };
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
    closedBy: prev?.closedBy ?? '',
    updatedAt: ctx.timestamp,
  };
  if (prev) ctx.db.householdFollowup.householdId.update(row);
  else ctx.db.householdFollowup.insert(row);
}

function staffStep(ctx: Ctx, at: number) {
  const st = getStaff(ctx);
  const followupHexes = new Set<string>();

  // 1. Referral desk.
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
  const batch = newBatch(ctx);
  let calls = 0;
  let visits = 0;
  for (const q of queue) {
    if (calls >= callBudget && visits >= visitBudget) break;
    const hh = ctx.db.household.id.find(q.householdId);
    const truth = ctx.db.simTruth.householdId.find(q.householdId);
    if (!hh || !truth) continue;
    const safety = truth.safety as Safety;
    const damage = truth.damage as Damage;
    const c = ctx.db.staffContact.householdId.find(q.householdId);
    const failed = c?.failedCalls ?? 0;
    const wait = at - q.waitSinceMin;
    const recheck = q.escalation === 'recheck';

    // A re-check that two calls could not reach becomes a welfare visit.
    const visitDue = failed >= 2 || (!recheck && failed >= 1 && wait >= VISIT_AFTER_MIN);
    if (visitDue && visits < visitBudget) {
      onEvent(ctx, { kind: 'field_report', t: at, householdId: hh.id, adjusterId: 'sim-adjuster', safety, damage, note: 'simulated staff visit' }, 'staff_sim', batch);
      visits++;
      if (safety === 'needs_help') st.helpFound++;
      continue;
    }

    const callDue = failed < MAX_FAILED_CALLS && (!c || at - c.lastCallMin >= RETRY_MIN) && (recheck || wait >= CALL_AFTER_MIN);
    if (!callDue || calls >= callBudget) continue;
    calls++;
    const pReach = !hh.phoneOnFile ? REACH.noPhone : safety === 'needs_help' ? REACH.phoneNeedsHelp : REACH.phone;
    const reached = rand01(`${hh.id}:${at}`) < pReach;
    const contact = { householdId: hh.id, failedCalls: reached ? 0 : failed + 1, lastCallMin: at };
    if (c) ctx.db.staffContact.householdId.update(contact);
    else ctx.db.staffContact.insert(contact);
    if (!reached) continue;
    st.callsReached++;
    if (safety === 'needs_help') st.helpFound++;
    onEvent(ctx, { kind: 'sms_reply', t: at, householdId: hh.id, safety: safety === 'needs_help' ? 'needs_help' : 'safe', damage, text: '[agent call] reached by phone' }, 'staff_sim', batch);
  }
  st.callsMade += calls;
  st.visitsMade += visits;

  if (batch.stats.size > 0) flushBatch(ctx, batch);
  const rest = [...followupHexes].filter((h) => !batch.stats.has(h));
  if (rest.length > 0) recomputeCells(ctx, rest);

  st.lastRunMin = at;
  st.updatedAt = ctx.timestamp;
  ctx.db.staffSim.id.update(st);
}
