// Validates every generated bundle against the shared contract and prints a summary table.
// Usage: node src/check.ts   (from sim/). Exits non-zero on any failure.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getResolution, isValidCell } from 'h3-js';
import type { EventBundle } from '../../shared/types.ts';
import { H3_RESOLUTION } from './config.ts';
import { silentSevereCells } from './stats.ts';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const errors: string[] = [];
const fail = (file: string, msg: string) => errors.push(`${file}: ${msg}`);

type Shape = Record<string, 'string' | 'number' | 'boolean' | 'object'>;
const HEX_SHAPE: Shape = { hex: 'string', lat: 'number', lng: 'number', windMph: 'number', floodDepthFt: 'number', towerOutagePct: 'number', analystZone: 'number' };
const HH_SHAPE: Shape = { id: 'string', hex: 'string', lat: 'number', lng: 'number', age65: 'boolean', livesAlone: 'boolean', medicalDevice: 'boolean', windCovered: 'boolean', floodPolicy: 'boolean', earthquakeEndorsement: 'boolean', phoneOnFile: 'boolean', holdout: 'boolean' };
const TRUTH_SHAPE: Shape = { householdId: 'string', damage: 'number', safety: 'string', peril: 'string' };
const EVENT_SHAPES: Record<string, Shape> = {
  sms_sent: { kind: 'string', t: 'number', householdId: 'string' },
  sms_reply: { kind: 'string', t: 'number', householdId: 'string', safety: 'string', damage: 'number' },
  claim: { kind: 'string', t: 'number', householdId: 'string', peril: 'string', reportedDamage: 'number' },
  field_report: { kind: 'string', t: 'number', householdId: 'string', adjusterId: 'string', safety: 'string', damage: 'number' },
};
const DAMAGES = new Set([0, 1, 2, 3]);

function checkShape(file: string, what: string, obj: unknown, shape: Shape): boolean {
  if (typeof obj !== 'object' || obj === null) { fail(file, `${what} is not an object`); return false; }
  const o = obj as Record<string, unknown>;
  const keys = Object.keys(o);
  for (const [k, t] of Object.entries(shape)) {
    if (typeof o[k] !== t) { fail(file, `${what}.${k} should be ${t}, got ${typeof o[k]}`); return false; }
  }
  const extra = keys.filter((k) => !(k in shape));
  if (extra.length) { fail(file, `${what} has unexpected keys ${extra.join(',')}`); return false; }
  return true;
}

function validate(file: string, b: EventBundle, isLive: boolean): void {
  const w = b.world;
  checkShape(file, 'world', { eventId: w.eventId, name: w.name, landfallIso: w.landfallIso, center: w.center },
    { eventId: 'string', name: 'string', landfallIso: 'string', center: 'object' });
  if (Object.keys(w).sort().join() !== 'center,eventId,hexes,households,landfallIso,name') fail(file, 'world keys mismatch');
  if (Object.keys(b).sort().join() !== 'events,truth,world') fail(file, 'bundle keys mismatch');
  if (Number.isNaN(Date.parse(w.landfallIso))) fail(file, 'landfallIso not a valid date');

  const hexSet = new Set<string>();
  for (const [i, c] of w.hexes.entries()) {
    if (!checkShape(file, `hexes[${i}]`, c, HEX_SHAPE)) break;
    if (!isValidCell(c.hex) || getResolution(c.hex) !== H3_RESOLUTION) fail(file, `invalid hex ${c.hex}`);
    if (hexSet.has(c.hex)) fail(file, `duplicate hex ${c.hex}`);
    hexSet.add(c.hex);
    if (![0, 1, 2].includes(c.analystZone)) fail(file, `bad analystZone ${c.analystZone}`);
    if (c.towerOutagePct < 0 || c.towerOutagePct > 100) fail(file, `bad outage ${c.towerOutagePct}`);
    if (c.floodDepthFt < 0) fail(file, `negative flood ${c.floodDepthFt}`);
  }
  const hhIds = new Set<string>();
  for (const [i, h] of w.households.entries()) {
    if (!checkShape(file, `households[${i}]`, h, HH_SHAPE)) break;
    if (hhIds.has(h.id)) fail(file, `duplicate household ${h.id}`);
    hhIds.add(h.id);
    if (!hexSet.has(h.hex)) fail(file, `household ${h.id} hex ${h.hex} not in world.hexes`);
  }
  if (b.truth.length !== w.households.length) fail(file, `truth rows ${b.truth.length} != households ${w.households.length}`);
  for (const [i, t] of b.truth.entries()) {
    if (!checkShape(file, `truth[${i}]`, t, TRUTH_SHAPE)) break;
    if (!hhIds.has(t.householdId)) fail(file, `truth for unknown household ${t.householdId}`);
    if (!DAMAGES.has(t.damage)) fail(file, `bad truth damage ${t.damage}`);
    if (t.safety !== 'safe' && t.safety !== 'needs_help') fail(file, `bad truth safety ${t.safety}`);
    if (!['wind', 'flood', 'none'].includes(t.peril)) fail(file, `bad peril ${t.peril}`);
    if ((t.peril === 'none') !== (t.damage === 0)) fail(file, `peril/damage mismatch for ${t.householdId}`);
  }
  let prevT = -Infinity;
  for (const [i, e] of b.events.entries()) {
    const shape = EVENT_SHAPES[e.kind];
    if (!shape) { fail(file, `unknown event kind ${(e as { kind: string }).kind}`); break; }
    if (!checkShape(file, `events[${i}]`, e, shape)) break;
    if (e.t < prevT) fail(file, `events not sorted at index ${i}`);
    prevT = e.t;
    if (e.t < 0 || e.t > 4320 || !Number.isInteger(e.t)) fail(file, `bad t ${e.t}`);
    if (!hhIds.has(e.householdId)) fail(file, `event for unknown household ${e.householdId}`);
    if (e.kind === 'sms_reply' && (!DAMAGES.has(e.damage) || !['safe', 'needs_help'].includes(e.safety))) fail(file, `bad sms_reply ${JSON.stringify(e)}`);
    if (e.kind === 'claim' && (!DAMAGES.has(e.reportedDamage) || !['wind', 'flood'].includes(e.peril))) fail(file, `bad claim ${JSON.stringify(e)}`);
    if (e.kind === 'field_report' && (!DAMAGES.has(e.damage) || !['safe', 'needs_help', 'unsure'].includes(e.safety))) fail(file, `bad field_report ${JSON.stringify(e)}`);
  }
  // Every reply must follow an sms_sent to the same household.
  const sent = new Map<string, number>();
  for (const e of b.events) {
    if (e.kind === 'sms_sent') sent.set(e.householdId, e.t);
    if (e.kind === 'sms_reply' && !(sent.has(e.householdId) && sent.get(e.householdId)! <= e.t)) fail(file, `reply without prior sms_sent ${e.householdId}`);
  }
  const holdoutShare = w.households.filter((h) => h.holdout).length / w.households.length;
  if (Math.abs(holdoutShare - 0.15) > 0.02) fail(file, `holdout share ${holdoutShare.toFixed(3)}`);
  const fr = b.events.filter((e) => e.kind === 'field_report').length;
  if (isLive && fr > 0) fail(file, `live bundle has ${fr} field_report events`);
  if (!isLive && fr === 0) fail(file, 'backtest bundle has no field_report events');
}

const files = [join(DATA_DIR, 'live.json'), ...readdirSync(join(DATA_DIR, 'backtest')).filter((f) => f.endsWith('.json')).sort().map((f) => join(DATA_DIR, 'backtest', f))];
const rows: Record<string, string | number>[] = [];
let totalBytes = 0;
const liveSilent: ReturnType<typeof silentSevereCells> = [];
for (const path of files) {
  const name = path.replace(DATA_DIR + '/', '');
  const bytes = statSync(path).size;
  totalBytes += bytes;
  const b = JSON.parse(readFileSync(path, 'utf8')) as EventBundle;
  const isLive = b.world.eventId === 'live';
  validate(name, b, isLive);
  const dmg = [0, 0, 0, 0];
  for (const t of b.truth) dmg[t.damage]!++;
  const n = b.truth.length;
  const count = (k: string) => b.events.filter((e) => e.kind === k).length;
  const sent = count('sms_sent');
  const replied = count('sms_reply');
  const silent = silentSevereCells(b);
  if (isLive) liveSilent.push(...silent);
  rows.push({
    event: b.world.eventId,
    MB: +(bytes / 1e6).toFixed(2),
    hh: n,
    cells: b.world.hexes.length,
    'dmg0/1/2/3 %': dmg.map((d) => Math.round((100 * d) / n)).join('/'),
    needsHelp: b.truth.filter((t) => t.safety === 'needs_help').length,
    holdout: b.world.households.filter((h) => h.holdout).length,
    smsSent: sent,
    replies: replied,
    'reply%': +((100 * replied) / sent).toFixed(1),
    claims: count('claim'),
    fieldRep: count('field_report'),
    silentCells: silent.length,
  });
}
console.table(rows);
console.log(`Total data size: ${(totalBytes / 1e6).toFixed(2)} MB`);
console.log('\nLive silent-severe cells (top 8 by truly severe/needs-help households):');
console.table(liveSilent.sort((a, b) => b.severeOrNeedsHelp - a.severeOrNeedsHelp).slice(0, 8).map((s) => ({
  hex: s.hex, wind: s.windMph, flood: s.floodDepthFt, outage: s.towerOutagePct, zone: s.analystZone,
  hh: s.households, sent: s.smsSent, replies: s.smsReplies, claims: s.claims, severeOrNeedsHelp: s.severeOrNeedsHelp,
})));
if (errors.length) {
  console.error(`\n${errors.length} validation error(s):`);
  for (const e of errors.slice(0, 50)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nAll checks passed.');
