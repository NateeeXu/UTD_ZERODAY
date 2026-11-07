// Replay clock: a scheduled reducer ticks every second while running, advances sim time by
// `speed` sim-minutes per real second, and releases due staged events through onEvent.
import { SenderError, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import spacetimedb, { replayTick, type Ctx } from '../schema';
import { getReplay, microsBetween, requireManager } from '../state';
import { clearDemoState, onEvent, rebuildAll, refreshHoldoutMetrics, type IngestEvent } from '../ingest';
import { prepareRecompute, recomputeHex } from '../fusion';
import type { Damage, Peril, Safety } from '../fusion/contract';

const TICK_MICROS = 1_000_000n; // 1 s
const MAX_SPEED = 1440; // 1 sim-day per second
const HOLDOUT_EVERY_MIN = 60; // refresh holdout metrics each sim hour while replaying

type StagedRow = NonNullable<ReturnType<Ctx['db']['stagedEvent']['seq']['find']>>;

function toIngest(e: StagedRow): IngestEvent {
  switch (e.kind) {
    case 'sms_reply':
      return {
        kind: 'sms_reply',
        t: e.t,
        householdId: e.householdId,
        safety: e.safety as 'safe' | 'needs_help',
        damage: e.damage as Damage,
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
        damage: e.damage as Damage,
        note: '',
      };
    default:
      return { kind: 'sms_sent', t: e.t, householdId: e.householdId };
  }
}

/**
 * Release every staged event with t <= upTo (in seq order), then recompute each touched cell once.
 * Returns the number of released events. Caller persists replay_state.
 */
function releaseUpTo(ctx: Ctx, rs: ReturnType<typeof getReplay>, upTo: number): number {
  const dirty = new Set<string>();
  let seq = rs.nextSeq;
  let released = 0;
  while (seq < rs.totalStaged) {
    const e = ctx.db.stagedEvent.seq.find(seq);
    if (e && e.t > upTo) break;
    seq++;
    if (!e) continue;
    try {
      onEvent(ctx, toIngest(e), 'replay', dirty);
      released++;
    } catch (err) {
      // onEvent validates before writing, so a bad staged row is skipped without side effects.
      console.warn(`skipping staged event ${e.seq}: ${String(err)}`);
    }
  }
  rs.nextSeq = seq;
  if (dirty.size > 0) {
    const prep = prepareRecompute(ctx);
    for (const hexId of dirty) recomputeHex(ctx, hexId, prep);
  }
  return released;
}

/** Recompute every cell at the current sim time (silence grows as time passes, even without events). */
function recomputeAllCells(ctx: Ctx) {
  const prep = prepareRecompute(ctx);
  for (const s of [...ctx.db.hexStats.iter()]) recomputeHex(ctx, s.hex, prep);
}

function stopTicking(ctx: Ctx) {
  ctx.db.replayTick.clear();
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
    const prev = rs.simMinutes;
    const next = Math.min(rs.maxMinutes, prev + rs.speed * elapsedSec);
    rs.simMinutes = next;
    rs.lastTickAt = ctx.timestamp;
    ctx.db.replayState.id.update(rs); // persist the clock first: recomputeHex reads sim time from the table
    releaseUpTo(ctx, rs, Math.floor(next));

    const crossedHour = Math.floor(next / HOLDOUT_EVERY_MIN) !== Math.floor(prev / HOLDOUT_EVERY_MIN);
    if (crossedHour) {
      // Hourly: let time-dependent silence update everywhere, then rescore the holdout set.
      recomputeAllCells(ctx);
      refreshHoldoutMetrics(ctx);
    }
    if (next >= rs.maxMinutes && rs.nextSeq >= rs.totalStaged) {
      rs.running = false;
      stopTicking(ctx);
      if (!crossedHour) refreshHoldoutMetrics(ctx);
    }
    ctx.db.replayState.id.update(rs);
  }
);

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

export const pauseReplay = spacetimedb.reducer({ name: 'pause_replay' }, ctx => {
  requireManager(ctx);
  const rs = getReplay(ctx);
  rs.running = false;
  ctx.db.replayState.id.update(rs);
  stopTicking(ctx); // no scheduled reducer runs (and no energy is spent) while paused
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
    clearDemoState(ctx);
    rebuildAll(ctx);
    rs = getReplay(ctx);
    rs.speed = speed;
    if (wasRunning) {
      rs.running = true;
      ctx.db.replayTick.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(TICK_MICROS) });
    }
  }
  rs.simMinutes = minutes;
  rs.lastTickAt = ctx.timestamp;
  ctx.db.replayState.id.update(rs); // persist the clock first: recomputeHex reads sim time from the table
  releaseUpTo(ctx, rs, Math.floor(minutes));
  if (minutes >= rs.maxMinutes && rs.nextSeq >= rs.totalStaged) {
    rs.running = false;
    stopTicking(ctx);
  }
  ctx.db.replayState.id.update(rs);
  recomputeAllCells(ctx);
  refreshHoldoutMetrics(ctx);
});

/** Change the speed without starting or stopping. */
export const setSpeed = spacetimedb.reducer({ name: 'set_speed' }, { speed: t.f64() }, (ctx, { speed }) => {
  requireManager(ctx);
  if (!(speed > 0 && speed <= MAX_SPEED)) throw new SenderError(`speed must be in (0, ${MAX_SPEED}]`);
  const rs = getReplay(ctx);
  ctx.db.replayState.id.update({ ...rs, speed });
});
