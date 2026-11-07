// Local mode data source: replays the EventBundle in the browser and lets the
// adjuster / SMS views inject events. Tabs in the same browser stay in sync via
// BroadcastChannel. When Spacetime is ready, replace this provider with one
// backed by subscriptions; views only depend on the TriageState interface.
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import type { EventBundle, HexId, Household, HouseholdEstimate, ModelParams, SimEvent } from '@shared/types';
import { loadData, type LoadedData } from '../data/loadBundle';
import { DEFAULT_TRUST, estimate, type HexView } from '../engine/placeholderEstimate';
import { aggregateAreas, buildAreas, type Area, type AreaView } from '../areas';

export const T_END = 72 * 60; // simulator horizon: 72 h after landfall
export const SPEEDS = [30, 120, 480] as const; // sim-minutes per real second

export interface Metrics {
  verifiedCoverage: number; // share of P0/P1 hexes that are verified
  heldOutBrier: number | null; // Brier score of pSevere on holdout households
  sourceTrust: { hazard: number; sms: number; claims: number };
}

export interface TriageState {
  ready: boolean;
  source: LoadedData['source'] | null;
  bundle: EventBundle | null;
  householdById: Map<string, Household>;
  t: number;
  playing: boolean;
  speed: number;
  visibleEvents: SimEvent[];
  injected: SimEvent[];
  hexViews: HexView[];
  hexById: Map<HexId, HexView>;
  householdEstimates: Map<string, HouseholdEstimate>;
  areas: Area[];
  areaOfHex: Map<HexId, Area>;
  areaViews: AreaView[];
  assignments: Record<string, string>; // areaId -> adjusterId (local only until Spacetime `assignment`)
  metrics: Metrics;
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  setSpeed: (s: number) => void;
  reset: () => void;
  inject: (e: SimEvent) => void;
  assign: (areaId: string, adjusterId: string | null) => void;
}

const Ctx = createContext<TriageState | null>(null);
const CHANNEL = 'triage-loop';
const INJECTED_KEY = 'triage-loop:injected';
const ASSIGN_KEY = 'triage-loop:assignments';

type Msg =
  | { type: 'clock'; t: number; playing: boolean; speed: number }
  | { type: 'inject'; event: SimEvent }
  | { type: 'assign'; assignments: Record<string, string> }
  | { type: 'reset' }
  | { type: 'hello' };

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable: state just won't survive reload */
  }
}

export function TriageProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<LoadedData | null>(null);
  // ?t=<minutes> opens the replay at a given moment (demo deep links, screenshots).
  const [t, setT] = useState(() => Math.min(T_END, Math.max(0, Number(new URLSearchParams(window.location.search).get('t')) || 0)));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState<number>(SPEEDS[1]);
  const [injected, setInjected] = useState<SimEvent[]>(() => readJson(INJECTED_KEY, []));
  const [assignments, setAssignments] = useState<Record<string, string>>(() => readJson(ASSIGN_KEY, {}));

  const clockRef = useRef({ t, playing, speed });
  clockRef.current = { t, playing, speed };
  const leader = useRef(false); // this tab drives the clock for the others
  const chan = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    loadData().then(setData);
  }, []);

  const post = useCallback((m: Msg) => chan.current?.postMessage(m), []);
  const broadcastClock = useCallback(
    (next: Partial<{ t: number; playing: boolean; speed: number }>) => {
      leader.current = true;
      post({ type: 'clock', ...clockRef.current, ...next });
    },
    [post],
  );

  useEffect(() => {
    const ch = new BroadcastChannel(CHANNEL);
    chan.current = ch;
    ch.onmessage = (ev: MessageEvent<Msg>) => {
      const m = ev.data;
      if (m.type === 'clock') {
        leader.current = false;
        setT(m.t);
        setPlaying(m.playing);
        setSpeedState(m.speed);
      } else if (m.type === 'inject') {
        setInjected((xs) => [...xs, m.event]);
      } else if (m.type === 'assign') {
        setAssignments(m.assignments);
      } else if (m.type === 'reset') {
        setInjected([]);
        setAssignments({});
        setT(0);
        setPlaying(false);
      } else if (m.type === 'hello' && leader.current) {
        ch.postMessage({ type: 'clock', ...clockRef.current } satisfies Msg);
      }
    };
    ch.postMessage({ type: 'hello' } satisfies Msg);
    return () => ch.close();
  }, []);

  useEffect(() => writeJson(INJECTED_KEY, injected), [injected]);
  useEffect(() => writeJson(ASSIGN_KEY, assignments), [assignments]);

  // Advance the clock while playing; the leader re-broadcasts once a second.
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let lastBroadcast = last;
    const id = setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      setT((cur) => {
        const next = Math.min(T_END, cur + dt * clockRef.current.speed);
        if (next >= T_END) setPlaying(false);
        return next;
      });
      if (leader.current && now - lastBroadcast > 1000) {
        lastBroadcast = now;
        post({ type: 'clock', ...clockRef.current });
      }
    }, 100);
    return () => clearInterval(id);
  }, [playing, post]);

  const bundle = data?.bundle ?? null;

  // Events are sorted by t, so the visible prefix is just an index.
  const cutoff = useMemo(() => {
    if (!bundle) return 0;
    const ev = bundle.events;
    let lo = 0;
    let hi = ev.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ev[mid].t <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }, [bundle, t]);

  const visibleEvents = useMemo(() => {
    if (!bundle) return [];
    const base = bundle.events.slice(0, cutoff);
    return injected.length ? [...base, ...injected].sort((a, b) => a.t - b.t) : base;
  }, [bundle, cutoff, injected]);

  // Re-estimate only when the visible events change (or every ~30 sim-minutes
  // for time-dependent terms like silence and expected claims).
  const tBucket = Math.floor(t / 30);
  const model: ModelParams | null = data?.model ?? null;
  const est = useMemo(
    () => (bundle ? estimate(bundle.world, visibleEvents, tBucket * 30, model) : { households: new Map(), hexes: [] }),
    [bundle, visibleEvents, tBucket, model],
  );
  const hexById = useMemo(() => new Map(est.hexes.map((h) => [h.hex, h])), [est]);

  const { areas, areaOfHex } = useMemo(
    () => (bundle ? buildAreas(bundle.world) : { areas: [] as Area[], areaOfHex: new Map<HexId, Area>() }),
    [bundle],
  );
  const areaViews = useMemo(() => aggregateAreas(areas, hexById), [areas, hexById]);

  const householdById = useMemo(
    () => new Map((bundle?.world.households ?? []).map((h) => [h.id, h])),
    [bundle],
  );

  const metrics = useMemo<Metrics>(() => {
    const urgent = est.hexes.filter((h) => h.priority !== 'P2');
    const verifiedCoverage = urgent.length
      ? urgent.filter((h) => h.verification === 'verified').length / urgent.length
      : 1;
    let heldOutBrier: number | null = null;
    if (bundle?.truth.length) {
      const truth = new Map(bundle.truth.map((r) => [r.householdId, r]));
      let sum = 0;
      let n = 0;
      for (const hh of bundle.world.households) {
        if (!hh.holdout) continue;
        const e = est.households.get(hh.id);
        const r = truth.get(hh.id);
        if (!e || !r) continue;
        sum += (e.pSevere - (r.damage >= 2 ? 1 : 0)) ** 2;
        n++;
      }
      heldOutBrier = n ? sum / n : null;
    }
    return { verifiedCoverage, heldOutBrier, sourceTrust: model?.sourceTrust ?? DEFAULT_TRUST };
  }, [est, bundle, model]);

  const value: TriageState = {
    ready: !!data,
    source: data?.source ?? null,
    bundle,
    householdById,
    t,
    playing,
    speed,
    visibleEvents,
    injected,
    hexViews: est.hexes,
    hexById,
    householdEstimates: est.households,
    areas,
    areaOfHex,
    areaViews,
    assignments,
    metrics,
    play: () => {
      const from = clockRef.current.t >= T_END ? 0 : clockRef.current.t;
      setT(from);
      setPlaying(true);
      broadcastClock({ t: from, playing: true });
    },
    pause: () => {
      setPlaying(false);
      broadcastClock({ playing: false });
    },
    seek: (nt) => {
      setT(nt);
      broadcastClock({ t: nt });
    },
    setSpeed: (s) => {
      setSpeedState(s);
      broadcastClock({ speed: s });
    },
    reset: () => {
      setInjected([]);
      setAssignments({});
      setT(0);
      setPlaying(false);
      post({ type: 'reset' });
    },
    inject: (e) => {
      setInjected((xs) => [...xs, e]);
      post({ type: 'inject', event: e });
    },
    assign: (areaId, adjusterId) => {
      const next = { ...assignments };
      if (adjusterId) next[areaId] = adjusterId;
      else delete next[areaId];
      setAssignments(next);
      post({ type: 'assign', assignments: next });
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTriage(): TriageState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTriage must be used inside TriageProvider');
  return v;
}
