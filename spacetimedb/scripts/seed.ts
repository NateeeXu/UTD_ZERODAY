// Seed the Triage Loop database from an EventBundle (data/live.json) and data/model.json.
//
//   node scripts/seed.ts [--file ../data/live.json] [--model ../data/model.json] [--wipe]
//   node scripts/seed.ts --model-only      (reload data/model.json and reset the demo; world untouched)
//
// Env: SPACETIME_HOST (ws://127.0.0.1:3000), SPACETIME_DB (triage-loop), SPACETIME_TOKEN (owner token;
// defaults to the `spacetime` CLI login), STAFF_PASSCODE, REPLY_PASSCODE.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventBundle, SimEvent } from '../../shared/types.ts';
import { chunks, connect, DB, errText, HOST, ownerToken, REPLY_PASSCODE, STAFF_PASSCODE, subscribe } from './lib.ts';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : def;
};

const bundlePath = opt('--file', resolve(here, '../../data/live.json'));
const modelPath = opt('--model', resolve(here, '../../data/model.json'));

function stagedRow(e: SimEvent, seq: number) {
  const base = { seq, t: Math.round(e.t), kind: e.kind, householdId: e.householdId };
  const blank = { safety: '', damage: 0, peril: '', reportedDamage: 0, adjusterId: '' };
  switch (e.kind) {
    case 'sms_sent':
      return { ...base, ...blank };
    case 'sms_reply':
      return { ...base, ...blank, safety: e.safety, damage: e.damage };
    case 'claim':
      return { ...base, ...blank, peril: e.peril, reportedDamage: e.reportedDamage };
    case 'field_report':
      return { ...base, ...blank, safety: e.safety, damage: e.damage, adjusterId: e.adjusterId };
  }
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`  ok  ${label} (${Date.now() - t0} ms)`);
    return r;
  } catch (e) {
    console.error(`  FAIL ${label}: ${errText(e)}`);
    throw e;
  }
}

async function modelOnly() {
  if (!existsSync(modelPath)) throw new Error(`model not found: ${modelPath}`);
  const { conn } = await connect(ownerToken());
  await step(`load_model ${modelPath}`, () => conn.reducers.loadModel({ json: readFileSync(modelPath, 'utf8') }));
  await step('reset_demo', () => conn.reducers.resetDemo({}));
  conn.disconnect();
}

async function main() {
  if (flag('--model-only')) return modelOnly();
  if (!existsSync(bundlePath)) throw new Error(`bundle not found: ${bundlePath}`);
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as EventBundle;
  const { world, events, truth } = bundle;
  console.log(
    `bundle ${bundlePath}: ${world.hexes.length} hexes, ${world.households.length} households, ${events.length} events, ${truth.length} truth rows`
  );
  console.log(`connecting to ${HOST} / ${DB} as owner`);
  const { conn, identity } = await connect(ownerToken());
  console.log(`  identity ${identity.toHexString()}`);
  const r = conn.reducers;

  if (flag('--wipe')) await step('wipe_world', () => r.wipeWorld({}));
  if (!process.env.STAFF_PASSCODE || !process.env.REPLY_PASSCODE)
    console.warn('  note: using default demo passcodes (set STAFF_PASSCODE / REPLY_PASSCODE for a public deployment)');
  await step('set_passcodes', () => r.setPasscodes({ staffPasscode: STAFF_PASSCODE, replyPasscode: REPLY_PASSCODE }));
  await step('seed_world', () =>
    r.seedWorld({
      eventId: world.eventId,
      name: world.name,
      landfallIso: world.landfallIso,
      centerLat: world.center.lat,
      centerLng: world.center.lng,
    })
  );

  const hexes = world.hexes.map((h, i) => ({ ...h, displayOrder: i }));
  for (const [i, batch] of chunks(hexes, 400).entries())
    await step(`seed_hexes #${i} (${batch.length})`, () => r.seedHexes({ hexes: batch }));

  for (const [i, batch] of chunks(world.households, 500).entries())
    await step(`seed_households #${i} (${batch.length})`, () => r.seedHouseholds({ households: batch }));

  for (const [i, batch] of chunks(truth, 1000).entries())
    await step(`seed_truth #${i} (${batch.length})`, () => r.seedTruth({ rows: batch }));

  // events are sorted by t in the bundle; keep that order as seq (re-sort defensively, stable).
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i);
  const staged = sorted.map(({ e }, seq) => stagedRow(e, seq));
  for (const [i, batch] of chunks(staged, 1000).entries())
    await step(`seed_staged_events #${i} (${batch.length})`, () => r.seedStagedEvents({ events: batch }));

  if (existsSync(modelPath)) {
    const json = readFileSync(modelPath, 'utf8');
    await step(`load_model ${modelPath}`, () => r.loadModel({ json }));
  } else {
    console.log(`  --  no model at ${modelPath}; the TEMPORARY stub estimator will be used`);
  }

  await step('reset_demo (rebuild stats + recompute every cell)', () => r.resetDemo({}));

  await subscribe(conn, ['SELECT * FROM metrics', 'SELECT * FROM replay_state']);
  const m = [...conn.db.metrics.iter()][0];
  const rs = [...conn.db.replayState.iter()][0];
  console.log('\nseeded:', {
    hexes: m?.hexes,
    households: m?.households,
    stagedEvents: rs?.totalStaged,
    cells: { P0: m?.p0Cells, P1: m?.p1Cells, P2: m?.p2Cells, needsVerification: m?.needsVerificationCells },
    engine: m?.engine,
    modelVersion: m?.modelVersion,
  });
  conn.disconnect();
}

main().then(
  () => process.exit(0),
  e => {
    console.error(errText(e));
    process.exit(1);
  }
);
