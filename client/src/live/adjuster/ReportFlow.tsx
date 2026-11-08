// Field report (screen 3), report sent (screen 4) and "Can't make contact" (screen 5).
import { useEffect, useState, type ReactNode } from 'react';
import type { HexStatsRow, HouseholdFollowupRow, HouseholdRow } from '../rows';
import * as D from './derive';
import type { Draft, OutboxItem, PeoplePick, ReportMode, SentRecord } from './outbox';
import { Icon } from './icons';
import { fmtT } from '../../format';

const NOT_ASSESSED = 255;
const DAMAGE_NAMES = ['None', 'Minor', 'Severe', 'Uninhabitable'] as const;
const REASONS = ['Unsafe to enter', 'No access', 'Dark, no power'];
const QUICK = ['Trapped', 'Injured', 'Medical', 'Shelter'];
const WATCHDOG_MS = 30_000;

export interface ReportTarget {
  householdId: string;
  hex: string;
  assignmentId: string | null;
  label: string;
  type: D.TaskType;
  job: D.Job;
  policy: D.Policy;
  hazardType?: string;
  hh?: HouseholdRow;
  cell?: HexStatsRow;
}

// Demo build: never dials (docs/ADJUSTER_APP.md). A real deployment would use <a href="tel:911">.
function Call911({ className }: { className: string }) {
  const [tapped, setTapped] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setTapped(true)}>
        <Icon name="phone" size={19} stroke={2.2} />Call 911 now
      </button>
      {tapped && <span className="adj-notice" role="status">Demo only. No call placed.</span>}
    </>
  );
}

const PEOPLE: { v: PeoplePick; label: string }[] = [
  { v: 'safe', label: 'Safe' },
  { v: 'needs_help', label: 'Needs help' },
  { v: 'missing', label: 'Someone missing' },
  { v: 'nobody', label: 'Nobody seen' },
];

export function ReportScreen({ target, mode, prefill, item, live, onBack, onSend, onTryNow, onEdit }: {
  target: ReportTarget;
  mode: ReportMode;
  prefill?: Draft['form'];
  item?: OutboxItem;
  live: ReactNode;
  onBack: () => void;
  onSend: (d: Draft) => void;
  onTryNow: () => void;
  onEdit: () => void;
}) {
  const [pick, setPick] = useState<PeoplePick | null>(prefill?.pick ?? null);
  const [alsoMissing, setAlsoMissing] = useState(prefill?.alsoMissing ?? false);
  const [damageChoice, setDamageChoice] = useState<string | null>(prefill?.damageChoice ?? null);
  const [reason, setReason] = useState<string | null>(prefill?.reason ?? null);
  const [userNote, setUserNote] = useState(mode === 'correction' ? `Correction: ${prefill?.userNote ?? ''}` : mode === 'update' ? '' : '');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!item) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [item]);

  // A call, a resent text or an emergency-contact call can't see the house: it stays not assessed.
  const remote = D.isRemote(target.job);
  const covered = target.policy !== 'renters' && !remote;
  const na = covered && damageChoice === 'na';
  const homeOk = !covered || (na ? !!reason && userNote.trim().length >= 3 : damageChoice != null || target.type === 'Welfare check');
  const ready = pick != null && homeOk && !item;
  const gaps = covered && target.hh && damageChoice && damageChoice !== 'na' && damageChoice !== '0' ? D.coverageGaps(target.hh, target.hazardType) : [];
  const title = mode === 'update' ? 'Update' : mode === 'correction' ? 'Correction' : remote ? 'Report result' : 'Field report';

  const toggleQuick = (label: string) => {
    const tag = `${label}. `;
    setUserNote((n) => (n.includes(tag) ? n.replace(tag, '') : `${n}${tag}`.slice(0, 500)));
  };

  const send = () => {
    if (!ready || !pick) return;
    let damage: number;
    let prefix: string | null = null;
    if (remote) { damage = NOT_ASSESSED; prefix = `Not assessed: ${target.job.toLowerCase()}, no visit`; }
    else if (!covered) { damage = NOT_ASSESSED; prefix = "Not assessed: renter, building is the landlord's"; }
    else if (na) { damage = NOT_ASSESSED; prefix = `Not assessed: ${reason}`; }
    else if (damageChoice == null) { damage = NOT_ASSESSED; prefix = 'Not assessed: welfare check'; }
    else damage = Number(damageChoice);
    const note = [prefix, userNote.trim()].filter(Boolean).join('\n').slice(0, 500);
    onSend({
      householdId: target.householdId, hex: target.hex, assignmentId: target.assignmentId,
      safety: pick === 'safe' ? 'safe' : pick === 'needs_help' ? 'needs_help' : 'unsure',
      damage, note, memberMissing: pick === 'missing' || (pick === 'needs_help' && alsoMissing),
      rangeBefore: target.cell ? [target.cell.severeLo, target.cell.severeHi] : null,
      mode, form: { pick, alsoMissing, damageChoice, reason, userNote: userNote.trim() },
    });
  };

  // Life-safety reports (needs help, or someone missing) must not stall silently.
  const watchdog = !!item && (item.safety === 'needs_help' || item.memberMissing) && now - item.createdAt >= WATCHDOG_MS;

  return (
    <div className="adj-page">
      <header className="adj-topbar">
        <button type="button" className="adj-circle" aria-label={`Back to ${target.label}`} onClick={onBack}><Icon name="back" size={18} stroke={2.2} /></button>
        <div className="center"><strong>{title}</strong><span>{target.label}</span></div>
        {live}
      </header>

      <div className="adj-scroll">
        <section className="adj-sec" aria-label="People">
          <h2>People</h2>
          <div className="adj-grid2">
            {PEOPLE.map((o) => (
              <button key={o.v} type="button" className="adj-tile" aria-pressed={pick === o.v} onClick={() => setPick(o.v)}>{o.v === 'nobody' && remote ? 'No answer' : o.label}</button>
            ))}
          </div>
          {pick === 'needs_help' && (
            <div className="adj-danger">
              <p><b>Anyone in danger? Call 911 yourself.</b><br />This report is a referral, not a dispatch.</p>
              <Call911 className="adj-btn red" />
              <label className="adj-check">
                <input type="checkbox" checked={alsoMissing} onChange={(e) => setAlsoMissing(e.target.checked)} />
                Someone is also missing
              </label>
            </div>
          )}
          {pick === 'missing' && (
            <div className="adj-danger">
              <p><b>Someone missing? Call 911 to report it.</b><br />This report opens a referral, not a search.</p>
              <Call911 className="adj-btn red" />
            </div>
          )}
        </section>

        <section className="adj-sec" aria-label="Home">
          <div className="adj-sechead">
            <h2>{target.policy === 'condo' ? 'Unit' : 'Home'}{covered && target.type === 'Welfare check' && <span className="adj-muted" style={{ fontWeight: 500 }}> · optional</span>}</h2>
            <span className="adj-muted">{D.POLICY_LABEL[target.policy]}</span>
          </div>
          {covered ? (
            <>
              <div className="adj-grid2">
                {DAMAGE_NAMES.map((name, d) => (
                  <button key={d} type="button" className="adj-tile" aria-pressed={damageChoice === String(d)}
                    onClick={() => { setDamageChoice(damageChoice === String(d) ? null : String(d)); setReason(null); }}>{d} {name}</button>
                ))}
                <button type="button" className="adj-tile weak" aria-pressed={damageChoice === 'na'}
                  onClick={() => { setDamageChoice(damageChoice === 'na' ? null : 'na'); setReason(null); }}>Couldn't assess</button>
              </div>
              {na && (
                <div className="adj-chips">
                  {REASONS.map((r) => (
                    <button key={r} type="button" className="adj-chipbtn" aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>
                  ))}
                </div>
              )}
              {gaps.map((g) => <p key={g} className="adj-warn">{g}</p>)}
            </>
          ) : (
            remote
              ? <div className="adj-na"><b>Not assessed</b><span className="adj-muted">{target.job} · no visit</span></div>
              : <div className="adj-na"><b>Not applicable</b><span className="adj-muted">No home coverage</span></div>
          )}
        </section>

        <section className="adj-sec" aria-label="Note">
          <div className="adj-sechead"><h2>Note</h2><span className="adj-muted">{na ? 'Required' : 'Optional'}</span></div>
          <div className="adj-chips">
            {QUICK.map((q) => (
              <button key={q} type="button" className="adj-chipbtn" aria-pressed={userNote.includes(`${q}. `)} onClick={() => toggleQuick(q)}>{q}</button>
            ))}
          </div>
          <textarea className="adj-note" aria-label="Note" rows={2} maxLength={500} value={userNote}
            onChange={(e) => setUserNote(e.target.value)}
            placeholder={pick === 'missing' ? 'Who is missing? Last seen where?' : 'What you saw'} />
        </section>
      </div>

      <footer className="adj-pagefoot">
        {watchdog && (
          <div className="adj-watchdog" role="alert">
            <b>Not delivered — call 911</b>
            <Call911 className="adj-btn block" />
          </div>
        )}
        {!item && <button type="button" className="adj-btn dark block" disabled={!ready} onClick={send}>Send report</button>}
        {item?.state === 'sending' && (
          <button type="button" className="adj-btn dark block" disabled style={{ background: '#555' }}><span className="adj-spin" />Sending…</button>
        )}
        {item?.state === 'queued' && (
          <div className="adj-statebar queued" role="status">
            <span className="grow">Saved on phone · will send</span>
            <button type="button" className="adj-btn small" onClick={onTryNow}>Try now</button>
          </div>
        )}
        {item?.state === 'failed' && (
          <>
            <p className="adj-statebar failed" role="alert">Failed: {item.error ?? 'the server rejected the report'}</p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <button type="button" className="adj-link" onClick={onEdit}>Edit</button>
              <button type="button" className="adj-btn dark" style={{ height: 50, padding: '0 26px' }} onClick={onTryNow}>Try again</button>
            </div>
          </>
        )}
      </footer>
    </div>
  );
}

// ---- Screen 4: Report sent (only after the server has the report) ----
const REFERRAL: Record<string, string> = {
  '': 'Referral created', referred: 'Referred to 911 / local agency', acknowledged: 'Agency acknowledged', resolved: 'Resolved',
};

export interface NextInfo { label: string; priority: string; distance: string | null; onOpen: () => void }

export function SentSheet({ rec, cell, followup, reportT, next, nextOf, onUpdate, onCorrection, onAllTasks, onLocateFailed }: {
  rec: SentRecord;
  cell?: HexStatsRow;
  followup?: HouseholdFollowupRow;
  reportT: number;
  next: NextInfo | null;
  nextOf: string;
  onUpdate: () => void;
  onCorrection: () => void;
  onAllTasks: () => void;
  onLocateFailed: () => void;
}) {
  const pick = rec.form.pick;
  const urgent = pick === 'needs_help' || pick === 'missing';
  const head = pick === 'needs_help'
    ? { icon: 'red', mark: '!', title: 'Referral created' }
    : pick === 'missing'
      ? { icon: 'amber', mark: '!', title: 'Missing-member referral created' }
      : { icon: 'ok', mark: '', title: 'Report sent' };
  const sub = urgent ? 'Call 911 now if anyone is in danger' : "On the manager's map";
  const referral = REFERRAL[followup?.referralStatus ?? ''] ?? 'Referral created';

  const home = rec.damage < NOT_ASSESSED
    ? `${DAMAGE_NAMES[rec.damage] ?? rec.damage} · your report`
    : rec.note.startsWith('Not assessed: renter') ? 'Not assessed · renters policy' : 'House not inspected yet — will be re-assigned';

  let area: string | null = null;
  if (cell) {
    const after = D.fmtRange(cell.severeLo, cell.severeHi);
    const before = rec.rangeBefore ? D.fmtRange(rec.rangeBefore[0], rec.rangeBefore[1]) : null;
    area = before && before !== after ? `Severe in cell: ${before} → ${after}` : `Severe in cell: ${after} (no change)`;
  }

  return (
    <section className="adj-bottom" aria-label="Report sent">
      <span className="adj-grab" />
      <div className="adj-result">
        <span className={`icon ${head.icon}`}>{head.mark || <Icon name="check" size={22} stroke={2.6} />}</span>
        <div>
          <h1>{head.title}</h1>
          <span className="adj-sub">{fmtT(reportT)} · {sub}</span>
        </div>
      </div>

      <div className="adj-lines">
        <div className="adj-irow">
          <Icon name="person" />
          {pick === 'nobody' ? (
            <span className="grow"><b>Still unaccounted</b><br /><span className="adj-muted">Next: Locate (emergency contact, shelters)</span></span>
          ) : (
            <b className="grow">{pick === 'safe' ? 'Everyone accounted for' : pick === 'needs_help' ? 'Needs help' : 'Someone missing'}</b>
          )}
          {urgent && <span className="adj-tag red">{referral}</span>}
        </div>
        <div className="adj-irow"><Icon name="house" /><b className="grow">{home}</b></div>
        {area && <div className="adj-irow"><Icon name="hex" /><b className="grow" style={{ fontVariantNumeric: 'tabular-nums' }}>{area}</b></div>}
      </div>

      {pick === 'needs_help' && <button type="button" className="adj-btn dark block" onClick={onUpdate}>Add update</button>}
      {next ? (
        <button type="button" className={`adj-nextcard ${pick === 'needs_help' ? '' : 'dark'}`} onClick={next.onOpen}>
          <span className="adj-muted" style={{ color: pick === 'needs_help' ? undefined : 'rgba(255,255,255,0.75)' }}>{pick === 'needs_help' ? 'Next' : `Next up · ${nextOf}`}</span>
          <span className={`adj-p ${next.priority}`}>{next.priority}</span>
          <b className="grow">{next.label}</b>
          {next.distance && <span style={{ fontSize: 13.5, opacity: 0.75 }}>{next.distance}</span>}
          <Icon name="chevron" size={18} stroke={2} />
        </button>
      ) : (
        <div className="adj-nextcard" style={{ cursor: 'default' }}><b className="grow">All tasks done</b></div>
      )}
      <div className="adj-links">
        <button type="button" className="adj-link small" onClick={onAllTasks}>All tasks</button>
        <button type="button" className="adj-link small" onClick={onCorrection}>Send correction</button>
        {pick === 'nobody' && <button type="button" className="adj-link small" onClick={onLocateFailed}>Locate failed? Close home</button>}
      </div>
    </section>
  );
}

// ---- Screen 5: Can't make contact ----
type CloseReason = 'skip' | 'vacant' | 'not_in_area' | 'unreachable_after_visit';

export function CloseSheet({ canUnreachable, canSkip, onCancel, onSkip, onCloseHome }: {
  canUnreachable: boolean;
  canSkip: boolean;
  onCancel: () => void;
  onSkip: () => Promise<void>;
  onCloseHome: (reason: string, note: string) => Promise<void>;
}) {
  const [reason, setReason] = useState<CloseReason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skip = reason === 'skip';
  const ok = reason != null && (skip || note.trim().length >= 3) && !busy;
  const options: { v: CloseReason; label: string; hint?: string; disabled?: boolean }[] = [
    ...(canSkip ? [{ v: 'skip' as const, label: "Can't get there" }] : []),
    { v: 'vacant', label: 'Vacant' },
    { v: 'not_in_area', label: 'Not in the area' },
    { v: 'unreachable_after_visit', label: 'Unreachable after visit', hint: canUnreachable ? undefined : 'After a "Nobody seen" report', disabled: !canUnreachable },
  ];

  const submit = async () => {
    if (!ok || !reason) return;
    setBusy(true);
    setError(null);
    try {
      if (skip) await onSkip();
      else await onCloseHome(reason, note.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <div className="adj-dim" onClick={onCancel} />
      <section className="adj-bottom" role="dialog" aria-label="Can't make contact">
        <span className="adj-grab" />
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em' }}>Can't make contact</h1>
        <div role="radiogroup" aria-label="Reason" style={{ borderTop: '1px solid var(--line)' }}>
          {options.map((o) => (
            <button key={o.v} type="button" role="radio" className="adj-radio" aria-checked={reason === o.v} disabled={o.disabled} onClick={() => setReason(o.v)}>
              <span className="label">{o.label}{o.hint && <span>{o.hint}</span>}</span>
              <i />
            </button>
          ))}
        </div>
        {!skip && (
          <textarea className="adj-note" aria-label="Note, required" rows={2} maxLength={500} value={note}
            onChange={(e) => setNote(e.target.value)} placeholder="Note (required): why?" />
        )}
        {error && <p className="adj-error" role="alert">{error}</p>}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button type="button" className="adj-link" onClick={onCancel}>Cancel</button>
          <button type="button" className="adj-btn dark" style={{ height: 50, padding: '0 26px' }} disabled={!ok} onClick={submit}>
            {busy ? 'Saving…' : skip ? 'Skip task' : 'Close home'}
          </button>
        </div>
      </section>
    </>
  );
}
