// Live replay (v2).
//   node scripts/replay.ts                                     # every known live world with its model
//   node scripts/replay.ts --bundle <live.json> --model <model.json>
//   node scripts/replay.ts <dataDir>                           # <dataDir>/live.json + <dataDir>/model.json
// Options: --times 120,360,720,1440 --at 1440 --reports 30 --batch 10 --verbose
// Per snapshot: tier counts, top silent cells (with cause and nearest facilities), top P0 cells,
// holdout metrics, verified coverage. Then --reports simulated field reports chosen by active
// inspection (report = truth), the local update, the trust loop, the hit rate vs base rate, and
// what changed. Truth is used ONLY to create the simulated reports and to score holdout households.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { HexCell, HexEstimate, HouseholdEstimate, SimEvent, TruthRow } from '../../shared/types.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { estimateAll } from '../src/infer.ts';
import type { Estimates, SourceTrust } from '../src/infer.ts';
import { initLearningState, localUpdate, recordFieldReport } from '../src/learning.ts';
import type { FieldReportEvent, LearningState } from '../src/learning.ts';
import { nearestFacilities, recommendInspections } from '../src/active.ts';
import { brier, ece, verifiedCoverage } from '../src/metrics.ts';
import { DEFAULT_DATA_DIR, fmt, heading, knownRegions, loadBundle, loadModel, minutesLabel, parseArgs, pct, table, truthMap } from './io.ts';

const cfg = DEFAULT_CONFIG;
const args = parseArgs(process.argv.slice(2));
const times = (args.flags.get('times') ?? '120,360,720,1440').split(',').map(Number);
const atT = Number(args.flags.get('at') ?? 1440);
const nReports = Number(args.flags.get('reports') ?? 30);
const batch = Number(args.flags.get('batch') ?? 10);
const verbose = args.flags.get('verbose') === 'true';

interface Target {
  bundle: string;
  model: string;
}
const targets: Target[] = [];
if (args.flags.has('bundle')) {
  const bundle = resolve(args.flags.get('bundle')!);
  targets.push({ bundle, model: resolve(args.flags.get('model') ?? join(bundle, '..', 'model.json')) });
} else if (args.positional.length > 0) {
  const dir = resolve(args.positional[0]);
  targets.push({ bundle: join(dir, 'live.json'), model: resolve(args.flags.get('model') ?? join(dir, 'model.json')) });
} else {
  for (const r of knownRegions(resolve(args.flags.get('data-root') ?? DEFAULT_DATA_DIR))) {
    const bundle = join(r.dir, 'live.json');
    const model = join(r.dir, 'model.json');
    if (existsSync(bundle) && existsSync(model)) targets.push({ bundle, model });
    else console.log(`skipping ${r.id}: missing ${existsSync(bundle) ? model : bundle}`);
  }
}

function top<T>(items: readonly T[], key: (x: T) => number, k: number): T[] {
  return items
    .slice()
    .sort((a, b) => key(b) - key(a))
    .slice(0, k);
}

function replayWorld(target: Target): void {
  const bundle = loadBundle(target.bundle);
  const params = loadModel(target.model);
  const { world } = bundle;
  const truth = truthMap(bundle.truth);
  const cellById = new Map<string, HexCell>(world.hexes.map((c) => [c.hex, c]));
  const householdHex = new Map(world.households.map((h) => [h.id, h.hex]));
  const holdoutIds = new Set(world.households.filter((h) => h.holdout).map((h) => h.id));
  const facilities = world.facilities ?? [];

  console.log(heading(`${world.eventId} "${world.name}"  [${target.bundle}]`));
  const probe = estimateAll(world, [], 0, params, cfg);
  const ctx = probe.snapshot.ctx;
  console.log(
    `${world.hexes.length} cells, ${world.households.length} households (${holdoutIds.size} holdout), ${bundle.events.length} events, ${facilities.length} facilities; hazard=${ctx.hazardType}, local hour ${ctx.localHour} ${ctx.weekday ? 'weekday' : 'weekend'} (from ${ctx.timeSource}), daytime=${ctx.daytime}, schoolHours=${ctx.schoolHours}`,
  );
  console.log(`model: ${target.model}  region=${params.region ?? '-'} version=${params.version} features=${params.features.length} trainedOn=${params.trainedOn.join(',')}`);
  console.log(`thresholds: ${JSON.stringify(cfg.thresholds)}`);

  const tierCounts = (hexes: readonly HexEstimate[]): { P0: number; P1: number; P2: number; nv: number; p0nv: number; suspected: number } => {
    const c = { P0: 0, P1: 0, P2: 0, nv: 0, p0nv: 0, suspected: 0 };
    for (const x of hexes) {
      c[x.priority]++;
      if (x.verification === 'needs_verification') {
        c.nv++;
        if (x.priority === 'P0') c.p0nv++;
      }
      if (x.reason?.startsWith('suspected')) c.suspected++;
    }
    return c;
  };

  const truthSevereShare = (hex: string): number => {
    let n = 0;
    let s = 0;
    for (const h of world.households) {
      if (h.hex !== hex) continue;
      n++;
      if (truth.get(h.id)!.damage >= 2) s++;
    }
    return n > 0 ? s / n : NaN;
  };

  const facilityNote = (cell: HexCell): string =>
    nearestFacilities(facilities, cell, 2)
      .map((nf) => `${nf.facility.kind} ${nf.facility.name} ${nf.km.toFixed(1)}km`)
      .join('; ') || '-';

  const cellRow = (x: HexEstimate): (string | number)[] => {
    const c = cellById.get(x.hex)!;
    return [
      x.hex,
      x.priority + (x.reason?.startsWith('suspected') ? '*' : ''),
      x.verification === 'verified' ? 'verified' : 'needs_ver',
      String(x.households),
      fmt(x.hazard ?? NaN, 2),
      String(c.towerOutagePct),
      String(c.analystZone),
      `${x.counts.smsReplies}/${x.counts.smsSent}`,
      String(x.counts.claims),
      String(x.counts.fieldReports),
      x.silence,
      x.silenceCause ?? '-',
      x.confidence,
      fmt(x.expectedSevere, 1),
      x.maxPNeedsHelp,
      pct(truthSevereShare(x.hex)),
      facilityNote(c),
    ];
  };
  const CELL_HEADERS = ['hex', 'tier', 'verif', 'hh', 'hazard', 'out%', 'zone', 'reply/sent', 'claims', 'field', 'silence', 'cause', 'conf', 'E[sev]', 'maxHelp', 'truth sev% (eval)', 'nearest facilities'];

  interface HoldoutMetrics {
    n: number;
    brierSevere: number;
    eceSevere: number;
    brierHelp: number;
  }
  const holdoutMetrics = (households: readonly HouseholdEstimate[], ids: ReadonlySet<string> = holdoutIds): HoldoutMetrics => {
    const pS: number[] = [];
    const yS: number[] = [];
    const pH: number[] = [];
    const yH: number[] = [];
    for (const e of households) {
      if (!ids.has(e.householdId)) continue;
      const tr = truth.get(e.householdId)!;
      pS.push(e.pSevere);
      yS.push(tr.damage >= 2 ? 1 : 0);
      pH.push(e.pNeedsHelp);
      yH.push(tr.safety === 'needs_help' ? 1 : 0);
    }
    return { n: pS.length, brierSevere: brier(pS, yS), eceSevere: ece(pS, yS), brierHelp: brier(pH, yH) };
  };

  // ---------- snapshots ----------
  for (const t of times) {
    const est = estimateAll(world, bundle.events, t, params, cfg);
    const c = tierCounts(est.hexes);
    const causes: Record<string, number> = {};
    for (const x of est.hexes) if (x.silenceCause) causes[x.silenceCause] = (causes[x.silenceCause] ?? 0) + 1;
    console.log(heading(`t = ${minutesLabel(t)}`));
    console.log(
      `tiers: P0 ${c.P0} (suspected ${c.suspected})  P1 ${c.P1}  P2 ${c.P2}   needs_verification ${c.nv} (of which P0 ${c.p0nv})   silence causes: ${JSON.stringify(causes)}`,
    );
    const r = est.snapshot.refs;
    console.log(
      `refs: reply rate ${fmt(r.refReplyRate)} (limited-English x${fmt(r.limitedEnglishReplyFactor, 2)}, away x${fmt(r.awayReplyFactor, 2)}), claims/exposure ${fmt(r.claimRatePerExposure)} (renters x${fmt(r.renterClaimFactor, 2)})`,
    );
    console.log('\ntop 5 silent cells:');
    console.log(table(CELL_HEADERS, top(est.hexes, (x) => x.silence, 5).map(cellRow)));
    const p0 = est.hexes.filter((x) => x.priority === 'P0');
    console.log(`\ntop 5 P0 cells by severity (${p0.length} P0 cells):`);
    console.log(table(CELL_HEADERS, top(p0, (x) => x.severity * 1000 + x.expectedSevere, 5).map(cellRow)));
    if (verbose) {
      console.log('\nreasons of the top silent cells:');
      for (const x of top(est.hexes, (y) => y.silence, 3)) console.log(`  ${x.hex}: ${x.reason}`);
    }
    const hm = holdoutMetrics(est.households);
    const vc = verifiedCoverage(est.hexes, est.households, householdHex);
    console.log(
      `\nholdout (n=${hm.n}): Brier severe ${fmt(hm.brierSevere)} (ECE ${fmt(hm.eceSevere)}), Brier needsHelp ${fmt(hm.brierHelp)}   verified coverage: P0 cells ${vc.p0CellsWithReport}/${vc.p0Cells} (${pct(vc.cellShare)}), suspected households ${vc.suspectedVerified}/${vc.suspectedHouseholds} (${pct(vc.householdShare)})`,
    );
  }

  // ---------- simulated field reports ----------
  console.log(heading(`simulating ${nReports} field reports at t = ${minutesLabel(atT)} (batches of ${batch}, chosen by active inspection; report = truth)`));
  const before = estimateAll(world, bundle.events, atT, params, cfg);
  const baselineTrust: SourceTrust = { ...params.sourceTrust };
  let learning: LearningState = initLearningState(params);
  let snapshot = before.snapshot;
  let households = before.households;
  let hexes = before.hexes;
  const models = before.models;
  const events: SimEvent[] = bundle.events.slice();
  const reported = new Set<string>();
  const log: (string | number)[][] = [];
  let hitHelp = 0;
  let hitSevere = 0;
  let made = 0;
  while (made < nReports) {
    const want = Math.min(batch, nReports - made);
    const picks = recommendInspections(world, households, hexes, want, cfg, { exclude: reported });
    if (picks.length === 0) break;
    for (const p of picks) {
      const tr: TruthRow = truth.get(p.householdId)!;
      if (tr.safety === 'needs_help') hitHelp++;
      if (tr.damage >= 2) hitSevere++;
      const report: FieldReportEvent = { kind: 'field_report', t: atT, householdId: p.householdId, adjusterId: 'adj-sim', safety: tr.safety, damage: tr.damage };
      events.push(report);
      reported.add(p.householdId);
      const prevHex = hexes.find((x) => x.hex === p.hex)!;
      const lu = localUpdate(snapshot, report, models, cfg, households, hexes);
      snapshot = lu.snapshot;
      households = lu.households;
      hexes = lu.hexes;
      if (lu.observation) learning = recordFieldReport(learning, lu.observation, cfg);
      const newHex = hexes.find((x) => x.hex === p.hex)!;
      log.push([
        String(++made),
        p.householdId,
        p.hex,
        holdoutIds.has(p.householdId) ? 'holdout' : '',
        p.score,
        p.pSevere,
        p.pNeedsHelp,
        p.uncertainty,
        p.cellSilence,
        `${tr.damage}/${tr.safety}`,
        `${prevHex.priority}/${prevHex.verification === 'verified' ? 'v' : 'nv'} -> ${newHex.priority}/${newHex.verification === 'verified' ? 'v' : 'nv'}`,
      ]);
    }
  }
  const unverifiedBefore = before.households.filter((e) => !e.verified);
  const baseHelp = unverifiedBefore.filter((e) => truth.get(e.householdId)!.safety === 'needs_help').length / Math.max(unverifiedBefore.length, 1);
  const baseSevere = unverifiedBefore.filter((e) => truth.get(e.householdId)!.damage >= 2).length / Math.max(unverifiedBefore.length, 1);
  console.log(
    `active-inspection hit rate over ${made} reports: needs_help ${hitHelp}/${made} = ${pct(hitHelp / Math.max(made, 1))} vs base rate ${pct(baseHelp, 1)} (lift x${(hitHelp / Math.max(made, 1) / Math.max(baseHelp, 1e-9)).toFixed(1)}); severe ${hitSevere}/${made} = ${pct(hitSevere / Math.max(made, 1))} vs base rate ${pct(baseSevere, 1)}`,
  );
  const shown = verbose ? log : log.slice(0, 8);
  console.log(table(['#', 'household', 'hex', 'hold', 'score', 'pSevere', 'pHelp', 'unc', 'silence', 'truth', 'cell before -> after'], shown));
  if (!verbose && log.length > shown.length) console.log(`... ${log.length - shown.length} more (use --verbose)`);

  // Self-check: the local-update path must equal a full recompute (same trust).
  const after = estimateAll(world, events, atT, params, cfg, baselineTrust);
  let maxDiff = 0;
  for (let i = 0; i < households.length; i++) {
    const a = households[i];
    const b = after.households[i];
    if (a.householdId !== b.householdId) throw new Error('household order mismatch');
    maxDiff = Math.max(maxDiff, Math.abs(a.pSevere - b.pSevere), Math.abs(a.pNeedsHelp - b.pNeedsHelp), Math.abs(a.uncertainty - b.uncertainty), Math.abs((a.inspectScore ?? 0) - (b.inspectScore ?? 0)));
  }
  for (let i = 0; i < hexes.length; i++) {
    const a = hexes[i];
    const b = after.hexes[i];
    if (a.priority !== b.priority || a.verification !== b.verification || a.reason !== b.reason || a.silenceCause !== b.silenceCause) {
      throw new Error(`local update diverged from full recompute at ${a.hex}`);
    }
    maxDiff = Math.max(maxDiff, Math.abs(a.severity - b.severity), Math.abs(a.confidence - b.confidence), Math.abs(a.silence - b.silence));
  }
  console.log(`self-check: local update vs full recompute, max abs diff = ${maxDiff.toExponential(2)} ${maxDiff < 1e-9 ? '(ok)' : '(MISMATCH)'}`);

  const cfgTrustOn = { ...cfg, trust: { ...cfg.trust, applyToInference: true } };
  const afterTrustOn = estimateAll(world, events, atT, params, cfgTrustOn, learning.trust);
  console.log(
    `source trust: calibration ${fmt(baselineTrust.hazard)}/${fmt(baselineTrust.sms)}/${fmt(baselineTrust.claims)} -> after reports ${fmt(learning.trust.hazard)}/${fmt(learning.trust.sms)}/${fmt(learning.trust.claims)} (hazard/sms/claims; ${learning.updates.length} batch update(s), ${learning.nonHoldoutReports} non-holdout + ${learning.holdoutReports} holdout reports; applyToInference=${cfg.trust.applyToInference})`,
  );
  for (const u of learning.updates) {
    console.log(
      `  batch after ${u.afterNonHoldoutReports} reports: scores hazard ${fmt(u.scores.hazard)} (n=${u.opinionCounts.hazard}), sms ${fmt(u.scores.sms)} (n=${u.opinionCounts.sms}), claims ${fmt(u.scores.claims)} (n=${u.opinionCounts.claims})`,
    );
  }

  const stillUnverified = new Set([...holdoutIds].filter((id) => !reported.has(id)));
  const rows: (string | number)[][] = [];
  for (const [label, est] of [
    ['before', before],
    ['after (local updates; default)', after],
    ['after + trust applied (experimental)', afterTrustOn],
  ] as const) {
    const c = tierCounts(est.hexes);
    const all = holdoutMetrics(est.households);
    const unv = holdoutMetrics(est.households, stillUnverified);
    const vc = verifiedCoverage(est.hexes, est.households, householdHex);
    rows.push([label, String(c.P0), String(c.P1), String(c.P2), String(c.nv), String(c.p0nv), all.brierSevere, all.brierHelp, unv.brierSevere, unv.brierHelp, pct(vc.cellShare), pct(vc.householdShare)]);
  }
  console.log('\nbefore vs after (same t; holdout metrics on fixed sets):');
  console.log(
    table(
      ['', 'P0', 'P1', 'P2', 'needs_ver', 'P0 needs_ver', `holdout Brier sev (n=${holdoutIds.size})`, 'holdout Brier help', `unverified-holdout Brier sev (n=${stillUnverified.size})`, 'unverified-holdout Brier help', 'verified cov (P0 cells)', 'verified cov (suspected hh)'],
      rows,
    ),
  );
  let changed = 0;
  const examples: string[] = [];
  for (let i = 0; i < before.hexes.length; i++) {
    const a = before.hexes[i];
    const b = after.hexes[i];
    if (a.priority !== b.priority || a.verification !== b.verification) {
      changed++;
      if (examples.length < 6) examples.push(`${a.hex}: ${a.priority}/${a.verification} -> ${b.priority}/${b.verification} (conf ${fmt(a.confidence, 2)} -> ${fmt(b.confidence, 2)}, ${b.counts.fieldReports} field, truth severe ${pct(truthSevereShare(a.hex))})`);
    }
  }
  console.log(`cells whose tier or verification changed after the local updates: ${changed}`);
  for (const e of examples) console.log(`  ${e}`);
}

if (targets.length === 0) throw new Error('nothing to replay');
for (const t of targets) replayWorld(t);
