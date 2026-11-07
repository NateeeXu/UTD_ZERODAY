// Node-only helpers for the scripts: file loading, argument parsing, tables.
// Nothing in engine/src imports this file.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventBundle, ModelParams, TruthRow } from '../../shared/types.ts';

export const ENGINE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_DIR = dirname(ENGINE_DIR);
export const DEFAULT_DATA_DIR = join(REPO_DIR, 'data');

export interface CliArgs {
  positional: string[];
  flags: Map<string, string>;
}

/** `node script.ts [positional...] [--key=value | --key value | --flag]` */
export function parseArgs(argv: readonly string[]): CliArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags.set(a.slice(2), argv[++i]);
      else flags.set(a.slice(2), 'true');
    } else positional.push(a);
  }
  return { positional, flags };
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/** Minimal structural check so a malformed file fails loudly, not deep inside the engine. */
export function assertBundle(b: unknown, label: string): asserts b is EventBundle {
  const x = b as Partial<EventBundle>;
  if (!x || typeof x !== 'object') throw new Error(`${label}: not an object`);
  if (!x.world || !Array.isArray(x.world.hexes) || !Array.isArray(x.world.households)) {
    throw new Error(`${label}: missing world.hexes / world.households`);
  }
  if (!Array.isArray(x.events)) throw new Error(`${label}: missing events`);
  if (!Array.isArray(x.truth)) throw new Error(`${label}: missing truth`);
  if (typeof x.world.eventId !== 'string') throw new Error(`${label}: world.eventId missing`);
}

export function loadBundle(path: string): EventBundle {
  if (!existsSync(path)) throw new Error(`bundle not found: ${path}`);
  const b = readJson<unknown>(path);
  assertBundle(b, path);
  return b;
}

/** All backtest bundles in <dataDir>/backtest, sorted by file name (natural order for -1..-6). */
export function loadBacktests(dataDir: string): EventBundle[] {
  const dir = join(dataDir, 'backtest');
  if (!existsSync(dir)) throw new Error(`no backtest directory at ${dir}`);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (files.length === 0) throw new Error(`no *.json files in ${dir}`);
  return files.map((f) => loadBundle(join(dir, f)));
}

export function loadModel(path: string): ModelParams {
  if (!existsSync(path)) throw new Error(`model not found: ${path} (run calibrate first)`);
  return readJson<ModelParams>(path);
}

export function truthMap(truth: readonly TruthRow[]): Map<string, TruthRow> {
  const m = new Map<string, TruthRow>();
  for (const r of truth) {
    if (m.has(r.householdId)) throw new Error(`duplicate truth row for ${r.householdId}`);
    m.set(r.householdId, r);
  }
  return m;
}

export function resolveDataDir(args: CliArgs): string {
  return resolve(args.positional[0] ?? DEFAULT_DATA_DIR);
}

// ---------- formatting ----------

export function fmt(x: number | null | undefined, digits = 3): string {
  if (x === null || x === undefined || Number.isNaN(x)) return 'n/a';
  return x.toFixed(digits);
}

export function pct(x: number, digits = 0): string {
  return Number.isNaN(x) ? 'n/a' : (100 * x).toFixed(digits) + '%';
}

export function minutesLabel(t: number): string {
  return t % 60 === 0 ? `${t / 60}h` : `${t}m`;
}

/** Fixed-width text table; numbers right-aligned. */
export function table(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const cells = rows.map((r) => r.map((c) => (typeof c === 'number' ? fmt(c) : c)));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] ?? '').length)));
  const line = (r: readonly string[]): string =>
    r
      .map((c, i) => {
        const isNum = /^-?\d/.test(c) || c === 'n/a';
        return isNum ? c.padStart(widths[i]) : c.padEnd(widths[i]);
      })
      .join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(headers), sep, ...cells.map(line)].join('\n');
}

export function heading(s: string): string {
  return `\n== ${s} ==`;
}
