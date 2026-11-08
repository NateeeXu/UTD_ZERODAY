import { useMemo, useState, type ReactNode } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings/index.ts';
import { ConnectionBadge, LiveProvider } from './LiveProvider';
import { initialLiveRegion } from './config';
import { JoinDialog, useAutoRejoin } from './JoinDialog';
import { makeLabeler } from './labels';
import { useEstimatesById, useHouseholdsById } from './hooks';
import { makeKidsNote } from './accounting';
import { cellSetKey, prio, RANK } from './mapModel';
import type { HouseholdRow } from './rows';
import { CloseHousehold, DAMAGE, PeopleProperty, contactHistory } from './household';
import { directionsUrl, fmtT, homeLabel, pct } from '../format';

const NOT_ASSESSED = 255; // submit_field_report: house not assessed (needs a note saying why)

export function AdjusterLive() {
  const region = useMemo(initialLiveRegion, []);
  return (
    <LiveProvider screen="adjuster" db={region.db!}>
      <AdjusterScreen />
    </LiveProvider>
  );
}

type Safety = 'safe' | 'needs_help' | 'unsure';
// close_household reasons (CLOSURES): unreachable_after_visit requires an assignment first (backend rule).

function AdjusterScreen() {
  const [myMember, memberReady] = useTable(tables.myMember);
  const [mine] = useTable(tables.myAssignments);
  const [cells] = useTable(tables.hexStats);
  const [candidates] = useTable(tables.inspectionCandidate);
  const [worldRows] = useTable(tables.world);
  const [replayRows] = useTable(tables.replayState);
  const [facilities] = useTable(tables.facility);
  const me = myMember[0];
  const db = useMemo(() => initialLiveRegion().db ?? undefined, []);
  const rejoining = useAutoRejoin('adjuster', db, !!me, memberReady);
  const [openId, setOpenId] = useState<string | null>(null);

  const assignedIdsAll = useMemo(() => mine.map((a) => a.householdId), [mine]);
  const estimateBy = useEstimatesById(assignedIdsAll);
  const cellBy = useMemo(() => new Map(cells.map((c) => [c.hex, c])), [cells]);
  const kidsNote = useMemo(() => makeKidsNote(facilities, cellBy, !!worldRows[0]?.schoolHours), [facilities, cellBy, worldRows]);
  const fictional = worldRows[0] ? !worldRows[0].region : false;
  const cellKey = useMemo(() => cellSetKey(cells), [cells]);
  const labeler = useMemo(() => makeLabeler(cells.map((c) => c.hex), fictional), [cellKey, fictional]); // eslint-disable-line react-hooks/exhaustive-deps

  const assigned = useMemo(
    () => [...mine].filter((a) => a.status !== 'cancelled').sort((a, b) => Number(a.status !== 'assigned') - Number(b.status !== 'assigned') || (estimateBy.get(b.householdId)?.inspectScore ?? 0) - (estimateBy.get(a.householdId)?.inspectScore ?? 0)),
    [mine, estimateBy],
  );
  const assignedIds = new Set(assigned.map((a) => a.householdId));
  const suggestions = useMemo(
    () => [...candidates]
      .filter((c) => !assignedIds.has(c.householdId) && c.cellPriority !== 'P2')
      .sort((a, b) => RANK[prio(a.cellPriority)] - RANK[prio(b.cellPriority)] || b.inspectScore - a.inspectScore)
      .slice(0, 10),
    [candidates, assigned.length], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Household rows only for my assignments and the open card (the full table is 20–30k rows on the real
  // regions). Suggested rows render from inspection_candidate, so they stay out of this query: keyed on the
  // top 10 it re-subscribed on every replay tick, a newly listed home never loaded and an open card closed.
  const householdBy = useHouseholdsById(useMemo(() => (openId ? [...assignedIdsAll, openId] : assignedIdsAll), [assignedIdsAll, openId]));

  if (!me || me.role !== 'adjuster') {
    return (
      <div className="phone">
        <header className="phone-top"><strong>Field tasks</strong><ConnectionBadge /></header>
        <p className="muted pad">{rejoining ? 'Rejoining as adjuster…' : 'Join as an adjuster to see your assigned homes.'}</p>
        {!rejoining && <JoinDialog role="adjuster" db={db} onDone={() => undefined} />}
      </div>
    );
  }

  const open = openId ? householdBy.get(openId) : undefined;
  if (open) return <HouseholdCard hh={open} area={labeler.cell(open.hex)} fictional={fictional} kids={kidsNote(open)} onDone={() => setOpenId(null)} />;
  if (openId) {
    return (
      <div className="phone">
        <header className="phone-top"><button className="link muted back" onClick={() => setOpenId(null)}>← Tasks</button><ConnectionBadge /></header>
        <p className="muted pad">Loading home…</p>
      </div>
    );
  }

  const open_ = assigned.filter((a) => a.status === 'assigned').length;
  return (
    <div className="phone">
      <header className="phone-top">
        <div><strong>Field tasks</strong><span className="muted small"> · {me.name} · {fmtT(replayRows[0]?.simMinutes ?? 0)}</span></div>
        <ConnectionBadge />
      </header>
      <p className="muted small phone-sub">{open_} open · {assigned.length - open_} done</p>
      <ul className="task-list">
        {assigned.map((a) => {
          const hh = householdBy.get(a.householdId);
          const cell = cellBy.get(a.hex);
          const est = estimateBy.get(a.householdId);
          return (
            <li key={String(a.id)}>
              <button className="task" onClick={() => setOpenId(a.householdId)} disabled={!hh}>
                <span className={`chip chip-${prio(cell?.priority ?? 'P2')}`}>{prio(cell?.priority ?? 'P2')}</span>
                <span className="task-main">
                  <b>{homeLabel(a.householdId, fictional)}</b>
                  <span className="muted small">{labeler.cell(a.hex)}</span>
                  <span className="small">{a.status === 'done' ? 'Reported ✓' : `help ${pct(est?.pNeedsHelp ?? 0)} · severe ${pct(est?.pSevere ?? 0)}`}{hh ? flags(hh) : ''}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {!assigned.length && <p className="muted small pad">No assignments yet. The manager assigns inspections from the dashboard.</p>}
      {suggestions.length > 0 && (
        <>
          <h3 className="eyebrow pad">Not assigned · top homes to inspect</h3>
          <ul className="task-list">
            {suggestions.map((c) => (
              <li key={c.householdId}>
                <button className="task" onClick={() => setOpenId(c.householdId)}>
                  <span className={`chip chip-${prio(c.cellPriority)}`} style={{ opacity: c.cellVerification === 'needs_verification' ? 0.55 : 1 }}>{prio(c.cellPriority)}</span>
                  <span className="task-main">
                    <b>{homeLabel(c.householdId, fictional)}</b>
                    <span className="muted small">{labeler.cell(c.hex)}</span>
                    <span className="small">help {pct(c.pNeedsHelp)} · severe {pct(c.pSevere)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function flags(h: HouseholdRow): string {
  const f: string[] = [];
  if (h.age75) f.push('75+');
  else if (h.age65) f.push('65+');
  if (h.medicalDevice) f.push('medical device');
  if (h.livesAlone) f.push('lives alone');
  return f.length ? ` · ${f.join(' · ')}` : '';
}

function HouseholdCard({ hh, area, fictional, kids, onDone }: { hh: HouseholdRow; area: string; fictional: boolean; kids: string | null; onDone: () => void }) {
  const [replies] = useTable(tables.smsReply.where((r) => r.householdId.eq(hh.id)));
  const [claims] = useTable(tables.claim.where((r) => r.householdId.eq(hh.id)));
  const [reports] = useTable(tables.fieldReport.where((r) => r.householdId.eq(hh.id)));
  const submit = useReducer(reducers.submitFieldReport);
  const [followRows] = useTable(tables.householdFollowup.where((r) => r.householdId.eq(hh.id)));
  const est = useEstimatesById(useMemo(() => [hh.id], [hh.id])).get(hh.id);
  const signals = { est, replies, reports, claims, followup: followRows[0] };
  const [safety, setSafety] = useState<Safety | null>(null);
  const [damage, setDamage] = useState<number | null>(null);
  const [memberMissing, setMemberMissing] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const history = contactHistory(signals);
  const noteRequired = damage === NOT_ASSESSED;
  const noteOk = !noteRequired || note.trim().length >= 3;

  const send = async () => {
    if (safety == null || damage == null || !noteOk) return;
    setBusy(true);
    setError(null);
    try {
      // memberMissing opens the missing-member referral on the backend (no separate report_member_missing).
      await submit({ householdId: hh.id, safety, damage, note: note.trim().slice(0, 500), memberMissing });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const renter = (hh.policyType ?? '').toLowerCase().includes('rent');
  return (
    <div className="phone">
      <div className="card">
        <button className="link muted back" onClick={onDone}>← Tasks</button>
        <h2>{homeLabel(hh.id, fictional)}</h2>
        <div className="hh-where">
          <p className="muted small">{area}</p>
          <a className="btn small-btn" href={directionsUrl(hh.lat, hh.lng)} target="_blank" rel="noreferrer">Directions ↗</a>
        </div>
        {kids && <p className="kids-banner">{kids}</p>}
        <PeopleProperty {...signals} />
        <div className="tags">
          <Tag on={hh.windCovered}>Wind</Tag>
          <Tag on={hh.floodPolicy}>Flood policy</Tag>
          <Tag on={hh.earthquakeEndorsement}>Earthquake</Tag>
          {renter && <span className="tag on">Renter</span>}
          {hh.age75 ? <span className="tag alert">75+</span> : hh.age65 && <span className="tag alert">65+</span>}
          {hh.livesAlone && <span className="tag alert">Lives alone</span>}
          {hh.medicalDevice && <span className="tag alert">Medical device</span>}
          {hh.disability && <span className="tag alert">Disability</span>}
          {hh.noVehicle && <span className="tag alert">No vehicle</span>}
          {hh.limitedEnglish && <span className="tag alert">Limited English{hh.primaryLanguage ? ` · ${hh.primaryLanguage}` : ''}</span>}
          {hh.mobileHome && <span className="tag alert">Mobile home</span>}
        </div>

        <h3>Contact history</h3>
        {history.length ? (
          <ul className="history">{history.map((h, i) => <li key={i}><span className="muted">{fmtT(h.t)}</span> {h.text}</li>)}</ul>
        ) : (
          <p className="muted small">{hh.phoneOnFile ? 'Texted, no reply yet.' : 'No phone on file.'}</p>
        )}

        <h3>1 · People</h3>
        <p className="small muted">"Nobody seen" = house inspected, people not found. They stay unaccounted and move to locate (emergency contact).</p>
        <div className="seg">
          {(['safe', 'needs_help', 'unsure'] as Safety[]).map((v) => (
            <button key={v} className={safety === v ? 'on' : ''} aria-pressed={safety === v} onClick={() => setSafety(v)}>
              {v === 'safe' ? 'Safe' : v === 'needs_help' ? 'Needs help' : 'Nobody seen'}
            </button>
          ))}
        </div>
        <label className="check small member-missing">
          <input type="checkbox" checked={memberMissing} onChange={(e) => setMemberMissing(e.target.checked)} />
          <span>A household member is missing: referred to 911 / local agencies</span>
        </label>

        <h3>2 · Home</h3>
        <div className="seg">
          {DAMAGE.map((label, d) => (
            <button key={d} className={damage === d ? 'on' : ''} aria-pressed={damage === d} onClick={() => setDamage(d)}>{label}</button>
          ))}
          <button className={damage === NOT_ASSESSED ? 'on' : ''} aria-pressed={damage === NOT_ASSESSED} onClick={() => setDamage(NOT_ASSESSED)}
            title="People checked, house not assessed (dark, unsafe, no access). The house stays uninspected.">Can't assess</button>
        </div>

        <label className="field note">
          <span>{noteRequired ? 'Note (required: why the house could not be assessed)' : 'Note (optional)'}</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2}
            placeholder={noteRequired ? 'e.g. unsafe to enter, no access: flooded' : undefined} />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn primary block" disabled={safety == null || damage == null || !noteOk || busy} onClick={send}>
          {busy ? 'Sending…' : 'Submit field report'}
        </button>

        <h3>Can't make contact?</h3>
        <p className="small muted">Close without contact, with a documented reason.</p>
        <CloseHousehold householdId={hh.id} followup={followRows[0]} reports={reports} />
      </div>
    </div>
  );
}

function Tag({ on, children }: { on: boolean; children: ReactNode }) {
  return <span className={`tag ${on ? 'on' : 'off'}`}>{on ? '✓' : '✗'} {children}</span>;
}
