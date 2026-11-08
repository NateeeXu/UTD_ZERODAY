import { useMemo, useState } from 'react';
import type { Household, SimEvent } from '@shared/types';
import type { AreaView } from '../areas';
import { useTriage } from '../state/TriageStore';
import { DAMAGE_LABEL, fmtAgo, homeLabel, pct } from '../format';
import { Chip, ZONE_LABEL, areaHazard } from './bits';
import { CELL_STATUS_LABEL, cellStatus } from '../cellStatus';

const ADJUSTERS = ['adj-01', 'adj-02', 'adj-03'];

interface Row {
  hh: Household;
  rank: number;
  status: string;
  help: boolean;
  pHelp: number;
}

export function statusOf(hh: Household, evs: SimEvent[], t: number): { rank: number; status: string; help: boolean } {
  let sent: SimEvent | undefined;
  let reply: Extract<SimEvent, { kind: 'sms_reply' }> | undefined;
  let claim: Extract<SimEvent, { kind: 'claim' }> | undefined;
  let field: Extract<SimEvent, { kind: 'field_report' }> | undefined;
  for (const e of evs) {
    if (e.kind === 'sms_sent') sent = e;
    else if (e.kind === 'sms_reply') reply = e;
    else if (e.kind === 'claim') claim = e;
    else field = e;
  }
  if (field?.safety === 'needs_help') return { rank: 0, status: 'Field · needs help', help: true };
  if (reply?.safety === 'needs_help') return { rank: 1, status: 'HELP', help: true };
  if (field) return { rank: 2, status: `Field · ${field.damage == null ? 'house not assessed' : DAMAGE_LABEL[field.damage].toLowerCase()}, ${field.safety.replace('_', ' ')}`, help: false };
  if (sent && !reply && !claim) return { rank: 3, status: `No reply · ${fmtAgo(t - sent.t).replace(' ago', '')}`, help: false };
  if (claim) return { rank: 4, status: `Claim · ${claim.peril}, ${DAMAGE_LABEL[claim.reportedDamage].toLowerCase()}`, help: false };
  if (reply) return { rank: 5, status: `SAFE · damage ${reply.damage}`, help: false };
  if (!hh.phoneOnFile) return { rank: 3, status: 'No phone on file', help: false };
  return { rank: 6, status: 'Not texted yet', help: false };
}

function tagsOf(hh: Household): string {
  const t: string[] = [];
  if (hh.age65) t.push('65+');
  if (hh.livesAlone) t.push('lives alone');
  if (hh.medicalDevice) t.push('medical device');
  t.push(hh.floodPolicy ? 'flood policy' : 'no flood policy');
  return t.join(' · ');
}

export function AreaDetail({ view, onClose }: { view: AreaView; onClose: () => void }) {
  const s = useTriage();
  const [showAll, setShowAll] = useState(false);
  const [adj, setAdj] = useState(ADJUSTERS[0]);
  const hz = useMemo(() => (s.bundle ? areaHazard(s.bundle.world, view.area) : null), [s.bundle, view.area]);

  const rows = useMemo<Row[]>(() => {
    const hexes = new Set(view.area.hexes);
    const hhs = [...s.householdById.values()].filter((h) => hexes.has(h.hex));
    const byHh = new Map<string, SimEvent[]>();
    for (const e of s.visibleEvents) {
      const list = byHh.get(e.householdId);
      if (list) list.push(e);
      else byHh.set(e.householdId, [e]);
    }
    return hhs
      .map((hh) => ({
        hh,
        ...statusOf(hh, byHh.get(hh.id) ?? [], s.t),
        pHelp: s.householdEstimates.get(hh.id)?.pNeedsHelp ?? 0,
      }))
      .sort((a, b) => a.rank - b.rank || b.pHelp - a.pHelp);
  }, [view.area, s.householdById, s.visibleEvents, s.householdEstimates, s.t]);

  const lastUpdate = useMemo(() => {
    const hexes = new Set(view.area.hexes);
    for (let i = s.visibleEvents.length - 1; i >= 0; i--) {
      const e = s.visibleEvents[i];
      if (e.kind !== 'sms_sent' && hexes.has(s.householdById.get(e.householdId)?.hex ?? '')) return e.t;
    }
    return null;
  }, [view.area, s.visibleEvents, s.householdById]);

  const assigned = s.assignments[view.area.id];
  const shown = showAll ? rows : rows.slice(0, 6);
  const severeShare = view.households ? view.expectedSevere / view.households : 0;
  const claimRatio = view.expectedClaims >= 0.5 ? Math.min(1, view.claims / view.expectedClaims) : view.claims > 0 ? 1 : 0;

  return (
    <aside className="card detail">
      <div className="detail-head">
        <div className="detail-nav">
          <button className="link muted" onClick={onClose}>← Next up</button>
          <button className="link muted close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="detail-title">
          <Chip priority={view.priority} verification={view.verification} />
          <h2>{view.area.name}</h2>
          <span className={`pill status-${cellStatus(view.fieldReports, view.verification)}`}>{CELL_STATUS_LABEL[cellStatus(view.fieldReports, view.verification)]}</span>
        </div>
        <span className="muted">
          {view.households} homes · {view.fieldReports} field report{view.fieldReports === 1 ? '' : 's'}
          {lastUpdate != null && ` · updated ${fmtAgo(s.t - lastUpdate)}`}
        </span>
      </div>

      <div className="detail-body">
        <h3 className="eyebrow">Why {view.priority}</h3>
        <div className="signals">
          <Signal name="Hazard" trust={`trust ${pct(s.metrics.sourceTrust.hazard)}`} value={view.hazard}>
            {hz && <>Wind {hz.maxWind} mph · flood {hz.maxFlood.toFixed(1)} ft · analyst zone: {ZONE_LABEL[hz.maxZone]}</>}
          </Signal>
          <Signal name="Check-ins" trust={`trust ${pct(s.metrics.sourceTrust.sms)}`} value={view.smsSent ? view.smsReplies / view.smsSent : 0}>
            {view.smsReplies} of {view.smsSent} replied
            {view.helpReplies > 0 && <> · <b className="danger-text">{view.helpReplies} asked for help</b></>}
          </Signal>
          <Signal name="Claims" trust={`trust ${pct(s.metrics.sourceTrust.claims)}`} value={claimRatio}>
            {view.claims} filed vs {view.expectedClaims.toFixed(0)} expected by now
          </Signal>
          <Signal name="Field" trust="ground truth" value={null}>
            {view.fieldReports ? `${view.fieldReports} report${view.fieldReports > 1 ? 's' : ''} from adjusters` : 'No field reports yet'}
          </Signal>
          <div className="readout">
            <span><b>{pct(severeShare)}</b>severe damage</span>
            <span><b>{pct(view.maxPNeedsHelp)}</b>someone needs help</span>
            <span><b>{pct(view.confidence)}</b>confidence</span>
          </div>
        </div>

        <h3 className="eyebrow divider">Households</h3>
        <ul className="hh-list">
          {shown.map((r) => (
            <li key={r.hh.id}>
              <span className="hh-main">
                <b>{homeLabel(r.hh.id)}</b>
                <span className="muted small">{tagsOf(r.hh)}</span>
              </span>
              {r.help ? <span className="help-tag">{r.status}</span> : <span className="small hh-status">{r.status}</span>}
            </li>
          ))}
        </ul>
        {rows.length > 6 && (
          <button className="link muted more" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `${rows.length - 6} more homes`}
          </button>
        )}
      </div>

      <div className="detail-actions">
        {assigned ? (
          <>
            <span className="assigned">Assigned to <b>{assigned}</b></span>
            <button className="btn" onClick={() => s.assign(view.area.id, null)}>Unassign</button>
          </>
        ) : (
          <>
            <select className="btn" value={adj} onChange={(e) => setAdj(e.target.value)} aria-label="Adjuster">
              {ADJUSTERS.map((a) => <option key={a}>{a}</option>)}
            </select>
            <button className="btn primary grow" onClick={() => s.assign(view.area.id, adj)}>Assign adjuster</button>
          </>
        )}
      </div>
    </aside>
  );
}

function Signal({ name, trust, value, children }: { name: string; trust: string; value: number | null; children: React.ReactNode }) {
  return (
    <div className="signal">
      <div className="signal-head"><b>{name}</b><span className="muted small">{trust}</span></div>
      {value != null && (
        <div className="meter" role="img" aria-label={`${name} ${pct(value)}`}>
          <div style={{ width: `${Math.round(value * 100)}%` }} />
        </div>
      )}
      <span className="muted small">{children}</span>
    </div>
  );
}
