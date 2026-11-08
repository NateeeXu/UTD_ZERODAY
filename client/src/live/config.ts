// Connection settings for the live screens. Only public values belong here:
// the staff passcode is typed into the join screen and never bundled.
export const HOST: string = import.meta.env.VITE_SPACETIME_HOST ?? 'https://maincloud.spacetimedb.com';

export type RegionId = 'harbor' | 'tx' | 'ca';

export interface RegionConfig {
  id: RegionId;
  label: string;
  db: string | null;              // live database (set an env var to '' to fall back to the preview)
  preview: 'tx' | 'ca' | null;    // read-only snapshot from docs/preview/preview-data.js, used only when db is empty
}

// Region → database. Override per region with env vars once Nate publishes them.
export const REGIONS: RegionConfig[] = [
  { id: 'tx', label: 'Corpus Christi', db: import.meta.env.VITE_SPACETIME_DB_TX ?? 'triage-loop-nateeexu-tx', preview: 'tx' },
  { id: 'ca', label: 'Bay Area', db: import.meta.env.VITE_SPACETIME_DB_CA ?? 'triage-loop-nateeexu-ca', preview: 'ca' },
  { id: 'harbor', label: 'Harbor Bend (dev)', db: import.meta.env.VITE_SPACETIME_DB ?? 'triage-loop-nateeexu-dev', preview: null },
];

const REGION_KEY = 'triage-region';

export function initialRegion(): RegionConfig {
  const fromUrl = new URLSearchParams(window.location.search).get('region');
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(REGION_KEY);
  } catch {
    /* storage blocked */
  }
  const want = fromUrl ?? saved;
  return REGIONS.find((r) => r.id === want && (r.db || r.preview)) ?? REGIONS.find((r) => r.db || r.preview)!;
}

// Phone screens need a live database: fall back to the first region that has one.
export function initialLiveRegion(): RegionConfig {
  const r = initialRegion();
  return r.db ? r : REGIONS.find((x) => x.db)!;
}

export function rememberRegion(id: RegionId) {
  try {
    localStorage.setItem(REGION_KEY, id);
  } catch {
    /* storage blocked */
  }
}

export type Screen = 'manager' | 'adjuster' | 'reply';

// One token per screen and database, so one laptop can run manager + adjuster as two identities.
export const tokenKey = (screen: Screen, db: string) => `triage-token-${screen}-${db}`;

export const REPLAY_SPEED = 30; // sim minutes per real second (72 h in 2.4 min)
export const JUMPS = [
  { label: '2 h', minutes: 120 },
  { label: '6 h', minutes: 360 },
  { label: '24 h', minutes: 1440 },
];
