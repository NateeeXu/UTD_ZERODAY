import type { Damage, Priority, SimEvent } from '@shared/types';

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

// No street addresses anywhere (not even invented ones): a home is its household number plus its area.
// Directions open the phone's map app at the household's coordinates.
export function directionsUrl(lat: number, lng: number): string {
  const ll = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const ua = navigator.userAgent;
  const ios = /iP(hone|ad|od)/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  return ios ? `https://maps.apple.com/?daddr=${ll}&dirflg=d` : `https://www.google.com/maps/dir/?api=1&destination=${ll}`;
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
      return `Field report (${e.adjusterId}): ${e.safety.replace('_', ' ')} · ${e.damage == null ? 'house not assessed' : DAMAGE_LABEL[e.damage]}`;
  }
}

// The household number, e.g. "Home #000013" for tx-celia-type-direct-hit-h000013. Same for the fictional
// town and real geography (the second argument is kept so call sites stay unchanged).
export function homeLabel(id: string, _fictional?: boolean): string {
  const digits = id.match(/(\d+)$/)?.[1];
  return digits ? `Home #${digits}` : `Home ${id}`;
}
