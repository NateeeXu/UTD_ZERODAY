// Shared helpers for the Node scripts (Node >= 22.18 / 24 runs .ts directly via type stripping).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DbConnection } from '../bindings/index.ts';
import type { Identity } from 'spacetimedb';

const argv = process.argv.slice(2);
const argOf = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

// Target: --host / --db flags, else SPACETIME_HOST / SPACETIME_DB, else the local server and `triage-loop`.
export const HOST = argOf('--host') ?? process.env.SPACETIME_HOST ?? 'ws://127.0.0.1:3000';
export const DB = argOf('--db') ?? process.env.SPACETIME_DB ?? 'triage-loop';

// Demo passcodes. The repo is public, so the defaults are public too: set your own via env for Maincloud.
export const STAFF_PASSCODE = process.env.STAFF_PASSCODE ?? 'triage-staff';
export const REPLY_PASSCODE = process.env.REPLY_PASSCODE ?? 'triage-reply';

/**
 * Token of the module owner. The owner is whoever published the module, i.e. the identity the
 * `spacetime` CLI is logged in as. Override with SPACETIME_TOKEN.
 */
export function ownerToken(): string {
  if (process.env.SPACETIME_TOKEN) return process.env.SPACETIME_TOKEN;
  const path = join(homedir(), '.config', 'spacetime', 'cli.toml');
  if (!existsSync(path)) throw new Error(`no SPACETIME_TOKEN and no ${path}; run \`spacetime login\``);
  const m = readFileSync(path, 'utf8').match(/^spacetimedb_token\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error(`spacetimedb_token not found in ${path}`);
  return m[1];
}

export interface Connected {
  conn: DbConnection;
  identity: Identity;
  token: string;
}

/** Connect with a token (owner) or anonymously (a fresh identity is minted by the server). */
export function connect(token?: string): Promise<Connected> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(DB)
      .withToken(token)
      .onConnect((conn, identity, tok) => resolve({ conn, identity, token: tok }))
      .onConnectError((_ctx, err) => reject(err))
      .build();
  });
}

/** Subscribe and resolve once the initial rows are in the client cache. */
export function subscribe(conn: DbConnection, queries: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    conn
      .subscriptionBuilder()
      .onApplied(() => resolve())
      .onError(ctx => reject((ctx as { event?: unknown }).event ?? new Error('subscription error')))
      .subscribe(queries);
  });
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function chunks<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
