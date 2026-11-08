// Replies to the demo notices, read from this Mac's Messages database (read-only), because Apple has no API.
// Needs Full Disk Access for the app that runs the bridge. Only messages newer than the start and from the one
// demo number are looked at; message text is passed on to the reply path and never logged.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db');
const POLL_MS = 1500;
const DUPLICATE_MS = 3000; // a chat with yourself can deliver the same text twice

type Row = { id: number; text: string | null; body: string | null };

async function query<T>(sql: string): Promise<T[]> {
  const { stdout } = await run('/usr/bin/sqlite3', ['-readonly', '-json', CHAT_DB, sql], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim() ? (JSON.parse(stdout) as T[]) : [];
}

/** Message text when the `text` column is empty: newer macOS keeps it in a typedstream blob after "NSString". */
export function textFromAttributedBody(hex: string): string {
  const blob = Buffer.from(hex, 'hex');
  const marker = blob.indexOf('NSString');
  if (marker < 0) return '';
  let at = marker + 'NSString'.length + 5; // 5 bytes of class data, then the length
  let length = blob[at++];
  if (length === 0x81) {
    length = blob.readUInt16LE(at);
    at += 2;
  } else if (length === 0x82) {
    length = blob.readUInt32LE(at);
    at += 4;
  }
  return blob.subarray(at, at + length).toString('utf8');
}

/** The bridge's own notice coming back, when the demo number is this Mac's own account. */
const isOwnNotice = (text: string) => /^Adjuster .+ has been assigned to /.test(text);

/** Calls onReply for each new message from `from`. Returns false if the database cannot be read. */
export async function startInbox(from: string, onReply: (text: string) => Promise<void>, log: (msg: string) => void): Promise<boolean> {
  const handle = from.replace(/'/g, "''");
  let last: number;
  try {
    last = (await query<{ id: number }>('SELECT COALESCE(MAX(ROWID), 0) AS id FROM message'))[0].id;
  } catch {
    log('Cannot read the Messages database, so replies are off. Give Full Disk Access to the app running the bridge.');
    return false;
  }
  let lastText = '';
  let lastAt = 0;
  const poll = async () => {
    try {
      const rows = await query<Row>(
        `SELECT m.ROWID AS id, m.text AS text, hex(m.attributedBody) AS body FROM message m JOIN handle h ON m.handle_id = h.ROWID
         WHERE m.ROWID > ${last} AND h.id = '${handle}' AND m.is_from_me = 0 AND m.associated_message_type = 0 ORDER BY m.ROWID`,
      );
      for (const row of rows) {
        last = row.id;
        const text = (row.text || (row.body ? textFromAttributedBody(row.body) : '')).replace(/￼/g, '').trim();
        if (!text || isOwnNotice(text)) continue;
        if (text === lastText && Date.now() - lastAt < DUPLICATE_MS) continue;
        lastText = text;
        lastAt = Date.now();
        await onReply(text.slice(0, 500));
      }
    } catch (e) {
      log(`inbox: ${e instanceof Error ? e.message.slice(0, 120) : 'read failed'}`);
    }
    setTimeout(poll, POLL_MS);
  };
  void poll();
  log('reading replies from the demo number');
  return true;
}
