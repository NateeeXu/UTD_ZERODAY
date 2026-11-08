// Property side of the dashboard: how many homes are severely damaged, as a range, and how that
// range narrows as calls, visits and inspections arrive (docs/SPACETIME_API.md "Uncertainty on the map",
// docs/DATA.md section 8). All numbers come from the simulation.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MetricsRow } from './rows';
import { pct } from '../format';

type Point = { t: number; w: number };

// metrics is a single row, so the width history is collected while this page is open.
// A rewind (reset / jump back) starts a new history.
function useWidthHistory(metrics: MetricsRow | undefined, simMinutes: number): Point[] {
  const [points, setPoints] = useState<Point[]>([]);
  const w = metrics?.severeIntervalWidth;
  useEffect(() => {
    if (w == null) return;
    setPoints((prev) => {
      const last = prev[prev.length - 1];
      if (last && simMinutes < last.t - 1) return [{ t: simMinutes, w }];
      if (last && Math.abs(last.t - simMinutes) < 1) return [...prev.slice(0, -1), { t: last.t, w }];
      return [...prev, { t: simMinutes, w }];
    });
  }, [w, simMinutes]);
  return points;
}

export function SevereCard({ metrics, simMinutes, maxMinutes }: { metrics: MetricsRow | undefined; simMinutes: number; maxMinutes: number }) {
  const points = useWidthHistory(metrics, simMinutes);
  if (!metrics) return null;
  const lo = Math.round(metrics.severeTotalLo);
  const hi = Math.round(metrics.severeTotalHi);
  const coverage = metrics.intervalCellsLive > 0 ? metrics.intervalCoverageLive : null;
  return (
    <section className="glass severe-card" aria-label="Severely damaged homes">
      <span className="p1-label">Severely damaged homes</span>
      <div className="sev-line">
        <span className="sev-num">~{Math.round(metrics.expectedSevereTotal).toLocaleString()}</span>
        <span className="muted">range {lo.toLocaleString()}–{hi.toLocaleString()}</span>
      </div>
      <WidthChart points={points} maxMinutes={maxMinutes} />
      <div
        className={`sev-cov${coverage != null && coverage < 0.8 ? ' low' : ''}`}
        title="Share of areas whose range contains the simulated true count. A 90% range should hold about 90% of the time."
      >
        <span>Range check</span>
        <b>{coverage == null ? '—' : pct(coverage)}</b>
        <span className="muted">of areas · target ~90%</span>
      </div>
    </section>
  );
}

const W = 268;
const H = 74;
const PAD = { l: 4, r: 4, t: 8, b: 16 };

// One series: range width over sim time, x fixed to the replay horizon so the fall is visible.
function WidthChart({ points, maxMinutes }: { points: Point[]; maxMinutes: number }) {
  const [hover, setHover] = useState<Point | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const yMax = useMemo(() => Math.max(1, ...points.map((p) => p.w)) * 1.08, [points]);
  const x = (t: number) => PAD.l + (t / maxMinutes) * (W - PAD.l - PAD.r);
  const y = (w: number) => PAD.t + (1 - w / yMax) * (H - PAD.t - PAD.b);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.w).toFixed(1)}`).join('');
  const last = points[points.length - 1];

  const onMove = (e: React.PointerEvent) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r || !points.length) return;
    const t = ((e.clientX - r.left) / r.width * W - PAD.l) / (W - PAD.l - PAD.r) * maxMinutes;
    setHover(points.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a)));
  };

  return (
    <figure className="sev-chart">
      <figcaption className="small muted">Range width (homes) over time</figcaption>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
        aria-label={last ? `Range width now ${Math.round(last.w)} homes` : 'Range width chart, waiting for data'}
        onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} className="sev-axis" />
        {[24, 48].filter((h) => h * 60 < maxMinutes).map((h) => (
          <line key={h} x1={x(h * 60)} x2={x(h * 60)} y1={PAD.t} y2={H - PAD.b} className="sev-grid" />
        ))}
        {[0, 24, 48, 72].filter((h) => h * 60 <= maxMinutes).map((h) => (
          <text key={h} x={x(h * 60)} y={H - 3} className="sev-tick" textAnchor={h === 0 ? 'start' : h * 60 >= maxMinutes ? 'end' : 'middle'}>{h === 0 ? '0 h' : `${h} h`}</text>
        ))}
        {points.length > 1 && <path d={path} className="sev-path" />}
        {last && <circle cx={x(last.t)} cy={y(last.w)} r={4} className="sev-dot" />}
        {last && !hover && (
          <text x={Math.min(x(last.t) + 6, W - 40)} y={Math.max(y(last.w) - 6, 10)} className="sev-label">{Math.round(last.w).toLocaleString()}</text>
        )}
        {hover && (
          <g>
            <line x1={x(hover.t)} x2={x(hover.t)} y1={PAD.t} y2={H - PAD.b} className="sev-cross" />
            <circle cx={x(hover.t)} cy={y(hover.w)} r={4} className="sev-dot" />
          </g>
        )}
      </svg>
      {hover && (
        <div className="sev-tip" style={{ left: `${(x(hover.t) / W) * 100}%` }}>
          <b>{Math.round(hover.w).toLocaleString()}</b> homes wide · T+{Math.floor(hover.t / 60)}h
        </div>
      )}
    </figure>
  );
}
