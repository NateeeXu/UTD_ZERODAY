// Claude parser worker: reply_inbox (status = 'pending') -> parseReply -> submit_parsed_reply
// (+ report_member_missing) -> mark_reply_parsed. One reply at a time, one log line per reply.
//
//   node --env-file=.env scripts/claude-worker.ts                      # SPACETIME_HOST / SPACETIME_DB from .env
//   node --env-file=.env scripts/claude-worker.ts --host ws://127.0.0.1:3000 --db triage-loop
//   ... --once        process the replies pending now, then exit
//   ... --no-claude   degraded mode without the API: every reply falls back to "a person calls back"
//                     (needs_help, no life safety) and the keyword net still escalates danger words
//
// Joins as a manager with STAFF_PASSCODE (env). The Anthropic key is read from ANTHROPIC_API_KEY only and
// is never logged; reply text is not logged either (length only).
import { connect, DB, errText, HOST, STAFF_PASSCODE, subscribe } from './lib.ts';
import { disabledCreate, MODEL, parseReply, PROMPT_VERSION, toReducerArgs, type ParsedReply } from './parser.ts';
import type { ReplyInbox } from '../bindings/types.ts';

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const NO_CLAUDE = args.includes('--no-claude');

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const yn = (b: boolean) => (b ? 'Y' : 'N');

function line(row: ReplyInbox, p: ParsedReply, status: string, note: string): string {
  return [
    `#${row.id}`,
    row.householdId,
    status,
    `safety=${p.safety}`,
    `life=${yn(p.life_safety)}`,
    `dmg=${p.damage ?? '?'}`,
    `needs=${p.needs.join('+') || '-'}`,
    `notHome=${yn(p.not_home)}`,
    `missing=${yn(p.missing_people)}`,
    `lang=${p.language || row.language || '?'}`,
    `conf=${p.confidence.toFixed(2)}`,
    `net=${p.keyword_hits.join('+') || '-'}`,
    `len=${[...row.text].length}`,
    `${p.latency_ms}ms`,
    note ? `| ${note}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

async function main() {
  if (!NO_CLAUDE && !process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set (add it to spacetimedb/.env, which is gitignored). Use --no-claude for the degraded mode.');
    process.exit(1);
  }
  const { conn, identity } = await connect();
  await conn.reducers.joinAs({ role: 'manager', name: 'Claude parser', passcode: STAFF_PASSCODE });
  log(`worker on ${DB} @ ${HOST} as manager ${identity.toHexString().slice(0, 12)}; model ${NO_CLAUDE ? 'disabled (--no-claude)' : MODEL}, prompt ${PROMPT_VERSION}`);

  const queue: ReplyInbox[] = [];
  const inFlight = new Set<bigint>(); // queued or being processed
  let draining = false;
  let stopping = false;
  let idle: (() => void) | null = null;

  async function handle(row: ReplyInbox) {
    const p = await parseReply(row.text, NO_CLAUDE ? { create: disabledCreate } : {});
    const a = toReducerArgs(p, row.text, row.language);
    let status: 'parsed' | 'failed' = p.error ? 'failed' : 'parsed';
    let note = p.error ? `parser: ${p.error}; fallback submitted` : p.review.length ? `review: ${p.review.join(',')}` : '';
    try {
      await conn.reducers.submitParsedReply({
        householdId: row.householdId,
        safety: a.safety,
        damage: a.damage,
        lifeSafety: a.lifeSafety,
        needs: a.needs,
        notHome: a.notHome,
        text: a.text,
        language: a.language,
        passcode: '',
      });
      if (a.reportMissing) await conn.reducers.reportMemberMissing({ householdId: row.householdId, passcode: '' });
    } catch (e) {
      status = 'failed';
      note = `submit: ${errText(e)}`;
    }
    try {
      await conn.reducers.markReplyParsed({ id: row.id, status, error: note });
    } catch (e) {
      note += ` | mark_reply_parsed: ${errText(e)}`;
    }
    log(line(row, p, status, note));
  }

  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length > 0 && !stopping) {
      const row = queue.shift()!;
      try {
        await handle(row);
      } catch (e) {
        log(`#${row.id} ${row.householdId} error: ${errText(e)}`);
      } finally {
        inFlight.delete(row.id);
      }
    }
    draining = false;
    idle?.();
  }

  const enqueue = (row: ReplyInbox) => {
    if (row.status !== 'pending' || inFlight.has(row.id) || stopping) return;
    inFlight.add(row.id);
    queue.push(row);
    queue.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    void drain();
  };

  conn.db.replyInbox.onInsert((_ctx, row) => enqueue(row));
  await subscribe(conn, ["SELECT * FROM reply_inbox WHERE status = 'pending'"]);
  for (const row of conn.db.replyInbox.iter()) enqueue(row);
  log(`${inFlight.size} pending at start${ONCE ? ' (--once)' : ''}`);

  const shutdown = async (code: number) => {
    stopping = true;
    if (draining) await new Promise<void>(r => (idle = r));
    try {
      await conn.reducers.leave({});
    } catch {
      // best effort: the member row is only a label
    }
    conn.disconnect();
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  if (ONCE) {
    if (draining || queue.length > 0) await new Promise<void>(r => (idle = r));
    await shutdown(0);
  }
}

main().catch(e => {
  console.error(`worker failed: ${errText(e)}`);
  process.exit(1);
});
