// Replay clock: a scheduled reducer ticks every second while running, advances sim time by
// `speed` sim-minutes per real second, and releases due staged events through onEvent.
// Touched cells are recomputed every tick; every cell is recomputed (and the holdout set rescored)
// every `fullRecomputeEveryMin` sim minutes, on jump, on pause and at the end.
import { SenderError, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import spacetimedb, { replayTick, type Ctx } from '../schema';
import { getReplay, microsBetween, requireManager } from '../state';
import { clearDemoState, flushBatch, newBatch, onEvent, parseNeeds, rebuildAll, refreshHoldoutMetrics, type IngestEvent } from '../ingest';
import { recomputeCells } from '../fusion';
import { defaultCapacity, getStaff, runStaffUpTo, STAFF_STEP_MIN } from '../staff';
import type { Damage, Peril, Safety } from '../fusion/contract';

const TICK_MICROS = 1_000_000n; // 1 s
const MAX_SPEED = 1440; // 1 sim-day per second
const MAX_CADENCE_MIN = 4320;
const JUMP_FULL_RECOMPUTE_MIN = 360;

type StagedRow = NonNullable<ReturnType<Ctx['db']['stagedEvent']['seq']['find']>>;
type ReplayRow = ReturnType<typeof getReplay>;

function toIngest(e: StagedRow): IngestEvent {
  switch (e.kind) {
    case 'sms_reply':
      return {
        kind: 'sms_reply',
        t: e.t,
        householdId: e.householdId,
        safety: e.safety as 'safe' | 'needs_help',
        damage: e.damageKnown ? (e.damage as Damage) : null,
        text: e.text,
        language: e.language,
        lifeSafety: e.lifeSafety,
        needs: parseNeeds(e.needs),
        notHome: e.notHome,
        channel: e.channel === 'call' ? 'call' : 'sms',
      };
    case 'claim':
      return {
        kind: 'claim',
        t: e.t,
        householdId: e.householdId,
        peril: e.peril as Peril,
        reportedDamage: e.reportedDamage as Damage,
      };
    case 'field_report':
      return {
        kind: 'field_report',
        t: e.t,
        householdId: e.householdId,
        adjusterId: e.adjusterId,
        safety: e.safety as Safety,
        damage: e.damageKnown ? (e.damage as Damage) : null, // null = people checked, house not assessed
        note: '',
      };
    default:
      return { kind: 'sms_sent', t: e.t, householdId: e.householdId, delivered: e.delivered };
  }
}

/**
 * Release every staged event with t <= upTo (in seq order), then recompute each touched cell once.
 * Returns the number of released events. Caller persists replay_state.
 */
function releaseUpTo(ctx: Ctx, rs: ReplayRow, upTo: number): number {
  const batch = newBatch(ctx);
  let seq = rs.nextSeq;
  let released = 0;
  while (seq < rs.totalStaged) {
    const e = ctx.db.stagedEvent.seq.find(seq);
    if (e && e.t > upTo) break;
    seq++;
    if (!e) continue;
    try {
      onEvent(ctx, toIngest(e), 'replay', batch);
      released++;
    } catch (err) {
      // onEvent validates before writing, so a bad staged row is skipped without side effects.
      console.warn(`skipping staged event ${e.seq}: ${String(err)}`);
    }
  }
  rs.nextSeq = seq;
  if (released > 0) flushBatch(ctx, batch);
  return released;
}

/** Recompute every cell at the current sim time and rescore the holdout set. */
function fullRecompute(ctx: Ctx, rs: ReplayRow) {
  recomputeCells(ctx, [...ctx.db.hexStats.iter()].map(s => s.hex));
  refreshHoldoutMetrics(ctx);
  rs.lastFullRecomputeMin = rs.simMinutes;
}

function stopTicking(ctx: Ctx) {
  ctx.db.replayTick.clear();
}

/**
 * One clock step to `next` sim minutes: release due events, recompute touched cells, run the full
 * recompute when the cadence is due, stop at the end. Shared by the scheduled tick and step_replay.
 */
function advance(ctx: Ctx, rs: ReplayRow, next: number) {
  rs.simMinutes = Math.min(rs.maxMinutes, next);
  rs.lastTickAt = ctx.timestamp;
  ctx.db.replayState.id.update(rs); // persist the clock first: recomputes read sim time from the table
  releaseUpTo(ctx, rs, Math.floor(rs.simMinutes));
  runStaffUpTo(ctx, rs.simMinutes);
  const finished = rs.simMinutes >= rs.maxMinutes && rs.nextSeq >= rs.totalStaged;
  const due = rs.fullRecomputeEveryMin > 0 && rs.simMinutes - rs.lastFullRecomputeMin >= rs.fullRecomputeEveryMin;
  if (due || finished) fullRecompute(ctx, rs);
  if (finished) {
    rs.running = false;
    stopTicking(ctx);
  }
  ctx.db.replayState.id.update(rs);
}

export const tick = spacetimedb.reducer(
  { name: 'replay_tick', onSchedule: replayTick },
  { arg: replayTick.rowType },
  (ctx, { arg: _arg }) => {
    if (!ctx.sender.equals(ctx.databaseIdentity)) throw new SenderError('replay_tick is called by the scheduler only');
    const rs = getReplay(ctx);
    if (!rs.running) {
      stopTicking(ctx);
      return;
    }
    const elapsedSec = Math.min(5, Math.max(0, microsBetween(rs.lastTickAt, ctx.timestamp) / 1e6));
    advance(ctx, rs, rs.simMinutes + rs.speed * elapsedSec);
  }
);

/** Advance the clock by `minutes` exactly like one tick would (no scheduler; works while paused). */
export const stepReplay = spacetimedb.reducer({ name: 'step_replay' }, { minutes: t.f64() }, (ctx, { minutes }) => {
  requireManager(ctx);
  if (!(minutes > 0 && minutes <= MAX_SPEED)) throw new SenderError(`minutes must be in (0, ${MAX_SPEED}]`);
  const rs = getReplay(ctx);
  if (rs.totalStaged === 0) throw new SenderError('no staged events: run scripts/seed.ts first');
  advance(ctx, rs, rs.simMinutes + minutes);
});

export const startReplay = spacetimedb.reducer({ name: 'start_replay' }, { speed: t.f64() }, (ctx, { speed }) => {
  requireManager(ctx);
  if (!(speed > 0 && speed <= MAX_SPEED)) throw new SenderError(`speed must be in (0, ${MAX_SPEED}] sim-minutes per second`);
  const rs = getReplay(ctx);
  if (rs.totalStaged === 0) throw new SenderError('no staged events: run scripts/seed.ts first');
  if (rs.simMinutes >= rs.maxMinutes && rs.nextSeq >= rs.totalStaged)
    throw new SenderError('replay finished: call reset_demo first');
  if (!rs.running) rs.lastTickAt = ctx.timestamp;
  rs.running = true;
  rs.speed = speed;
  ctx.db.replayState.id.update(rs);
  if (ctx.db.replayTick.count() === 0n)
    ctx.db.replayTick.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(TICK_MICROS) });
});

/** Stop ticking (no scheduled calls, no energy while paused) and bring every cell up to date. */
export const pauseReplay = spacetimedb.reducer({ name: 'pause_replay' }, ctx => {
  requireManager(ctx);
  const rs = getReplay(ctx);
  const wasRunning = rs.running;
  rs.running = false;
  stopTicking(ctx);
  if (wasRunning) fullRecompute(ctx, rs);
  ctx.db.replayState.id.update(rs);
});

/**
 * Jump the sim clock. Forward: releases everything due at once. Backward: resets the demo
 * (drops live replies, field reports and assignments) and replays up to `minutes`.
 */
export const jumpTo = spacetimedb.reducer({ name: 'jump_to' }, { minutes: t.f64() }, (ctx, { minutes }) => {
  requireManager(ctx);
  let rs = getReplay(ctx);
  if (!(minutes >= 0 && minutes <= rs.maxMinutes)) throw new SenderError(`minutes must be in [0, ${rs.maxMinutes}]`);
  if (minutes < rs.simMinutes) {
    const wasRunning = rs.running;
    const speed = rs.speed;
    const cadence = rs.fullRecomputeEveryMin;
    clearDemoState(ctx);
    rebuildAll(ctx);
    rs = getReplay(ctx);
    rs.speed = speed;
    rs.fullRecomputeEveryMin = cadence;
    if (wasRunning) {
      rs.running = true;
      ctx.db.replayTick.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(TICK_MICROS) });
    }
  }
  // With simulated staff on, walk forward in staff steps so they act on the queue as it was then.
  // Touched cells are recomputed every step anyway; full recomputes (time-based escalation, re-checks)
  // only every JUMP_FULL_RECOMPUTE_MIN inside a jump to keep long jumps affordable.
  if (getStaff(ctx).enabled) {
    const cadence = rs.fullRecomputeEveryMin;
    rs.fullRecomputeEveryMin = Math.max(cadence, JUMP_FULL_RECOMPUTE_MIN);
    while (rs.simMinutes + STAFF_STEP_MIN < minutes) advance(ctx, rs, rs.simMinutes + STAFF_STEP_MIN);
    rs.fullRecomputeEveryMin = cadence;
  }
  rs.simMinutes = minutes;
  rs.lastTickAt = ctx.timestamp;
  ctx.db.replayState.id.update(rs);
  releaseUpTo(ctx, rs, Math.floor(minutes));
  runStaffUpTo(ctx, minutes);
  if (minutes >= rs.maxMinutes && rs.nextSeq >= rs.totalStaged) {
    rs.running = false;
    stopTicking(ctx);
  }
  fullRecompute(ctx, rs);
  ctx.db.replayState.id.update(rs);
});

/** Change the speed without starting or stopping. */
export const setSpeed = spacetimedb.reducer({ name: 'set_speed' }, { speed: t.f64() }, (ctx, { speed }) => {
  requireManager(ctx);
  if (!(speed > 0 && speed <= MAX_SPEED)) throw new SenderError(`speed must be in (0, ${MAX_SPEED}]`);
  const rs = getReplay(ctx);
  ctx.db.replayState.id.update({ ...rs, speed });
});

/**
 * How often (sim minutes) the running replay recomputes every cell and rescores the holdout set.
 * 0 = never while running (touched cells are still recomputed every tick; pause, jump and the end
 * always recompute everything). Larger worlds can use 120-240 to cut per-tick cost.
 */
export const setRecomputeCadence = spacetimedb.reducer(
  { name: 'set_recompute_cadence' },
  { minutes: t.u32() },
  (ctx, { minutes }) => {
    requireManager(ctx);
    if (minutes > MAX_CADENCE_MIN) throw new SenderError(`minutes must be in [0, ${MAX_CADENCE_MIN}]`);
    const rs = getReplay(ctx);
    ctx.db.replayState.id.update({ ...rs, fullRecomputeEveryMin: minutes });
  }
);

/**
 * Simulated staff for the demo (see src/staff.ts). callsPerHour / visitsPerHour / inspectionsPerHour = 0 means the default
 * (2% / 0.3% / 0.2% of households per hour). Takes effect from the current sim time.
 */
export const setStaffSim = spacetimedb.reducer(
  { name: 'set_staff_sim' },
  { enabled: t.bool(), callsPerHour: t.u32(), visitsPerHour: t.u32(), inspectionsPerHour: t.u32() },
  (ctx, { enabled, callsPerHour, visitsPerHour, inspectionsPerHour }) => {
    requireManager(ctx);
    const cap = defaultCapacity(Number(ctx.db.household.count()));
    if (callsPerHour > 100_000 || visitsPerHour > 100_000 || inspectionsPerHour > 100_000) throw new SenderError('capacity too large');
    const st = getStaff(ctx);
    const rs = getReplay(ctx);
    ctx.db.staffSim.id.update({
      ...st,
      enabled,
      callsPerHour: callsPerHour || cap.callsPerHour,
      visitsPerHour: visitsPerHour || cap.visitsPerHour,
      inspectionsPerHour: inspectionsPerHour || cap.inspectionsPerHour,
      // Turning staff on mid-replay starts from now (no backlog of missed steps).
      lastRunMin: enabled && !st.enabled ? Math.floor(rs.simMinutes / STAFF_STEP_MIN) * STAFF_STEP_MIN : st.lastRunMin,
      updatedAt: ctx.timestamp,
    });
  }
);
