// Sends "adjuster assigned" notices as real iMessages from this Mac's Messages app, to one demo phone.
// Apple has no public API for this. All households are synthetic, so every notice goes to the one number
// set in the environment; the recipient never comes from the database. One-way: iMessage replies are not read.
// Only notices created after the bridge starts are sent, at most MAX_SENDS per run.
//
//   IMESSAGE_DEMO_TO=<phone or Apple ID> node --env-file=.env scripts/imessage-bridge.ts [--db X] [--host Y]
//   ... --dry-run   prints what it would send, sends nothing and marks nothing
//
// Joins as a manager with STAFF_PASSCODE (env).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect, DB, errText, HOST, STAFF_PASSCODE, subscribe } from './lib.ts';
import type { ImessageOutbox } from '../bindings/types.ts';

const run = promisify(execFile);
const DRY_RUN = process.argv.includes('--dry-run');
const TO = process.env.IMESSAGE_DEMO_TO ?? '';
const MAX_SENDS = 200;

// Recipient and text are passed as arguments, so message text is never parsed as AppleScript.
const APPLESCRIPT = [
  'on run argv',
  'tell application "Messages"',
  'set svc to 1st account whose service type = iMessage',
  'send (item 2 of argv) to participant (item 1 of argv) of svc',
  'end tell',
  'end run',
];

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const masked = TO.length > 4 ? `***${TO.slice(-4)}` : '***';

function sendImessage(text: string) {
  const args = APPLESCRIPT.flatMap(line => ['-e', line]);
  return run('/usr/bin/osascript', [...args, TO, text], { timeout: 15_000 });
}

async function main() {
  if (!TO && !DRY_RUN) {
    console.error('IMESSAGE_DEMO_TO is not set. Use --dry-run to test without sending.');
    process.exit(1);
  }
  const { conn } = await connect();
  await conn.reducers.joinAs({ role: 'manager', name: 'iMessage bridge', passcode: STAFF_PASSCODE });

  let ready = false;
  let sends = 0;
  let chain = Promise.resolve();

  async function handle(row: ImessageOutbox) {
    if (DRY_RUN) {
      log(`dry run #${row.id} ${row.householdId}: ${row.text}`);
      return;
    }
    if (sends >= MAX_SENDS) {
      log(`#${row.id} skipped: limit of ${MAX_SENDS} sends reached`);
      return;
    }
    sends++;
    try {
      await sendImessage(row.text);
      await conn.reducers.markImessage({ id: row.id, status: 'sent', error: '' });
      log(`#${row.id} ${row.householdId} sent to ${masked}`);
    } catch (e) {
      const error = errText(e).slice(0, 200);
      log(`#${row.id} ${row.householdId} failed: ${error}`);
      await conn.reducers.markImessage({ id: row.id, status: 'failed', error });
    }
  }

  conn.db.imessageOutbox.onInsert((_ctx, row) => {
    if (!ready || row.status !== 'queued') return;
    chain = chain.then(() => handle(row)).catch(e => log(`#${row.id} error: ${errText(e)}`));
  });
  await subscribe(conn, ["SELECT * FROM imessage_outbox WHERE status = 'queued'"]);
  ready = true;
  log(`iMessage bridge on ${DB} @ ${HOST}${DRY_RUN ? ' (dry run)' : `, sending to ${masked}`}`);

  const shutdown = async () => {
    await chain;
    try {
      await conn.reducers.leave({});
    } catch {
      // already gone
    }
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
