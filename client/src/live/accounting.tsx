// "No one overlooked": the unaccounted card (P1), escalation chips, risk flags and the
// family-reunification note. See docs/SPACETIME_API.md section 0b.
import type { FacilityRow, HexStatsRow, HouseholdRow, MetricsRow } from './rows';
import { pct } from '../format';

export const fmtHM = (minutes: number) => {
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};

export function AccountingCard({ metrics }: { metrics: MetricsRow | undefined }) {
  const unaccounted = metrics?.unaccounted ?? 0;
  const rate = metrics?.accountedRate ?? 0;
  const vRate = metrics?.vulnerableAccountedRate ?? 0;
  // Lagging = vulnerable households are being heard from more slowly than everyone else.
  const lagging = !!metrics && metrics.accounted > 0 && vRate < rate - 0.005;
  const overdue = metrics?.overdueReferrals ?? 0;
  return (
    <section className="glass p1" aria-label={`Unaccounted: ${unaccounted} households`}>
      <span className="p1-label">Unaccounted</span>
      <div className="p1-line">
        <span className="p1-num">{unaccounted.toLocaleString()}</span>
        <span className="p1-unit">households · goal 0</span>
      </div>
      <div className="p1-track">
        <div className="p1-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(rate * 100)}>
          <div style={{ width: `${Math.min(100, rate * 100)}%` }} />
        </div>
        <span>{pct(rate)} accounted for</span>
      </div>

      <div className="p1-stats">
        <Stat label="Longest wait · high-risk" value={metrics ? fmtHM(metrics.longestWaitMin) : '—'} />
        <Stat label="High-risk unaccounted" value={(metrics?.highRiskUnaccounted ?? 0).toLocaleString()} />
        <Stat label="Recheck due" value={(metrics?.recheckDue ?? 0).toLocaleString()} />
        <Stat label="Overdue referrals" value={overdue.toLocaleString()} danger={overdue > 0} />
      </div>

      <div className="p1-equity">
        <Rate label="Everyone" value={rate} />
        <Rate label="Vulnerable" value={vRate} warn={lagging} />
      </div>
      {lagging && <span className="p1-lag">Lagging · vulnerable residents go first</span>}
    </section>
  );
}

function Stat({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className={`p1-stat${danger ? ' danger' : ''}`}>
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
  agent_call: { label: 'Agent to call', tone: 'blue' },
  field_visit: { label: 'Send adjuster', tone: 'muted' },
  recheck: { label: 'Recheck', tone: 'amber' },
  emergency_referral: { label: 'Refer to 911', tone: 'red' },
  referral_pending: { label: 'Referred', tone: 'amber' },
  referral_acknowledged: { label: 'Acknowledged', tone: 'blue' },
  referral_overdue: { label: 'Overdue', tone: 'red' },
  accounted: { label: 'Accounted', tone: 'green' },
  verified: { label: 'Verified', tone: 'green' },
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
