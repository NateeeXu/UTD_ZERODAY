// Connection settings for the live screens. Only public values belong here:
// the staff passcode is typed into the join screen and never bundled.
export const HOST: string = import.meta.env.VITE_SPACETIME_HOST ?? 'https://maincloud.spacetimedb.com';

export type RegionId = 'harbor' | 'tx' | 'ca';

export interface RegionConfig {
  id: RegionId;
  label: string;
  db: string | null;              // live database (set an env var to '' to fall back to the preview)
  preview: 'tx' | 'ca' | null;    // read-only snapshot from docs/preview/preview-data.js, used only when db is empty
  dev?: boolean;                  // not in the top-bar switcher; reachable only with ?region=<id> in the URL
}

// Region → database. Override per region with env vars once Nate publishes them.
export const REGIONS: RegionConfig[] = [
  { id: 'tx', label: 'Corpus Christi', db: import.meta.env.VITE_SPACETIME_DB_TX ?? 'triage-loop-nateeexu-tx', preview: 'tx' },
  { id: 'ca', label: 'Bay Area', db: import.meta.env.VITE_SPACETIME_DB_CA ?? 'triage-loop-nateeexu-ca', preview: 'ca' },
  { id: 'harbor', label: 'Sandbox (dev)', db: import.meta.env.VITE_SPACETIME_DB ?? 'triage-loop-nateeexu-dev', preview: null, dev: true },
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
  const usable = (id: string | null) => REGIONS.find((r) => r.id === id && (r.db || r.preview));
  // A dev region opens only from an explicit ?region=; a remembered one falls back to the first public region.
  const remembered = usable(saved);
  return usable(fromUrl) ?? (remembered && !remembered.dev ? remembered : undefined) ?? REGIONS.find((r) => !r.dev && (r.db || r.preview))!;
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

// Phone hand-off from the manager's QR: #/adjuster?t=<identity token>. Before the app renders, the token
// becomes this device's adjuster identity for the region's database (so the phone opens already signed in
// as that adjuster) and is removed from the address bar. It sits after '#', so it never reaches the server.
export function consumeAdjusterHandoff(): void {
  const m = /^#\/adjuster\?(.+)$/.exec(window.location.hash);
  if (!m) return;
  const token = new URLSearchParams(m[1]).get('t');
  if (token) {
    const r = initialLiveRegion();
    try {
      if (r.db) localStorage.setItem(tokenKey('adjuster', r.db), token);
      rememberRegion(r.id);
    } catch {
      /* storage blocked: the phone will ask to join */
    }
  }
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/adjuster`);
}

// One token per screen and database, so one laptop can run manager + adjuster as two identities.
export const tokenKey = (screen: Screen, db: string) => `triage-token-${screen}-${db}`;

export const REPLAY_SPEED = 30; // sim minutes per real second (72 h in 2.4 min)
export const SPEED_MULTIPLIERS = [1, 1.2, 1.5, 2, 3]; // × REPLAY_SPEED (3× = 72 h in 48 s)
// Fast-forward with repeated step_replay(240) calls (docs/SPACETIME_API.md: a Bay Area jump_to(1440)
// takes ~4 s in one transaction; 4-hour steps take ~1 s each and the UI updates between them).
export const STEP_MIN = 240;
export const FAST_FORWARD = [
  { label: '+4 h', steps: 1 },
  { label: '+24 h', steps: 6 },
];
