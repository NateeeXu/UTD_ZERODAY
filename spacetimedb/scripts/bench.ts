// Reducer timings for one database (client-measured round trips on a persistent connection; on a
// local server that is reducer time + ~1 ms).
//
//   node scripts/bench.ts --db triage-loop-ca [--speed 30] [--cadence 60]
//
// Measures: recompute_all, jump_to(4320) from t=0, one replay tick at `speed` (step_replay(speed),
// the same code path as the scheduled tick) over the whole 72 h split into ticks with and without the
// full recompute, pause_replay (full recompute), and one adjuster field report. Leaves the database
// reset to t = 0 with the cadence restored to 60.
import { connect, DB, errText, ownerToken, STAFF_PASSCODE, subscribe } from './lib.ts';

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const SPEED = Number(arg('--speed') ?? 30);
const CADENCE = Number(arg('--cadence') ?? 60);

const ms = (t0: number) => performance.now() - t0;
async function time(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return ms(t0);
}
function summary(xs: number[]) {
  if (xs.length === 0) return 'n=0';
  const s = xs.slice().sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `median ${q(0.5).toFixed(1)} ms, p95 ${q(0.95).toFixed(1)} ms, max ${s[s.length - 1].toFixed(1)} ms (n=${s.length})`;
}

async function main() {
  const { conn } = await connect(ownerToken());
  const r = conn.reducers;
  await subscribe(conn, ['SELECT * FROM replay_state', 'SELECT * FROM metrics', 'SELECT * FROM inspection_candidate']);
  const m0 = [...conn.db.metrics.iter()][0];
  console.log(`database ${DB}: ${m0?.hexes} cells, ${m0?.households} households, engine ${m0?.engine}`);

  await r.resetDemo({});
  const reset = await time(() => r.resetDemo({}));
  const jumpAll = await time(() => r.jumpTo({ minutes: 4320 }));
  const recompute: number[] = [];
  for (let i = 0; i < 3; i++) recompute.push(await time(() => r.recomputeAll({})));

  // Replay ticks at SPEED over the whole horizon.
  await r.resetDemo({});
  await r.setRecomputeCadence({ minutes: CADENCE });
  const withFull: number[] = [];
  const withoutFull: number[] = [];
  let early = 0;
  for (let t = 0; t < 4320; t += SPEED) {
    const before = [...conn.db.replayState.iter()][0]!;
    const lastFull = before.lastFullRecomputeMin;
    const dt = await time(() => r.stepReplay({ minutes: SPEED }));
    const after = [...conn.db.replayState.iter()][0]!;
    if (after.lastFullRecomputeMin !== lastFull) withFull.push(dt);
    else withoutFull.push(dt);
    if (t < 240) early = Math.max(early, dt);
  }

  // Field report (single-cell path incl. world refs) and pause (full recompute) at t = 24 h.
  await r.jumpTo({ minutes: 1440 });
  await r.startReplay({ speed: 1 });
  const pause = await time(() => r.pauseReplay({}));
  const adj = await connect();
  await adj.conn.reducers.joinAs({ role: 'adjuster', name: 'bench-adj', passcode: STAFF_PASSCODE });
  const picks = [...conn.db.inspectionCandidate.iter()].sort((a, b) => b.inspectScore - a.inspectScore).slice(0, 10);
  const reports: number[] = [];
  for (const p of picks)
    reports.push(await time(() => adj.conn.reducers.submitFieldReport({ householdId: p.householdId, safety: 'safe', damage: 1, note: 'bench', memberMissing: false })));
  await adj.conn.reducers.leave({});
  adj.conn.disconnect();

  await r.setRecomputeCadence({ minutes: 60 });
  await r.resetDemo({});

  console.log({
    database: DB,
    reset_demo: `${reset.toFixed(0)} ms`,
    jump_to_4320_from_0: `${jumpAll.toFixed(0)} ms`,
    recompute_all: summary(recompute),
    [`tick_speed${SPEED}_without_full_recompute`]: summary(withoutFull),
    [`tick_speed${SPEED}_with_full_recompute_cadence${CADENCE}`]: summary(withFull),
    first_4h_worst_tick: `${early.toFixed(0)} ms`,
    pause_replay_full_recompute: `${pause.toFixed(0)} ms`,
    submit_field_report: summary(reports),
  });
  conn.disconnect();
}

main().then(
  () => process.exit(0),
  e => {
    console.error(errText(e));
    process.exit(1);
  }
);
