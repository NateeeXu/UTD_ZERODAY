// Seed one Triage Loop database from an EventBundle and its model.
//
//   node scripts/seed.ts [--db triage-loop] [--file ../data/live.json] [--model ../data/model.json] [--wipe]
//   node scripts/seed.ts --db triage-loop-tx --file ../data/real/tx-corpus-christi/live.json --model ../data/real/tx-corpus-christi/model.json
//   node scripts/seed.ts --model-only [--model ...]   (reload the model and reset the demo; world untouched)
//   --cadence N   full-recompute cadence in sim minutes for the running replay (default 60; 0 = only on
//                 jump/pause/end). See set_recompute_cadence.
//
// Target: --host/--db, else SPACETIME_HOST (ws://127.0.0.1:3000) / SPACETIME_DB (triage-loop).
// Auth: SPACETIME_TOKEN or the `spacetime` CLI login (the identity that published the module).
// Passcodes: STAFF_PASSCODE / REPLY_PASSCODE (defaults are public; set your own for Maincloud).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventBundle, Facility, HexCell, Household, SimEvent } from '../../shared/types.ts';
import { chunks, connect, DB, errText, HOST, ownerToken, REPLY_PASSCODE, STAFF_PASSCODE, subscribe } from './lib.ts';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : def;
};
const num = (name: string, def: number) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};

const bundlePath = opt('--file', resolve(here, '../../data/live.json'));
const modelPath = opt('--model', resolve(bundlePath, '..', 'model.json'));
const BATCH = num('--batch', 1000); // rows per reducer call (households, truth, staged events)

// Explicit converters: the bindings want every optional column present (value or undefined).
const hexRow = (h: HexCell, displayOrder: number) => ({
  hex: h.hex,
  displayOrder,
  lat: h.lat,
  lng: h.lng,
  windMph: h.windMph,
  floodDepthFt: h.floodDepthFt,
  towerOutagePct: h.towerOutagePct,
  analystZone: h.analystZone,
  hazardIndex: h.hazardIndex,
  shakingMmi: h.shakingMmi,
  liquefaction: h.liquefaction,
  tractGeoid: h.tractGeoid,
  daytimeWorkers: h.daytimeWorkers,
  residentWorkers: h.residentWorkers,
  k12Enrollment: h.k12Enrollment,
  collegeEnrollment: h.collegeEnrollment,
});

const facilityRow = (f: Facility) => ({
  id: f.id,
  kind: f.kind,
  name: f.name,
  lat: f.lat,
  lng: f.lng,
  hex: f.hex,
  enrollment: typeof f.enrollment === 'number' ? Math.round(f.enrollment) : undefined,
  capacity: typeof f.capacity === 'number' ? Math.round(f.capacity) : undefined,
  source: f.source,
});

const householdRow = (h: Household) => ({
  id: h.id,
  hex: h.hex,
  lat: h.lat,
  lng: h.lng,
  age65: h.age65,
  livesAlone: h.livesAlone,
  medicalDevice: h.medicalDevice,
  windCovered: h.windCovered,
  floodPolicy: h.floodPolicy,
  earthquakeEndorsement: h.earthquakeEndorsement,
  phoneOnFile: h.phoneOnFile,
  holdout: h.holdout,
  tractGeoid: h.tractGeoid,
  childrenUnder18: h.childrenUnder18,
  awayDaytime: h.awayDaytime,
  age75: h.age75,
  disability: h.disability,
  noVehicle: h.noVehicle,
  limitedEnglish: h.limitedEnglish,
  primaryLanguage: h.primaryLanguage,
  mobileHome: h.mobileHome,
  policyType: h.policyType,
  schoolAgeChildren: h.schoolAgeChildren,
  collegeStudent: h.collegeStudent,
  nearestSchoolId: h.nearestSchoolId,
});

function stagedRow(e: SimEvent, seq: number) {
  const base = { seq, t: Math.round(e.t), kind: e.kind, householdId: e.householdId };
  const blank = {
    safety: '', damage: 0, peril: '', reportedDamage: 0, adjusterId: '', text: '', language: '',
    damageKnown: true, lifeSafety: false, needs: '', notHome: false, channel: '', delivered: true,
  };
  switch (e.kind) {
    case 'sms_sent':
      return { ...base, ...blank, delivered: (e as { delivered?: boolean }).delivered !== false };
    case 'sms_reply':
      // v3 fields are optional in the bundle: older bundles seed as before (life safety = "needs help").
      return {
        ...base,
        ...blank,
        safety: e.safety,
        damage: e.damage ?? 0,
        damageKnown: e.damage !== null && e.damage !== undefined,
        text: e.text ?? '',
        language: e.language ?? '',
        lifeSafety: e.lifeSafety ?? e.safety === 'needs_help',
        needs: (e.needs ?? []).join(','),
        notHome: e.notHome ?? false,
        channel: e.channel ?? 'sms',
      };
    case 'claim':
      return { ...base, ...blank, peril: e.peril, reportedDamage: e.reportedDamage };
    case 'field_report':
      // damage null = the adjuster checked the people but did not assess the house.
      return {
        ...base,
        ...blank,
        safety: e.safety,
        damage: e.damage ?? 0,
        damageKnown: e.damage !== null && e.damage !== undefined,
        adjusterId: e.adjusterId,
      };
  }
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const r = await fn();
    console.log(`  ok  ${label} (${Math.round(performance.now() - t0)} ms)`);
    return r;
  } catch (e) {
    console.error(`  FAIL ${label}: ${errText(e)}`);
    throw e;
  }
}

/** Send rows in batches with one progress line per table. */
async function batched<T>(label: string, rows: T[], size: number, call: (batch: T[]) => Promise<void>) {
  const t0 = performance.now();
  let done = 0;
  for (const batch of chunks(rows, size)) {
    try {
      await call(batch);
    } catch (e) {
      console.error(`\n  FAIL ${label} at rows ${done}..${done + batch.length}: ${errText(e)}`);
      throw e;
    }
    done += batch.length;
    if (process.stdout.isTTY) process.stdout.write(`\r  ..  ${label} ${done}/${rows.length}`);
  }
  const ms = performance.now() - t0;
  const rate = ms > 0 ? Math.round((rows.length / ms) * 1000) : rows.length;
  console.log(`${process.stdout.isTTY ? '\r' : ''}  ok  ${label} ${rows.length} rows in ${Math.round(ms)} ms (${rate}/s, batch ${size})`);
}

async function modelOnly() {
  if (!existsSync(modelPath)) throw new Error(`model not found: ${modelPath}`);
  console.log(`target ${HOST} / ${DB}`);
  const { conn } = await connect(ownerToken());
  await step(`load_model ${modelPath}`, () => conn.reducers.loadModel({ json: readFileSync(modelPath, 'utf8') }));
  await step('reset_demo', () => conn.reducers.resetDemo({}));
  conn.disconnect();
}

async function main() {
  if (flag('--model-only')) return modelOnly();
  if (!existsSync(bundlePath)) throw new Error(`bundle not found: ${bundlePath}`);
  const tAll = performance.now();
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as EventBundle;
  const { world, events, truth } = bundle;
  const facilities = world.facilities ?? [];
  console.log(
    `bundle ${bundlePath}\n  ${world.name} (${world.region ?? 'no region'}, ${world.hazardType ?? 'hurricane'}): ` +
      `${world.hexes.length} cells, ${world.households.length} households, ${facilities.length} facilities, ` +
      `${events.length} events, ${truth.length} truth rows`
  );
  console.log(`target ${HOST} / ${DB}`);
  const { conn, identity } = await connect(ownerToken());
  console.log(`  owner identity ${identity.toHexString()}`);
  const r = conn.reducers;

  if (flag('--wipe')) await step('wipe_world', () => r.wipeWorld({}));
  if (!process.env.STAFF_PASSCODE || !process.env.REPLY_PASSCODE)
    console.warn('  note: using the default demo passcodes (set STAFF_PASSCODE / REPLY_PASSCODE for a shared deployment)');
  await step('set_passcodes', () => r.setPasscodes({ staffPasscode: STAFF_PASSCODE, replyPasscode: REPLY_PASSCODE }));
  await step('seed_world', () =>
    r.seedWorld({
      world: {
        eventId: world.eventId,
        name: world.name,
        landfallIso: world.landfallIso,
        centerLat: world.center.lat,
        centerLng: world.center.lng,
        region: world.region,
        hazardType: world.hazardType,
        horizonMinutes: world.horizonMinutes,
        eventLocalHour: world.eventLocalHour,
        eventWeekday: world.eventWeekday,
        dataSources: world.dataSources ?? [],
        hazardGeometry: world.hazardGeometry ? JSON.stringify(world.hazardGeometry) : '',
      },
    })
  );

  await batched('seed_hexes', world.hexes.map(hexRow), 500, b => r.seedHexes({ hexes: b }));
  if (facilities.length > 0)
    await batched('seed_facilities', facilities.map(facilityRow), 500, b => r.seedFacilities({ facilities: b }));
  await batched('seed_households', world.households.map(householdRow), BATCH, b => r.seedHouseholds({ households: b }));
  const truthRows = truth.map(t => ({
    householdId: t.householdId,
    damage: t.damage,
    safety: t.safety,
    peril: t.peril,
    needType: t.needType ?? (t.safety === 'needs_help' ? 'life_safety' : 'none'),
    location: t.location ?? 'home',
    returnMin: t.returnMin ?? -1,
  }));
  await batched('seed_truth', truthRows, BATCH * 2, b => r.seedTruth({ rows: b }));

  // events are sorted by t in the bundle; keep that order as seq (re-sort defensively, stable).
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i);
  const staged = sorted.map(({ e }, seq) => stagedRow(e, seq));
  await batched('seed_staged_events', staged, BATCH * 2, b => r.seedStagedEvents({ events: b }));

  if (existsSync(modelPath)) {
    const json = readFileSync(modelPath, 'utf8');
    await step(`load_model ${modelPath}`, () => r.loadModel({ json }));
  } else {
    console.log(`  --  no model at ${modelPath}; the TEMPORARY stub estimator will be used`);
  }

  await step('reset_demo (rebuild stats + recompute every cell)', () => r.resetDemo({}));
  if (args.includes('--cadence'))
    await step(`set_recompute_cadence ${num('--cadence', 60)}`, () => r.setRecomputeCadence({ minutes: num('--cadence', 60) }));

  await subscribe(conn, ['SELECT * FROM metrics', 'SELECT * FROM replay_state', 'SELECT * FROM world']);
  const m = [...conn.db.metrics.iter()][0];
  const rs = [...conn.db.replayState.iter()][0];
  const w = [...conn.db.world.iter()][0];
  console.log('\nseeded:', {
    database: DB,
    world: w?.name,
    context: w && { hazardType: w.hazardType, localHour: w.localHour, weekday: w.weekday, daytime: w.daytime, schoolHours: w.schoolHours },
    hexes: m?.hexes,
    households: m?.households,
    stagedEvents: rs?.totalStaged,
    horizonMinutes: rs?.maxMinutes,
    cells: { P0: m?.p0Cells, P1: m?.p1Cells, P2: m?.p2Cells, needsVerification: m?.needsVerificationCells },
    engine: m?.engine,
    modelVersion: m?.modelVersion,
    seconds: +((performance.now() - tAll) / 1000).toFixed(1),
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
