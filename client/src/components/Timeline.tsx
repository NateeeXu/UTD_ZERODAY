import { useMemo } from 'react';
import { SPEEDS, T_END, useTriage } from '../state/TriageStore';
import { fmtT } from '../format';

const HOURS = T_END / 60;

// Bottom bar: play/pause, hourly event histogram that doubles as the scrubber.
export function Timeline() {
  const s = useTriage();
  const bins = useMemo(() => {
    const b = new Array<number>(HOURS).fill(0);
    for (const e of s.bundle?.events ?? []) {
      if (e.kind === 'sms_sent') continue; // outbound texts would dwarf everything else
      const i = Math.min(HOURS - 1, Math.floor(e.t / 60));
      b[i]++;
    }
    const max = Math.max(1, ...b);
    return b.map((v) => v / max);
  }, [s.bundle]);
  const nowBin = s.t / 60;

  return (
    <footer className="timeline">
      {s.playing ? (
        <button className="btn primary" onClick={s.pause}>Pause</button>
      ) : (
        <button className="btn primary" onClick={s.play}>{s.t > 0 && s.t < T_END ? 'Resume' : 'Start'}</button>
      )}
      <div className="timeline-track">
        <div className="bars" aria-hidden>
          {bins.map((v, i) => (
            <div key={i} className={i < nowBin ? 'bar past' : 'bar'} style={{ height: `${4 + v * 32}px` }} />
          ))}
        </div>
        <input
          className="scrub"
          type="range"
          min={0}
          max={T_END}
          step={10}
          value={s.t}
          onChange={(e) => s.seek(Number(e.target.value))}
          aria-label="Replay time"
        />
        <div className="ticks">
          <span>Landfall</span><span>+12h</span><span>+24h</span><span>+36h</span><span>+48h</span><span>+60h</span><span>+72h</span>
        </div>
      </div>
      <span className="clock">{fmtT(s.t)}</span>
      <select className="btn" value={s.speed} onChange={(e) => s.setSpeed(Number(e.target.value))} aria-label="Replay speed">
        {SPEEDS.map((sp) => (
          <option key={sp} value={sp}>{sp >= 60 ? `${sp / 60} h/s` : `${sp} min/s`}</option>
        ))}
      </select>
      <button className="btn ghost" onClick={s.reset}>Reset</button>
    </footer>
  );
}
