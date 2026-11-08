import type { Damage, Household, Priority, SimEvent } from '@shared/types';

export const PRIORITY_COLOR: Record<Priority, string> = {
  P0: '#DC2626',
  P1: '#F59E0B',
  P2: '#9CA3AF',
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  P0: 'act now',
  P1: 'inspect',
  P2: 'monitor',
};

export const DAMAGE_LABEL: Record<Damage, string> = {
  0: 'No damage',
  1: 'Minor',
  2: 'Severe',
  3: 'Uninhabitable',
};

export function fmtT(t: number): string {
  const m = Math.max(0, Math.round(t));
  const h = Math.floor(m / 60);
  return `T+${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function fmtAgo(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;

const STREETS = [
  'Bayou', 'Pelican', 'Magnolia', 'Seawall', 'Cypress', 'Harbor', 'Gulfview', 'Live Oak',
  'Marsh', 'Lighthouse', 'Pecan', 'Tidewater', 'Heron', 'Saltgrass', 'Driftwood', 'Oyster Bay',
];
const SUFFIX = ['St', 'Ave', 'Dr', 'Ln', 'Ct', 'Rd'];

// Synthetic street address derived from the household id (stable across reloads).
export function addressOf(h: Pick<Household, 'id'>): string {
  const n = parseInt(h.id.replace(/\D/g, ''), 10) || 0;
  const num = 100 + ((n * 37) % 8900);
  return `${num} ${STREETS[n % STREETS.length]} ${SUFFIX[(n >> 4) % SUFFIX.length]}`;
}

export function describeEvent(e: SimEvent): string {
  switch (e.kind) {
    case 'sms_sent':
      return 'Check-in SMS sent';
    case 'sms_reply':
      return `SMS reply: ${e.safety === 'safe' ? 'SAFE' : 'HELP'} · damage ${e.damage}`;
    case 'claim':
      return `Claim filed: ${e.peril} · damage ${e.reportedDamage}`;
    case 'field_report':
      return `Field report (${e.adjusterId}): ${e.safety.replace('_', ' ')} · ${DAMAGE_LABEL[e.damage]}`;
  }
}
