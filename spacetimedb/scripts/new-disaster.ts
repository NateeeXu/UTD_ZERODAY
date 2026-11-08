// New random (hypothetical) disaster, generated and loaded into one database in one command.
// The calibrated model is kept: the event is new to it (an out-of-sample test). Simulated staff are
// switched on (settings: 0 = default capacities) unless --no-staff.
//
//   node --env-file=.env scripts/new-disaster.ts --region ca --db triage-loop-nateeexu-ca [--seed 42]
//        [--fault Hayward --magnitude 7.0 --hour 3 --weekday true] [--preset <id>] [--no-staff]
//   node --env-file=.env scripts/new-disaster.ts --region tx --db triage-loop-nateeexu-tx [--category 4 --hour 2]
// Without --env-file the local server is used (ws://127.0.0.1:3000).
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, ownerToken } from './lib.ts';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const take = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const region = take('--region');
const db = take('--db');
const noStaff = argv.includes('--no-staff');
if (noStaff) argv.splice(argv.indexOf('--no-staff'), 1);
if ((region !== 'tx' && region !== 'ca') || !db) throw new Error('usage: scripts/new-disaster.ts --region tx|ca --db <database> [generator options]');
const regionDir = region === 'tx' ? 'tx-corpus-christi' : 'ca-bay-area';

const gen = spawnSync(process.execPath, [resolve(here, '../../sim/real/random.ts'), region, ...argv], { encoding: 'utf8' });
process.stdout.write(gen.stdout);
process.stderr.write(gen.stderr);
if (gen.status !== 0) process.exit(gen.status ?? 1);
const file = gen.stdout.trim().split('\n').pop()!;

const seed = spawnSync(
  process.execPath,
  [resolve(here, 'seed.ts'), '--db', db, '--file', file, '--model', resolve(here, `../../data/real/${regionDir}/model.json`), '--cadence', '120', '--wipe'],
  { stdio: 'inherit', env: process.env },
);
if (seed.status !== 0) process.exit(seed.status ?? 1);

const { conn } = await connect(ownerToken());
await conn.reducers.setStaffSim({ enabled: !noStaff, callsPerHour: 0, visitsPerHour: 0, inspectionsPerHour: 0 });
await conn.reducers.resetDemo({});
conn.disconnect();
console.log(`\nloaded into ${db}; simulated staff ${noStaff ? 'off' : 'on'}; replay at t = 0 (start_replay or step_replay to run it)`);
process.exit(0);
