// Runs the manager's "New random disaster" button from this Mac. The generator reads data/real and
// loading needs the owner token, so neither can happen in the browser or in a reducer.
// A demo region is only replaceable while a worker runs for it, so stop the worker to lock that map.
// A region's database only takes its own kind of disaster. Only requests made after the worker starts
// are run; older unfinished ones are marked failed. One worker per database.
//
//   node --env-file=.env scripts/disaster-worker.ts --host wss://maincloud.spacetimedb.com --db triage-loop-nateeexu-tx
//
// Without --env-file the local server is used.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, DB, errText, HOST, ownerToken, subscribe } from './lib.ts';
import type { DisasterRequest } from '../bindings/types.ts';

const MAINCLOUD_DBS = ['triage-loop-nateeexu-dev', 'triage-loop-nateeexu-tx', 'triage-loop-nateeexu-ca'];
const ONLY_REGION = DB.endsWith('-tx') ? 'tx' : DB.endsWith('-ca') ? 'ca' : null; // the sandbox takes either
const IS_LOCAL = /\/\/(127\.0\.0\.1|localhost)\b/.test(HOST);
const TIMEOUT_MS = 15 * 60_000;
const LOADER = resolve(dirname(fileURLToPath(import.meta.url)), 'new-disaster.ts');

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

function load(region: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [LOADER, '--region', region, '--db', DB], {
      stdio: 'inherit',
      env: { ...process.env, SPACETIME_HOST: HOST }, // new-disaster takes the host from the environment only
      timeout: TIMEOUT_MS,
    });
    child.on('error', fail);
    child.on('exit', (code, signal) => {
      if (code === 0) done();
      else fail(new Error(signal ? `loader stopped by ${signal}` : `loader exited with code ${code}`));
    });
  });
}

async function main() {
  if (!IS_LOCAL && !MAINCLOUD_DBS.includes(DB)) {
    console.error(`Refusing to run on ${DB}: on Maincloud this worker only replaces ${MAINCLOUD_DBS.join(', ')}.`);
    process.exit(1);
  }
  const { conn } = await connect(ownerToken());
  const update = (id: bigint, status: string, error = '') => conn.reducers.updateDisasterRequest({ id, status, error });

  let ready = false;
  let chain = Promise.resolve();

  async function handle(row: DisasterRequest) {
    if (ONLY_REGION && row.region !== ONLY_REGION) {
      log(`#${row.id} refused: ${row.region} disaster requested on ${DB}`);
      await update(row.id, 'failed', `This map only loads ${ONLY_REGION === 'tx' ? 'hurricanes' : 'earthquakes'}.`);
      return;
    }
    try {
      await update(row.id, 'running');
    } catch (e) {
      log(`#${row.id} not started: ${errText(e)}`);
      return;
    }
    const started = Date.now();
    log(`#${row.id} loading a random ${row.region} disaster, requested by ${row.requestedBy}`);
    try {
      await load(row.region);
      await update(row.id, 'done');
      log(`#${row.id} done in ${Math.round((Date.now() - started) / 1000)} s`);
    } catch (e) {
      log(`#${row.id} failed: ${errText(e)}`);
      await update(row.id, 'failed', errText(e));
    }
  }

  conn.db.disasterRequest.onInsert((_ctx, row) => {
    if (!ready || row.status !== 'queued') return;
    chain = chain.then(() => handle(row)).catch(e => log(`#${row.id} error: ${errText(e)}`));
  });
  await subscribe(conn, ['SELECT * FROM disaster_request']);
  for (const row of conn.db.disasterRequest.iter()) {
    if (row.status === 'queued' || row.status === 'running') await update(row.id, 'failed', 'The loader restarted. Press the button again.');
  }
  ready = true;
  log(`disaster worker on ${DB} @ ${HOST}`);

  const shutdown = async () => {
    await chain;
    conn.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(e => {
  console.error(errText(e));
  process.exit(1);
});
