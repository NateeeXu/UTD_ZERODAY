// Offline tests for the adjuster "Next best" ranking (src/recommend-rank.ts): no database, no network.
//
//   node scripts/recommend-test.ts
import {
  rankCandidates,
  reasonOf,
  REC,
  valueOf,
  type Candidate,
  type InspectionCandidate,
  type LatLng,
  type WelfareCandidate,
} from '../src/recommend-rank.ts';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const NOW = 2000;
const HOME: LatLng = { lat: 29.76, lng: -95.37 };

/** A point `km` north of HOME (1 degree of latitude is about 111.2 km). */
const north = (km: number): LatLng => ({ lat: HOME.lat + km / 111.2, lng: HOME.lng });

const welfare = (householdId: string, over: Partial<WelfareCandidate> = {}): WelfareCandidate => ({
  kind: 'welfare',
  householdId,
  hex: 'cell-a',
  priority: 'P1',
  ...north(1),
  weight: 0.4,
  waitSinceMin: NOW,
  vulnerable: false,
  ...over,
});

const inspection = (householdId: string, over: Partial<InspectionCandidate> = {}): InspectionCandidate => ({
  kind: 'inspection',
  householdId,
  hex: 'cell-a',
  priority: 'P1',
  ...north(1),
  inspectScore: 0.6,
  pSevere: 0.7,
  verifiedInCell: 1,
  ...over,
});

const ids = (cs: readonly Candidate[], excluded?: ReadonlySet<string>) =>
  rankCandidates(cs, HOME, NOW, excluded).map(r => r.householdId);
const same = (a: readonly unknown[], b: readonly unknown[]) => JSON.stringify(a) === JSON.stringify(b);

// ----- order -----
{
  const got = ids([
    welfare('near-p1', { priority: 'P1', ...north(0.1), weight: 1 }),
    welfare('far-p0', { priority: 'P0', ...north(300), weight: 0.01 }),
  ]);
  check('P0 far away ranks before P1 next door', same(got, ['far-p0', 'near-p1']), got.join(' > '));
}
{
  const got = ids([welfare('far', north(20)), welfare('near', north(2))]);
  check('within a tier, nearer beats farther for equal value', same(got, ['near', 'far']), got.join(' > '));
}
{
  // Input order must not matter, and identical candidates fall back to the household id.
  const a = welfare('hh-a');
  const b = welfare('hh-b');
  const c = welfare('hh-c');
  const one = ids([c, a, b]);
  const two = ids([b, c, a]);
  check('tie-break is the household id, whatever the input order', same(one, ['hh-a', 'hh-b', 'hh-c']) && same(two, one), one.join(' > '));
  const rows = rankCandidates([c, a, b], HOME, NOW);
  check('tied candidates really have equal scores', rows[0].score === rows[1].score && rows[1].score === rows[2].score, `score ${rows[0].score}`);
}

// ----- value -----
{
  const at = (waitMin: number) => valueOf(welfare('w', { weight: 0.3, waitSinceMin: NOW - waitMin }), NOW);
  const fresh = at(0);
  const later = at(120);
  const much = at(REC.agingMin * 2);
  check('longer wait raises welfare value', later > fresh && much > later, `${fresh.toFixed(3)} < ${later.toFixed(3)} < ${much.toFixed(3)}`);
  check('welfare value saturates at 1', at(REC.agingMin * 10) === 1 && at(REC.agingMin * 100) === 1, `value ${at(REC.agingMin * 10)}`);
  check('a future waitSince counts as no wait', valueOf(welfare('w', { weight: 0.3, waitSinceMin: NOW + 500 }), NOW) === fresh);
}
{
  const at = (verifiedInCell: number) => valueOf(inspection('i', { verifiedInCell }), NOW);
  const values = [0, 1, 2, 5, 20].map(at);
  const falling = values.every((v, i) => i === 0 || v < values[i - 1]);
  check('inspection value falls as verifiedInCell rises', falling, values.map(v => v.toFixed(3)).join(' > '));
  check('first inspection in a cell keeps the full inspectScore', at(0) === 0.6, `value ${at(0)}`);
}

// ----- dedupe and exclusion -----
{
  const w = welfare('both');
  const i = inspection('both', { inspectScore: 1 });
  const kinds = (cs: Candidate[]) => rankCandidates(cs, HOME, NOW).map(r => r.kind);
  check('welfare/inspection dedupe keeps welfare (inspection first)', same(kinds([i, w]), ['welfare']), kinds([i, w]).join(','));
  check('welfare/inspection dedupe keeps welfare (welfare first)', same(kinds([w, i]), ['welfare']), kinds([w, i]).join(','));
}
{
  const got = ids([welfare('keep'), welfare('drop'), inspection('drop-too')], new Set(['drop', 'drop-too']));
  check('excluded households are dropped', same(got, ['keep']), got.join(','));
  // An excluded household must not use up a slot of the cell cap.
  const capped = ids([welfare('a'), welfare('b'), welfare('c'), welfare('d')], new Set(['a']));
  check('excluded households do not count against the cell cap', same(capped, ['b', 'c', 'd']), capped.join(','));
}

// ----- caps and ranks -----
{
  const inCell = Array.from({ length: 6 }, (_, i) => welfare(`same-${i}`, { hex: 'crowded', ...north(1 + i) }));
  const rows = rankCandidates(inCell, HOME, NOW);
  check(`at most ${REC.perCell} per cell`, rows.length === REC.perCell, `${rows.length} rows`);
  check('the cell cap keeps the best of the cell', same(rows.map(r => r.householdId), ['same-0', 'same-1', 'same-2']), rows.map(r => r.householdId).join(','));
}
{
  // 8 cells of 5, nearest cell first: the cap bites in each cell in turn and the list still fills to 10 rows.
  const many = Array.from({ length: 8 * 5 }, (_, i) => welfare(`hh-${String(i).padStart(2, '0')}`, { hex: `cell-${Math.floor(i / 5)}`, ...north(1 + i) }));
  const rows = rankCandidates(many, HOME, NOW);
  const perHex = new Map<string, number>();
  for (const r of rows) perHex.set(r.hex, (perHex.get(r.hex) ?? 0) + 1);
  check(`at most ${REC.maxRows} rows`, rows.length === REC.maxRows, `${rows.length} rows`);
  check('capped cells give way to the next cell', same([...perHex.values()], [3, 3, 3, 1]), [...perHex.values()].join(','));
  check('ranks are 1..n', same(rows.map(r => r.rank), rows.map((_, i) => i + 1)), rows.map(r => r.rank).join(','));
}
check('no candidates, no rows', rankCandidates([], HOME, NOW).length === 0);

// ----- bad coordinates -----
{
  const got = ids([
    welfare('ok'),
    welfare('nan-lat', { lat: Number.NaN }),
    welfare('nan-lng', { lng: Number.NaN }),
    welfare('inf-lat', { lat: Number.POSITIVE_INFINITY }),
    inspection('inf-lng', { lng: Number.NEGATIVE_INFINITY }),
  ]);
  check('non-finite coordinates are skipped', same(got, ['ok']), got.join(','));
}

// ----- reason strings -----
const reasonCases: [string, Candidate, string][] = [
  ['welfare, under an hour', welfare('r', { waitSinceMin: NOW - 20 }), 'No reply < 1 h'],
  ['welfare, hours', welfare('r', { waitSinceMin: NOW - 180 }), 'No reply 3 h'],
  ['welfare, vulnerable, under an hour', welfare('r', { waitSinceMin: NOW - 20, vulnerable: true }), 'Vulnerable · no reply < 1 h'],
  ['welfare, vulnerable, hours', welfare('r', { waitSinceMin: NOW - 300, vulnerable: true }), 'Vulnerable · no reply 5 h'],
  ['inspection, first in the area', inspection('r', { verifiedInCell: 0, pSevere: 0.9 }), 'Inspect · first in area'],
  ['inspection, likely severe', inspection('r', { verifiedInCell: 2, pSevere: 0.5 }), 'Inspect · likely severe'],
  ['inspection, damage unclear', inspection('r', { verifiedInCell: 2, pSevere: 0.49 }), 'Inspect · damage unclear'],
];
for (const [label, c, want] of reasonCases) {
  const got = reasonOf(c, NOW);
  check(`reason: ${label}`, got === want, got);
}
{
  const [row] = rankCandidates([welfare('r', { waitSinceMin: NOW - 180 })], HOME, NOW);
  check('ranked row carries the reason', row.reason === 'No reply 3 h', row.reason);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
