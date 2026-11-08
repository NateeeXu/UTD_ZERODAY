// Runs the manager's "New random disaster" button from this Mac. The generator reads data/real and
// loading needs the owner token, so neither can happen in the browser or in a reducer.
// On Maincloud it only accepts the dev database, so a stray click cannot replace a demo region.
// Only requests made after the worker starts are run; older unfinished ones are marked failed.
//
//   node --env-file=.env scripts/disaster-worker.ts --host wss://maincloud.spacetimedb.com --db triage-loop-nateeexu-dev
//
// Without --env-file the local server is used.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, DB, errText, HOST, ownerToken, subscribe } from './lib.ts';
import type { DisasterRequest } from '../bindings/types.ts';

const DEV_DB = 'triage-loop-nateeexu-dev';
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
  if (!IS_LOCAL && DB !== DEV_DB) {
    console.error(`Refusing to run on ${DB}: on Maincloud this worker only replaces ${DEV_DB}.`);
    process.exit(1);
  }
  const { conn } = await connect(ownerToken());
  const update = (id: bigint, status: string, error = '') => conn.reducers.updateDisasterRequest({ id, status, error });

  let ready = false;
  let chain = Promise.resolve();

  async function handle(row: DisasterRequest) {
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
