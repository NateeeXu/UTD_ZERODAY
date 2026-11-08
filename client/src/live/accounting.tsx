// "No one overlooked": the unaccounted card (P1), escalation chips, risk flags and the
// family-reunification note. See docs/SPACETIME_API.md section 0b.
import { useState } from 'react';
import type { FacilityRow, HexStatsRow, HouseholdRow, MetricsRow } from './rows';
import { pct } from '../format';
import './accounting.css';

// Collapsed by default; the choice is remembered in this browser (a viewer convenience only).
const OPEN_KEY = 'triage-accounting-open';
const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
};
const saveOpen = (open: boolean) => {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    /* storage blocked: per page load only */
  }
};

export const fmtHM = (minutes: number) => {
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};

// A duration with its unit, so it never reads as a clock time: "40 min", "3 h 25 min", "72 h".
export const fmtWait = (minutes: number) => {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  return r ? `${h} h ${r} min` : `${h} h`;
};

// P1 card: people first. Hero = unaccounted (goal 0) with both accounted rates beside it, then the
// people stats, then the three request queues (911 referrals, customer care, inspection).
export function AccountingCard({ metrics }: { metrics: MetricsRow | undefined }) {
  const unaccounted = metrics?.unaccounted ?? 0;
  const rate = metrics?.accountedRate ?? 0;
  const vRate = metrics?.vulnerableAccountedRate ?? 0;
  // Lagging = vulnerable households are being heard from more slowly than everyone else.
  const lagging = !!metrics && metrics.accounted > 0 && vRate < rate - 0.005;
  const overdue = metrics?.overdueReferrals ?? 0;
  const n = (v: number | undefined) => (metrics ? (v ?? 0).toLocaleString() : '—');
  const [open, setOpen] = useState(readOpen);
  const toggle = () => setOpen((o) => { saveOpen(!o); return !o; });
  const referrals = (
    <Stat
      label={overdue > 0 ? `911 / agency · ${overdue} overdue` : '911 / agency referrals'}
      title="Life-safety reports referred to 911 / the local agency (State Farm refers, the agency responds)"
      value={n(metrics?.openReferrals)}
      danger={overdue > 0}
    />
  );
  const highRisk = <Stat label="High-risk unaccounted" value={n(metrics?.highRiskUnaccounted)} />;
  const longestWait = <Stat label="Longest wait · high-risk" value={metrics ? fmtWait(metrics.longestWaitMin) : '—'} />;
  return (
    <section className={`glass p1${open ? '' : ' p1-collapsed'}`} aria-label={`Unaccounted: ${unaccounted} households`}>
      <div className="p1-head">
        <span className="p1-label">Unaccounted</span>
        <button type="button" className="p1-toggle" aria-expanded={open} aria-controls="p1-details" onClick={toggle}>
          {open ? 'Show less' : 'All stats'}
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      <div className="p1-hero">
        <div className="p1-line">
          <span className="p1-num">{n(unaccounted)}</span>
          <span className="p1-unit">households · goal 0</span>
        </div>
        <div className="p1-equity">
          <Rate label="Everyone" value={rate} />
          <Rate label="Vulnerable" value={vRate} warn={lagging} />
        </div>
      </div>
      {open ? (
        <div id="p1-details" className="p1-details">
          {lagging && <span className="p1-lag">Vulnerable residents lagging · they go first in the queue</span>}
          <div className="p1-stats">
            {/* Unaccounted split by the carrier's delivery receipt (households without a phone are in neither). */}
            <Stat label="Text not delivered" title="Not heard from, and the check-in text was not delivered (phone off, dead or out of signal)" value={n(metrics?.undeliveredUnaccounted)} />
            <Stat label="Delivered · no reply" title="Not heard from, although the check-in text was delivered" value={n(metrics?.deliveredNoReply)} />
            {highRisk}
            {longestWait}
            <Stat label="To locate" title="House inspected, nobody seen: emergency contact next" value={n(metrics?.locateDue)} />
            <Stat label="Recheck due" title="Vulnerable, last contact over 24 h ago" value={n(metrics?.recheckDue)} />
          </div>
          <div className="p1-requests">
            {referrals}
            <Stat label="Customer care" title="Asked for shelter, medication, water or a ride" value={n(metrics?.assistanceRequests)} />
            <Stat label="Inspection requests" title="Asked for an adjuster to look at the home" value={n(metrics?.inspectionRequests)} />
          </div>
        </div>
      ) : (
        // Collapsed: the three numbers that need action first.
        <div className="p1-requests p1-key">
          {referrals}
          {highRisk}
          {longestWait}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, danger = false, title }: { label: string; value: string; danger?: boolean; title?: string }) {
  return (
    <div className={`p1-stat${danger ? ' danger' : ''}`} title={title}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function Rate({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={`p1-rate${warn ? ' warn' : ''}`}>
      <div className="p1-rate-head"><span>{label}</span><b>{pct(value)}</b></div>
      <div className="p1-rate-bar"><div style={{ width: `${Math.min(100, value * 100)}%` }} /></div>
    </div>
  );
}

// Escalation ladder → chip text and tone (docs/SPACETIME_API.md 0b).
export const ESCALATION: Record<string, { label: string; tone: 'muted' | 'amber' | 'blue' | 'red' | 'green' }> = {
  sms_sent: { label: 'Text sent', tone: 'muted' },
  sms_resend: { label: 'Resend text', tone: 'amber' },
  agent_call: { label: 'Agent call', tone: 'blue' },
  field_visit: { label: 'Visit', tone: 'muted' },
  locate: { label: 'Locate', tone: 'amber' },
  recheck: { label: 'Recheck', tone: 'amber' },
  emergency_referral: { label: 'Refer to 911', tone: 'red' },
  referral_pending: { label: 'Referred', tone: 'amber' },
  referral_acknowledged: { label: 'Acknowledged', tone: 'blue' },
  referral_overdue: { label: 'Overdue', tone: 'red' },
  assistance: { label: 'Customer care', tone: 'blue' },
  inspection_request: { label: 'Inspection requested', tone: 'blue' },
  accounted: { label: 'Accounted', tone: 'green' },
  verified: { label: 'Inspected', tone: 'green' },
  closed: { label: 'Closed', tone: 'muted' },
};

export function EscalationChip({ step }: { step: string }) {
  const e = ESCALATION[step] ?? { label: step || '—', tone: 'muted' as const };
  return <span className={`esc esc-${e.tone}`}>{e.label}</span>;
}

export function riskFlags(h: HouseholdRow | undefined): string[] {
  if (!h) return [];
  const f: string[] = [];
  if (h.age75) f.push('75+');
  else if (h.age65 && h.livesAlone) f.push('65+');
  if (h.livesAlone) f.push('lives alone');
  if (h.medicalDevice) f.push('medical device');
  if (h.disability) f.push('disability');
  if (h.noVehicle) f.push('no vehicle');
  if (h.limitedEnglish) f.push(`limited English${h.primaryLanguage ? ` (${h.primaryLanguage})` : ''}`);
  return f;
}

// Family reunification: school-age kids whose nearest school sits in a high-hazard cell during school hours.
export function makeKidsNote(facilities: readonly FacilityRow[], cellBy: Map<string, HexStatsRow>, schoolHours: boolean) {
  const byId = new Map(facilities.map((f) => [f.id, f]));
  return (h: HouseholdRow | undefined): string | null => {
    if (!h || !schoolHours || !(h.schoolAgeChildren && h.schoolAgeChildren > 0) || !h.nearestSchoolId) return null;
    const school = byId.get(h.nearestSchoolId);
    if (!school) return null;
    const cell = cellBy.get(school.hex);
    if (!cell || cell.hazard < 0.5) return null;
    return `Kids may be at ${school.name} · send reunification info`;
  };
}
