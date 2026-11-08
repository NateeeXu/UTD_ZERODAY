import { useState } from 'react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../module_bindings/index.ts';
import type { ReplayStateRow } from './rows';
import { JUMPS, REPLAY_SPEED } from './config';
import { fmtT } from '../format';

// Bottom bar: replay clock from `replay_state`, manager-only controls.
export function ReplayBar({ replay, canControl, onNeedJoin }: { replay: ReplayStateRow | undefined; canControl: boolean; onNeedJoin: () => void }) {
  const start = useReducer(reducers.startReplay);
  const pause = useReducer(reducers.pauseReplay);
  const jump = useReducer(reducers.jumpTo);
  const reset = useReducer(reducers.resetDemo);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const max = replay?.maxMinutes || 4320;
  const t = replay?.simMinutes ?? 0;
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
        <button className="btn primary" onClick={run(() => start({ speed: REPLAY_SPEED }))} disabled={busy}>
          {t > 0 && t < max ? 'Resume' : 'Start'}
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
