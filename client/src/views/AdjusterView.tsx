import { useMemo, useState, type ReactNode } from 'react';
import type { Damage, Household, Safety, SimEvent } from '@shared/types';
import { useTriage } from '../state/TriageStore';
import { DAMAGE_LABEL, describeEvent, fmtT, homeLabel } from '../format';
import { statusOf } from '../components/AreaDetail';
import { Chip } from '../components/bits';

const ADJUSTERS = ['adj-01', 'adj-02', 'adj-03'];
const ADJ_KEY = 'triage-loop:adjuster';

export function AdjusterView() {
  const s = useTriage();
  const [adjusterId, setAdjusterId] = useState(() => localStorage.getItem(ADJ_KEY) ?? ADJUSTERS[0]);
  const [openId, setOpenId] = useState<string | null>(null);

  const hexById = s.hexById;
  const myAreas = useMemo(
    () => new Set(Object.entries(s.assignments).filter(([, a]) => a === adjusterId).map(([id]) => id)),
    [s.assignments, adjusterId],
  );

  // Tasks: households in P0/P1 hexes without a field report. Areas the manager
  // assigned to this adjuster come first, then priority, then P(needs help).
  const tasks = useMemo(() => {
    const evsByHh = new Map<string, SimEvent[]>();
    for (const e of s.visibleEvents) {
      const list = evsByHh.get(e.householdId);
      if (list) list.push(e);
      else evsByHh.set(e.householdId, [e]);
    }
    const out: { hh: Household; pHelp: number; mine: boolean; rank: number; status: string; help: boolean }[] = [];
    for (const hh of s.householdById.values()) {
      const hex = hexById.get(hh.hex);
      const est = s.householdEstimates.get(hh.id);
      if (!hex || !est || est.verified || hex.priority === 'P2') continue;
      const mine = myAreas.has(s.areaOfHex.get(hh.hex)?.id ?? '');
      out.push({ hh, pHelp: est.pNeedsHelp, mine, ...statusOf(hh, evsByHh.get(hh.id) ?? [], s.t) });
    }
    return out
      .sort((a, b) => {
        const pa = hexById.get(a.hh.hex)!.priority;
        const pb = hexById.get(b.hh.hex)!.priority;
        return Number(b.mine) - Number(a.mine) || pa.localeCompare(pb) || a.rank - b.rank || b.pHelp - a.pHelp;
      })
      .slice(0, 25);
  }, [s.householdById, s.householdEstimates, s.visibleEvents, s.t, hexById, myAreas, s.areaOfHex]);

  const done = useMemo(
    () => s.visibleEvents.filter((e) => e.kind === 'field_report' && e.adjusterId === adjusterId).length,
    [s.visibleEvents, adjusterId],
  );

  if (!s.bundle) return <div className="loading">Loading…</div>;
  const open = openId ? s.householdById.get(openId) ?? null : null;

  return (
    <div className="phone">
      <header className="phone-top">
        <div>
          <strong>Field tasks</strong>
          <span className="muted"> · {fmtT(s.t)}</span>
        </div>
        <select
          value={adjusterId}
          onChange={(e) => {
            setAdjusterId(e.target.value);
            localStorage.setItem(ADJ_KEY, e.target.value);
          }}
          aria-label="Adjuster"
        >
          {ADJUSTERS.map((a) => <option key={a}>{a}</option>)}
        </select>
      </header>

      {open ? (
        <HouseholdCard
          hh={open}
          adjusterId={adjusterId}
          onDone={() => setOpenId(null)}
        />
      ) : (
        <>
          <p className="muted phone-sub">{tasks.length} open · {done} reported by you</p>
          {tasks.length === 0 && <p className="muted empty">No open tasks. Start the replay on the manager screen.</p>}
          <ul className="task-list">
            {tasks.map(({ hh, mine, status, help }) => {
              const hex = hexById.get(hh.hex)!;
              return (
                <li key={hh.id}>
                  <button className="task" onClick={() => setOpenId(hh.id)}>
                    <Chip priority={hex.priority} verification={hex.verification} />
                    <span className="task-main">
                      <b>{homeLabel(hh.id)}</b>
                      <span className="muted small">
                        {s.areaOfHex.get(hh.hex)?.name}{mine && ' · assigned to you'}
                      </span>
                      <span className="small">
                        {help ? <span className="help-tag">{status}</span> : status}
                        <span className="muted">
                          {hh.medicalDevice && ' · medical device'}
                          {hh.age65 && ' · 65+'}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function HouseholdCard({ hh, adjusterId, onDone }: { hh: Household; adjusterId: string; onDone: () => void }) {
  const s = useTriage();
  const [safety, setSafety] = useState<Safety | null>(null);
  const [damage, setDamage] = useState<Damage | null>(null);
  const history = s.visibleEvents.filter((e) => e.householdId === hh.id);

  const submit = () => {
    if (safety == null || damage == null) return;
    const e: SimEvent = { kind: 'field_report', t: s.t, householdId: hh.id, adjusterId, safety, damage };
    s.inject(e);
    onDone();
  };

  return (
    <div className="card">
      <button className="link muted back" onClick={onDone}>← Tasks</button>
      <h2>{homeLabel(hh.id)}</h2>
      <p className="muted small">{s.areaOfHex.get(hh.hex)?.name}</p>
      <div className="tags">
        <Tag on={hh.windCovered}>Wind</Tag>
        <Tag on={hh.floodPolicy}>Flood policy</Tag>
        <Tag on={hh.earthquakeEndorsement}>Earthquake</Tag>
        {hh.age65 && <span className="tag alert">65+</span>}
        {hh.livesAlone && <span className="tag alert">Lives alone</span>}
        {hh.medicalDevice && <span className="tag alert">Medical device</span>}
      </div>

      <h3>Contact history</h3>
      {history.length === 0 ? (
        <p className="muted">{hh.phoneOnFile ? 'No contact yet.' : 'No phone on file.'}</p>
      ) : (
        <ul className="history">
          {history.map((e, i) => (
            <li key={i}><span className="muted">{fmtT(e.t)}</span> {describeEvent(e)}</li>
          ))}
        </ul>
      )}

      <h3>Personal safety</h3>
      <div className="seg">
        {(['safe', 'needs_help', 'unsure'] as Safety[]).map((v) => (
          <button key={v} className={safety === v ? 'on' : ''} onClick={() => setSafety(v)}>
            {v === 'safe' ? 'Safe' : v === 'needs_help' ? 'Needs help' : 'Unsure'}
          </button>
        ))}
      </div>

      <h3>Property damage</h3>
      <div className="seg">
        {([0, 1, 2, 3] as Damage[]).map((d) => (
          <button key={d} className={damage === d ? 'on' : ''} onClick={() => setDamage(d)}>
            {d} · {DAMAGE_LABEL[d]}
          </button>
        ))}
      </div>

      <button className="btn primary block" disabled={safety == null || damage == null} onClick={submit}>
        Submit field report
      </button>
    </div>
  );
}

function Tag({ on, children }: { on: boolean; children: ReactNode }) {
  return <span className={`tag ${on ? 'on' : 'off'}`}>{on ? '✓' : '✗'} {children}</span>;
}
