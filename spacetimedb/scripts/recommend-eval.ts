// Is the adjuster "Next best" ranking better than the simple alternatives? Simulation only.
//
//   node scripts/recommend-eval.ts --db triage-loop-tx [--adjusters 5] [--hours 8] [--seed 7]
//
// Reads one snapshot from a local database and greedily simulates a shift for three policies on the same
// static task pool: N adjusters start at spread-out points (k-means++ on the pool, fixed seed); whoever is
// free first takes its next task, drives, works it and moves there; a taken task is gone for the others.
// An adjuster whose next task cannot be finished before the shift ends stops there.
//
// Pool: unaccounted_queue rows with escalation = 'field_visit' (welfare) + inspection_candidate rows; a
// household in both stays welfare, as in rankCandidates.
//
// Limits: synthetic households, nothing arrives or resolves during the shift, distance is straight line
// times a road factor, and every visit takes the same service time.
import { connect, DB, errText, HOST, subscribe } from './lib.ts';
import { haversineKm, rankCandidates, REC, tierOf, valueOf } from '../src/recommend-rank.ts';
import type { Candidate, LatLng } from '../src/recommend-rank.ts';

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const ADJUSTERS = Number(arg('--adjusters') ?? 5);
const HOURS = Number(arg('--hours') ?? 8);
const SEED = Number(arg('--seed') ?? 7);

type Policy = (pool: readonly Candidate[], from: LatLng, nowMin: number, taken: ReadonlySet<string>) => Candidate | undefined;

const byId = (a: Candidate, b: Candidate) => (a.householdId < b.householdId ? -1 : 1);

/**
 * Tier, then the outreach queue score, distance ignored. The queue only defines a score for welfare rows;
 * an inspection is scored by what it is worth to Next best (it has no wait to age).
 */
function queueScore(c: Candidate, nowMin: number): number {
  if (c.kind === 'inspection') return valueOf(c, nowMin);
  return c.weight * (1 + Math.max(0, nowMin - c.waitSinceMin) / REC.agingMin);
}

const queueOrder: Policy = (pool, _from, nowMin, taken) => {
  let best: Candidate | undefined;
  for (const c of pool) {
    if (taken.has(c.householdId)) continue;
    if (!best) {
      best = c;
      continue;
    }
    const diff = tierOf(c.priority) - tierOf(best.priority) || queueScore(best, nowMin) - queueScore(c, nowMin) || byId(c, best);
    if (diff < 0) best = c;
  }
  return best;
};

const nearestFirst: Policy = (pool, from, _nowMin, taken) => {
  let best: Candidate | undefined;
  let bestKm = Infinity;
  for (const c of pool) {
    if (taken.has(c.householdId)) continue;
    const km = haversineKm(from, c);
    if (km < bestKm || (km === bestKm && best && byId(c, best) < 0)) {
      best = c;
      bestKm = km;
    }
  }
  return best;
};

const nextBest: Policy = (pool, from, nowMin, taken) => {
  const top = rankCandidates(pool, from, nowMin, taken)[0];
  return top && pool.find(c => c.householdId === top.householdId);
};

interface Visit {
  task: Candidate;
  reachedMin: number;
  roadKm: number;
}

function simulate(snapshot: readonly Candidate[], starts: readonly LatLng[], snapshotMin: number, shiftMin: number, pick: Policy): Visit[] {
  const pool = snapshot.map(c => ({ ...c })); // a visit verifies its cell, so later inspection values drop
  const crew = starts.map(pos => ({ pos, freeAt: 0, onShift: true }));
  const taken = new Set<string>();
  const visits: Visit[] = [];
  for (;;) {
    const a = crew.filter(c => c.onShift).sort((x, y) => x.freeAt - y.freeAt)[0];
    if (!a) return visits;
    const task = pick(pool, a.pos, snapshotMin + a.freeAt, taken);
    if (!task) return visits;
    const roadKm = haversineKm(a.pos, task) * REC.roadFactor;
    const reachedMin = a.freeAt + (roadKm / REC.speedKmh) * 60;
    if (reachedMin + REC.serviceMin > shiftMin) {
      a.onShift = false;
      continue;
    }
    taken.add(task.householdId);
    visits.push({ task, reachedMin, roadKm });
    for (const c of pool) if (c.kind === 'inspection' && c.hex === task.hex) c.verifiedInCell++;
    a.pos = task;
    a.freeAt = reachedMin + REC.serviceMin;
  }
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k-means++ seeding over the pool: spread out, weighted to where the work is. */
function spreadStarts(pool: readonly Candidate[], n: number, seed: number): LatLng[] {
  const rand = mulberry32(seed);
  const sorted = [...pool].sort(byId);
  const starts: LatLng[] = [sorted[Math.floor(rand() * sorted.length)]];
  while (starts.length < n) {
    const d2 = sorted.map(c => Math.min(...starts.map(s => haversineKm(s, c) ** 2)));
    let r = rand() * d2.reduce((sum, x) => sum + x, 0);
    let i = 0;
    while (i < d2.length - 1 && (r -= d2[i]) > 0) i++;
    starts.push(sorted[i]);
  }
  return starts.map(({ lat, lng }) => ({ lat, lng }));
}

async function loadSnapshot(): Promise<{ pool: Candidate[]; simMinutes: number }> {
  const { conn } = await connect();
  await subscribe(conn, [
    'SELECT * FROM replay_state',
    'SELECT * FROM household',
    'SELECT * FROM hex_stats',
    'SELECT * FROM unaccounted_queue',
    'SELECT * FROM inspection_candidate',
  ]);
  const db = conn.db;
  const replay = [...db.replayState.iter()][0];
  if (!replay) throw new Error('replay_state is empty: seed the database first');
  const where = new Map([...db.household.iter()].map(h => [h.id, { lat: h.lat, lng: h.lng }]));
  const verified = new Map([...db.hexStats.iter()].map(s => [s.hex, s.verifiedHouseholds]));

  const unique = new Map<string, Candidate>();
  for (const q of db.inspectionCandidate.iter()) {
    const at = where.get(q.householdId);
    if (!at) continue;
    unique.set(q.householdId, {
      kind: 'inspection',
      householdId: q.householdId,
      hex: q.hex,
      priority: q.cellPriority,
      ...at,
      inspectScore: q.inspectScore,
      pSevere: q.pSevere,
      verifiedInCell: verified.get(q.hex) ?? 0,
    });
  }
  for (const q of db.unaccountedQueue.iter()) {
    const at = where.get(q.householdId);
    if (!at || q.escalation !== 'field_visit') continue;
    unique.set(q.householdId, {
      kind: 'welfare',
      householdId: q.householdId,
      hex: q.hex,
      priority: q.cellPriority,
      ...at,
      weight: q.weight,
      waitSinceMin: q.waitSinceMin,
      vulnerable: q.vulnerable,
    });
  }
  const simMinutes = replay.simMinutes;
  conn.disconnect();
  return { pool: [...unique.values()].sort(byId), simMinutes };
}

function report(name: string, visits: readonly Visit[], pool: readonly Candidate[], shiftMin: number) {
  const done = (p: (t: Candidate) => boolean) => visits.filter(v => p(v.task)).length;
  const p0Total = pool.filter(c => c.priority === 'P0').length;
  const p0Reached = visits.filter(v => v.task.priority === 'P0').map(v => v.reachedMin);
  const sum = p0Reached.reduce((s, x) => s + x, 0);
  const unreached = p0Total - p0Reached.length;
  const round1 = (x: number) => Math.round(x * 10) / 10;
  return {
    policy: name,
    done: visits.length,
    P0: done(t => t.priority === 'P0'),
    P1: done(t => t.priority === 'P1'),
    P2: done(t => t.priority === 'P2'),
    welfare: done(t => t.kind === 'welfare'),
    inspection: done(t => t.kind === 'inspection'),
    vulnerable: done(t => t.kind === 'welfare' && t.vulnerable),
    km: Math.round(visits.reduce((s, v) => s + v.roadKm, 0)),
    p0ReachMin: p0Reached.length ? round1(sum / p0Reached.length) : null, // reached tasks only
    p0ReachCensoredMin: p0Total ? round1((sum + unreached * shiftMin) / p0Total) : null, // unreached count as shift end
    p0DonePct: p0Total ? round1((100 * p0Reached.length) / p0Total) : null,
  };
}

async function main() {
  // Evaluation reads a local snapshot only.
  if (!/^wss?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(HOST)) throw new Error(`local server only, got ${HOST}`);
  if (!(ADJUSTERS >= 1) || !(HOURS > 0)) throw new Error('--adjusters and --hours must be positive');
  const { pool, simMinutes } = await loadSnapshot();
  if (pool.length === 0) throw new Error('no candidates at this moment: advance the replay first');

  const count = (p: (c: Candidate) => boolean) => pool.filter(p).length;
  console.log(`${DB}  t = ${(simMinutes / 60).toFixed(1)} h  ${ADJUSTERS} adjusters, ${HOURS} h, seed ${SEED}`);
  console.log(
    `pool ${pool.length}: welfare ${count(c => c.kind === 'welfare')} (vulnerable ${count(c => c.kind === 'welfare' && c.vulnerable)}), ` +
      `inspection ${count(c => c.kind === 'inspection')}; ` +
      `P0 ${count(c => c.priority === 'P0')}, P1 ${count(c => c.priority === 'P1')}, P2 ${count(c => c.priority === 'P2')}`
  );

  const shiftMin = HOURS * 60;
  const starts = spreadStarts(pool, ADJUSTERS, SEED);
  const policies: [string, Policy][] = [
    ['queue order', queueOrder],
    ['nearest first', nearestFirst],
    ['next best', nextBest],
  ];
  console.table(policies.map(([name, pick]) => report(name, simulate(pool, starts, simMinutes, shiftMin, pick), pool, shiftMin)));
}

main().then(
  () => process.exit(0),
  e => {
    console.error(errText(e));
    process.exit(1);
  }
);
