import { useState } from 'react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../module_bindings/index.ts';
import type { ReplayStateRow } from './rows';
import { JUMPS, REPLAY_SPEED, SPEED_MULTIPLIERS } from './config';
import { fmtT } from '../format';

// Bottom bar: replay clock from `replay_state`, manager-only controls.
export function ReplayBar({ replay, canControl, onNeedJoin }: { replay: ReplayStateRow | undefined; canControl: boolean; onNeedJoin: () => void }) {
  const start = useReducer(reducers.startReplay);
  const pause = useReducer(reducers.pauseReplay);
  const jump = useReducer(reducers.jumpTo);
  const reset = useReducer(reducers.resetDemo);
  const setSpeed = useReducer(reducers.setSpeed);
  const [mult, setMult] = useState<number | null>(null); // null = follow the database
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
          <div className="progress-fill" style={{ width: `${Math.min(100, (t / max) * 100)}%` }} />
          {JUMPS.map((j) => (
            <i key={j.minutes} className="progress-mark" style={{ left: `${(j.minutes / max) * 100}%` }} />
          ))}
        </div>
        <div className="ticks">
          {ticks.map((h) => <span key={h}>{h === 0 ? 'Landfall' : `+${h}h`}</span>)}
        </div>
      </div>
      <span className="clock" title={replay ? `${replay.nextSeq.toLocaleString()} of ${replay.totalStaged.toLocaleString()} events released` : ''}>
        {fmtT(t)}
      </span>
      <div className="segmented speed" role="group" aria-label="Replay speed" title={`1× = ${REPLAY_SPEED} sim-minutes per second`}>
        {SPEED_MULTIPLIERS.map((m) => (
          <button key={m} className={Math.abs(shownMult - m) < 0.05 ? 'on' : ''} aria-pressed={Math.abs(shownMult - m) < 0.05} onClick={() => pickSpeed(m)} disabled={busy}>
            {m}×
          </button>
        ))}
      </div>
      <div className="jumps" role="group" aria-label="Jump to">
        {JUMPS.map((j) => (
          <button key={j.minutes} className="btn" onClick={run(() => jump({ minutes: j.minutes }))} disabled={busy}>{j.label}</button>
        ))}
      </div>
      <button className="btn ghost" onClick={run(() => reset())} disabled={busy}>Reset</button>
      {error && <span className="form-error small">{error}</span>}
      {replay?.running && <span className="muted small energy">Running uses Maincloud energy — pause when not demoing</span>}
    </footer>
  );
}
