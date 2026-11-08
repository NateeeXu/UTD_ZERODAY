import { useEffect, useRef, useState } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings/index.ts';
import type { ReplayStateRow, StaffSimRow } from './rows';
import { FAST_FORWARD, REPLAY_SPEED, SPEED_MULTIPLIERS, STEP_MIN } from './config';
import { fmtT } from '../format';

// The database ticks about once a second and moves the clock by speed × elapsed seconds, so the raw
// value jumps 60–90 sim-minutes at 2×/3× and stalls whenever a tick runs late. The bar and clock
// instead follow an estimate of the database clock (last value + speed × time since it arrived),
// speeding up a little when behind and slowing down when ahead (0.3×–2×, never stopping, never
// jumping back). Simulated with jittery and late ticks this stays within ~0.95–1.06× of the set speed.
// A jump or reset (more than 3 s of playback away) snaps.
function useSmoothMinutes(replay: ReplayStateRow | undefined): number {
  const target = replay?.simMinutes ?? 0;
  const running = !!replay?.running;
  const speed = replay?.speed ?? 0;
  const max = replay?.maxMinutes || 4320;
  const anchor = useRef({ min: target, at: 0 });
  const shown = useRef(target);
  const [, redraw] = useState(0);

  useEffect(() => {
    anchor.current = { min: target, at: performance.now() };
    if (!running) shown.current = target;
  }, [target, running]);

  useEffect(() => {
    if (!running || speed <= 0) return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      const a = anchor.current;
      const est = Math.min(max, a.min + (speed * (now - a.at)) / 1000);
      const prev = shown.current;
      let next: number;
      if (Math.abs(est - prev) > speed * 3) next = est;
      else {
        const rate = Math.max(0.3, Math.min(2, 1 + (est - prev) / speed));
        next = Math.min(max, a.min + speed * 2, prev + speed * rate * dt);
        next = Math.max(prev, next);
      }
      if (next !== prev) {
        shown.current = next;
        redraw((x) => x + 1);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [running, speed, max]);

  return running ? shown.current : target;
}

// Bottom bar: replay clock from `replay_state`, manager-only controls.
export function ReplayBar({ replay, canControl, onNeedJoin }: { replay: ReplayStateRow | undefined; canControl: boolean; onNeedJoin: () => void }) {
  const start = useReducer(reducers.startReplay);
  const pause = useReducer(reducers.pauseReplay);
  const step = useReducer(reducers.stepReplay);
  const reset = useReducer(reducers.resetDemo);
  const setSpeed = useReducer(reducers.setSpeed);
  const setStaffSim = useReducer(reducers.setStaffSim);
  const [staffRows] = useTable(tables.staffSim);
  const staff = staffRows[0];
  const [mult, setMult] = useState<number | null>(null); // null = follow the database
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ff, setFf] = useState<{ done: number; total: number } | null>(null);
  const replayRef = useRef(replay);
  replayRef.current = replay;

  // Current multiplier: the database's speed while running, else the local pick.
  const dbMult = replay ? Math.round((replay.speed / REPLAY_SPEED) * 10) / 10 : 1;
  const shownMult = replay?.running ? dbMult : (mult ?? dbMult);
  const pickSpeed = (m: number) => {
    if (!canControl) return onNeedJoin();
    setMult(m);
    if (replay?.running) void run(() => setSpeed({ speed: REPLAY_SPEED * m }))();
  };
  const max = replay?.maxMinutes || 4320;
  const t = replay?.simMinutes ?? 0;
  const atEnd = t >= max - 0.5;
  const shownT = useSmoothMinutes(replay); // display only; logic uses the database value
  const run = (fn: () => Promise<void>) => async () => {
    if (!canControl) return onNeedJoin();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const ticks = [0, 12, 24, 36, 48, 60, 72].filter((h) => h * 60 <= max);

  // Fast-forward in 4-hour steps (one transaction each) instead of one long jump_to.
  const fastForward = (steps: number) => run(async () => {
    setFf({ done: 0, total: steps });
    try {
      for (let i = 0; i < steps; i++) {
        const r = replayRef.current;
        if (r && r.simMinutes >= r.maxMinutes - 0.5) break;
        await step({ minutes: STEP_MIN });
        setFf({ done: i + 1, total: steps });
      }
    } finally {
      setFf(null);
    }
  });

  return (
    <footer className="timeline live">
      {replay?.running ? (
        <button className="btn primary" onClick={run(() => pause())} disabled={busy}>Pause</button>
      ) : (
        <button
          className="btn primary"
          onClick={run(async () => {
            // At the end of the 72 h, Start means "play it again": reset to landfall first.
            if (atEnd) await reset();
            await start({ speed: REPLAY_SPEED * shownMult });
          })}
          disabled={busy}
          title={atEnd ? 'Resets the demo and replays from landfall' : undefined}
        >
          {t > 0 && !atEnd ? 'Resume' : 'Start'}
        </button>
      )}
      <div className="timeline-track">
        <div className="progress" aria-hidden>
          <div className="progress-fill" style={{ width: `${Math.min(100, (shownT / max) * 100)}%`, transition: 'none' }} />

        </div>
        <div className="ticks">
          {ticks.map((h) => <span key={h}>{h === 0 ? 'Landfall' : `+${h}h`}</span>)}
        </div>
      </div>
      <span className="clock" title={replay ? `${replay.nextSeq.toLocaleString()} of ${replay.totalStaged.toLocaleString()} events released` : ''}>
        {fmtT(Math.floor(shownT))}
      </span>
      <div className="segmented speed" role="group" aria-label="Replay speed" title={`1× = ${REPLAY_SPEED} sim-minutes per second`}>
        {SPEED_MULTIPLIERS.map((m) => (
          <button key={m} className={Math.abs(shownMult - m) < 0.05 ? 'on' : ''} aria-pressed={Math.abs(shownMult - m) < 0.05} onClick={() => pickSpeed(m)} disabled={busy}>
            {m}×
          </button>
        ))}
      </div>
      <div className="jumps" role="group" aria-label="Fast-forward">
        {FAST_FORWARD.map((f) => (
          <button key={f.label} className="btn" onClick={fastForward(f.steps)} disabled={busy || atEnd}
            title={`Advance ${f.steps * STEP_MIN / 60} sim hours in ${STEP_MIN / 60}-hour steps`}>
            {ff && ff.total === f.steps ? `${ff.done * STEP_MIN / 60}/${f.steps * STEP_MIN / 60} h…` : f.label}
          </button>
        ))}
      </div>
      <button
        className={`staff-switch${staff?.enabled ? ' on' : ''}`}
        role="switch"
        aria-checked={!!staff?.enabled}
        disabled={busy || !staff}
        title="Simulated agents call, adjusters visit and inspect, and the referral desk refers to 911 / local agencies every 30 sim-minutes (default staffing). Turn off to compare with no staff."
        onClick={run(() => setStaffSim({ enabled: !staff?.enabled, callsPerHour: 0, visitsPerHour: 0, inspectionsPerHour: 0 }))}
      >
        <i aria-hidden="true" />
        Simulated staff {staff?.enabled ? 'on' : 'off'}
      </button>
      <StaffActivity staff={staff} />
      <button className="btn ghost" onClick={run(() => reset())} disabled={busy}>Reset</button>
      {error && <span className="form-error small">{error}</span>}
      {replay?.running && <span className="muted small energy">Running uses Maincloud energy — pause when not demoing</span>}
    </footer>
  );
}

// Simulated staff counters (staff_sim), behind one small button so the bar stays short.
function StaffActivity({ staff }: { staff: StaffSimRow | undefined }) {
  const [open, setOpen] = useState(false);
  if (!staff) return null;
  const rows: [string, number][] = [
    ['Calls made', staff.callsMade],
    ['Calls answered', staff.callsReached],
    ['Visits', staff.visitsMade],
    ['Visits · nobody home', staff.visitsNobodyHome],
    ['Property inspections', staff.inspectionsMade],
    ['Referred to 911 / local agency', staff.referralsMade],
    ['People found needing help', staff.helpFound],
  ];
  return (
    <div className="staff-activity">
      <button className="btn ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Staff work · {staff.callsMade.toLocaleString()} calls
      </button>
      {open && (
        <div className="glass staff-pop" role="dialog" aria-label="Simulated staff activity">
          <b>Simulated staff so far</b>
          <dl>
            {rows.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v.toLocaleString()}</dd></div>))}
          </dl>
          <span className="small muted">Simulation results. State Farm refers life-safety cases; 911 / local agencies respond.</span>
        </div>
      )}
    </div>
  );
}
