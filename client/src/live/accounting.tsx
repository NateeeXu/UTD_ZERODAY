// "No one overlooked": hero KPI, equity strip, escalation chips, risk flags and the
// family-reunification note. See docs/SPACETIME_API.md section 0b.
import type { FacilityRow, HexStatsRow, HouseholdRow, MetricsRow } from './rows';
import { pct } from '../format';

export function AccountingBar({ metrics }: { metrics: MetricsRow | undefined }) {
  const unaccounted = metrics?.unaccounted ?? 0;
  const rate = metrics?.accountedRate ?? 0;
  const vRate = metrics?.vulnerableAccountedRate ?? 0;
  // Lagging = vulnerable households are being heard from more slowly than everyone else.
  const lagging = !!metrics && metrics.accounted > 0 && vRate < rate - 0.005;
  return (
    <div className="kpi">
      <div className="hero" aria-label={`Unaccounted: ${unaccounted} households`}>
        <span className="hero-label">Unaccounted</span>
        <span className="hero-line">
          <span className="hero-num">{unaccounted.toLocaleString()}</span>
          <span className="hero-unit">households</span>
        </span>
        <div className="hero-track">
          <div className="hero-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(rate * 100)}>
            <div style={{ width: `${Math.min(100, rate * 100)}%` }} />
          </div>
          <span className="hero-sub">{pct(rate)} accounted for · goal 100%</span>
        </div>
      </div>
      <div className="equity">
        <EquityBar label="Everyone" value={rate} />
        <EquityBar label="Vulnerable households" value={vRate} warn={lagging} />
        {lagging && <span className="equity-warn">Vulnerable residents are lagging — prioritized first</span>}
      </div>
    </div>
  );
}

function EquityBar({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={`eq-row${warn ? ' warn' : ''}`}>
      <span className="eq-label">{label}</span>
      <div className="eq-bar"><div style={{ width: `${Math.min(100, value * 100)}%` }} /></div>
      <b className="eq-val">{pct(value)}</b>
    </div>
  );
}

// Escalation ladder → chip text and tone. `field_visit` is rendered as a button by the caller.
export const ESCALATION: Record<string, { label: string; tone: 'muted' | 'amber' | 'blue' | 'red' | 'green' }> = {
  sms_sent: { label: 'Text sent', tone: 'muted' },
  sms_resend: { label: 'Resend text', tone: 'amber' },
  agent_call: { label: 'Agent to call', tone: 'blue' },
  field_visit: { label: 'Send adjuster', tone: 'muted' },
  emergency_referral: { label: 'Refer to 911', tone: 'red' },
  accounted: { label: 'Accounted', tone: 'green' },
  verified: { label: 'Verified', tone: 'green' },
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
