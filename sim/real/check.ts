// Validates the real-geography bundles (data/real/<region>/*.json) against the shared contract and
// prints a summary per bundle, plus the top silent-severe cells of each live world with nearby real
// facilities. Usage (from sim/): node real/check.ts   Exits non-zero on any failure.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getResolution, greatCircleDistance, isValidCell } from 'h3-js';
import type { EventBundle, Facility, HexCell } from '../../shared/types.ts';
import { OUT_DIR } from './sources.ts';
import { hexStats } from '../src/stats.ts';

const errors: string[] = [];
const fail = (file: string, msg: string) => errors.push(`${file}: ${msg}`);

type T = 'string' | 'number' | 'boolean' | 'object';
type Shape = Record<string, T>;
const HEX_REQ: Shape = { hex: 'string', lat: 'number', lng: 'number', windMph: 'number', floodDepthFt: 'number', towerOutagePct: 'number', analystZone: 'number' };
const HEX_OPT: Shape = { hazardIndex: 'number', shakingMmi: 'number', liquefaction: 'number', tractGeoid: 'string', daytimeWorkers: 'number', residentWorkers: 'number' };
const HH_REQ: Shape = { id: 'string', hex: 'string', lat: 'number', lng: 'number', age65: 'boolean', livesAlone: 'boolean', medicalDevice: 'boolean', windCovered: 'boolean', floodPolicy: 'boolean', earthquakeEndorsement: 'boolean', phoneOnFile: 'boolean', holdout: 'boolean' };
const HH_OPT: Shape = { tractGeoid: 'string', childrenUnder18: 'boolean', awayDaytime: 'boolean', age75: 'boolean', disability: 'boolean', noVehicle: 'boolean', limitedEnglish: 'boolean', primaryLanguage: 'string', mobileHome: 'boolean' };
const FAC_REQ: Shape = { id: 'string', kind: 'string', name: 'string', lat: 'number', lng: 'number', hex: 'string', source: 'string' };
const FAC_OPT: Shape = { enrollment: 'number', capacity: 'number' };
const TRUTH: Shape = { householdId: 'string', damage: 'number', safety: 'string', peril: 'string' };
const EV: Record<string, [Shape, Shape]> = {
  sms_sent: [{ kind: 'string', t: 'number', householdId: 'string' }, {}],
  sms_reply: [{ kind: 'string', t: 'number', householdId: 'string', safety: 'string', damage: 'number' }, { text: 'string', language: 'string' }],
  claim: [{ kind: 'string', t: 'number', householdId: 'string', peril: 'string', reportedDamage: 'number' }, {}],
  field_report: [{ kind: 'string', t: 'number', householdId: 'string', adjusterId: 'string', safety: 'string', damage: 'number' }, {}],
};
const DAMAGES = new Set([0, 1, 2, 3]);

function shape(file: string, what: string, obj: unknown, req: Shape, opt: Shape = {}): boolean {
  if (typeof obj !== 'object' || obj === null) { fail(file, `${what} is not an object`); return false; }
  const o = obj as Record<string, unknown>;
  for (const [k, t] of Object.entries(req)) if (typeof o[k] !== t) { fail(file, `${what}.${k} should be ${t}, got ${typeof o[k]}`); return false; }
  for (const k of Object.keys(o)) {
    if (k in req) continue;
    if (!(k in opt)) { fail(file, `${what} has unexpected key ${k}`); return false; }
    if (typeof o[k] !== opt[k]) { fail(file, `${what}.${k} should be ${opt[k]}`); return false; }
  }
  return true;
}

function validate(file: string, b: EventBundle): void {
  const w = b.world;
  if (Object.keys(b).sort().join() !== 'events,truth,world') fail(file, 'bundle keys mismatch');
  const wk = Object.keys(w).sort().join();
  if (wk !== 'center,dataSources,eventId,facilities,hazardType,hexes,households,landfallIso,name,region') fail(file, `world keys ${wk}`);
  if (Number.isNaN(Date.parse(w.landfallIso))) fail(file, 'bad landfallIso');
  if (!w.region || !w.hazardType || !w.dataSources?.length) fail(file, 'region/hazardType/dataSources missing');
  const isQuake = w.hazardType === 'earthquake';
  const hexSet = new Set<string>();
  for (const [i, c] of w.hexes.entries()) {
    if (!shape(file, `hexes[${i}]`, c, HEX_REQ, HEX_OPT)) break;
    if (!isValidCell(c.hex) || getResolution(c.hex) !== 8) fail(file, `invalid hex ${c.hex}`);
    if (hexSet.has(c.hex)) fail(file, `duplicate hex ${c.hex}`);
    hexSet.add(c.hex);
    if (![0, 1, 2].includes(c.analystZone)) fail(file, `bad analystZone ${c.analystZone}`);
    if (c.towerOutagePct < 0 || c.towerOutagePct > 100) fail(file, `bad outage ${c.towerOutagePct}`);
    if (c.floodDepthFt < 0) fail(file, 'negative flood');
    if (typeof c.hazardIndex !== 'number' || c.hazardIndex < 0 || c.hazardIndex > 1) fail(file, `hazardIndex missing/out of range at ${c.hex}`);
    if (isQuake && (c.windMph !== 0 || c.floodDepthFt !== 0 || typeof c.shakingMmi !== 'number')) fail(file, `quake cell ${c.hex} wind/flood must be 0 and MMI set`);
  }
  if (w.hexes.some((c, i) => i > 0 && w.hexes[i - 1]!.hex >= c.hex)) fail(file, 'hexes not sorted by id');
  for (const [i, f] of (w.facilities ?? []).entries()) {
    if (!shape(file, `facilities[${i}]`, f, FAC_REQ, FAC_OPT)) break;
    if (!['school', 'hospital', 'shelter', 'fire_station'].includes(f.kind)) fail(file, `bad facility kind ${f.kind}`);
    if (!hexSet.has(f.hex)) fail(file, `facility ${f.id} outside world`);
  }
  const ids = new Set<string>();
  for (const [i, h] of w.households.entries()) {
    if (!shape(file, `households[${i}]`, h, HH_REQ, HH_OPT)) break;
    if (ids.has(h.id)) fail(file, `duplicate household ${h.id}`);
    ids.add(h.id);
    if (!hexSet.has(h.hex)) fail(file, `household ${h.id} hex not in world`);
  }
  if (b.truth.length !== w.households.length) fail(file, 'truth rows != households');
  for (const [i, t] of b.truth.entries()) {
    if (!shape(file, `truth[${i}]`, t, TRUTH)) break;
    if (!ids.has(t.householdId)) fail(file, `truth for unknown ${t.householdId}`);
    if (!DAMAGES.has(t.damage)) fail(file, 'bad damage');
    const perils = isQuake ? ['earthquake', 'none'] : ['wind', 'flood', 'none'];
    if (!perils.includes(t.peril)) fail(file, `bad peril ${t.peril}`);
    if ((t.peril === 'none') !== (t.damage === 0)) fail(file, `peril/damage mismatch ${t.householdId}`);
  }
  let prev = -Infinity;
  const sent = new Map<string, number>();
  for (const [i, e] of b.events.entries()) {
    const sh = EV[e.kind];
    if (!sh) { fail(file, `unknown kind ${(e as { kind: string }).kind}`); break; }
    if (!shape(file, `events[${i}]`, e, sh[0], sh[1])) break;
    if (e.t < prev) fail(file, `events not sorted at ${i}`);
    prev = e.t;
    if (!Number.isInteger(e.t) || e.t < 0 || e.t > 4320) fail(file, `bad t ${e.t}`);
    if (!ids.has(e.householdId)) fail(file, `event for unknown ${e.householdId}`);
    if (e.kind === 'sms_sent') sent.set(e.householdId, e.t);
    if (e.kind === 'sms_reply') {
      if (!(sent.has(e.householdId) && sent.get(e.householdId)! <= e.t)) fail(file, `reply without sms_sent ${e.householdId}`);
      if (!DAMAGES.has(e.damage) || !['safe', 'needs_help'].includes(e.safety)) fail(file, 'bad sms_reply');
      if ((e.text === undefined) !== (e.language === undefined)) fail(file, 'text/language must come together');
    }
    if (e.kind === 'claim' && (!DAMAGES.has(e.reportedDamage) || !(isQuake ? ['earthquake'] : ['wind', 'flood']).includes(e.peril))) fail(file, `bad claim ${JSON.stringify(e)}`);
    if (e.kind === 'field_report' && (!DAMAGES.has(e.damage) || !['safe', 'needs_help', 'unsure'].includes(e.safety))) fail(file, 'bad field_report');
  }
  const hold = w.households.filter((h) => h.holdout).length / w.households.length;
  if (Math.abs(hold - 0.15) > 0.01) fail(file, `holdout share ${hold.toFixed(3)}`);
  const holdIds = new Set(w.households.filter((h) => h.holdout).map((h) => h.id));
  const fr = b.events.filter((e) => e.kind === 'field_report');
  if (w.eventId === 'live' && fr.length) fail(file, `live has ${fr.length} field reports`);
  if (w.eventId !== 'live' && !fr.length) fail(file, 'backtest without field reports');
  if (fr.some((e) => holdIds.has(e.householdId))) fail(file, 'field report on a holdout household');
}

/** Silent severe: high hazard (hazardIndex >= 0.5), outage >= 80%, reply rate < 10%, truth severe/needs-help share > 40%. */
function silentSevere(b: EventBundle) {
  const stats = hexStats(b);
  const out = [];
  for (const c of b.world.hexes) {
    const s = stats.get(c.hex)!;
    const rr = s.smsSent ? s.smsReplies / s.smsSent : 0;
    const sev = s.households ? s.severeOrNeedsHelp / s.households : 0;
    if ((c.hazardIndex ?? 0) >= 0.5 && c.towerOutagePct >= 80 && rr < 0.1 && sev > 0.4 && s.households >= 5) out.push({ c, s });
  }
  return out.sort((a, b) => b.s.severeOrNeedsHelp - a.s.severeOrNeedsHelp);
}

function nearby(fac: Facility[], c: HexCell, km = 2.5, n = 4): string {
  const ranked = fac.map((f) => ({ f, d: greatCircleDistance([c.lat, c.lng], [f.lat, f.lng], 'km') }))
    .filter((x) => x.d <= km)
    .sort((a, b) => (a.f.kind === 'school' ? 0 : 1) - (b.f.kind === 'school' ? 0 : 1) || a.d - b.d);
  const pick = [...ranked.filter((x) => x.f.kind === 'school').slice(0, 2), ...ranked.filter((x) => x.f.kind !== 'school').slice(0, n - 2)];
  return pick.map((x) => `${x.f.name} (${x.f.kind}${x.f.enrollment ? `, ${x.f.enrollment} students` : ''}, ${x.d.toFixed(1)} km)`).join('; ');
}

let total = 0;
const regions = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((d) => statSync(join(OUT_DIR, d)).isDirectory()).sort() : [];
if (!regions.length) { console.error('no data/real/<region> folders; run npm run real:tx / real:ca'); process.exit(1); }
for (const region of regions) {
  const dir = join(OUT_DIR, region);
  const files = readdirSync(dir).filter((f) => /^(live|backtest-\d+)\.json$/.test(f)).sort((a, b) => (a === 'live.json' ? -1 : b === 'live.json' ? 1 : a < b ? -1 : 1));
  const rows: Record<string, string | number>[] = [];
  let live: EventBundle | null = null;
  for (const f of files) {
    const path = join(dir, f);
    const bytes = statSync(path).size;
    total += bytes;
    const b = JSON.parse(readFileSync(path, 'utf8')) as EventBundle;
    const name = `${region}/${f}`;
    validate(name, b);
    if (b.world.eventId === 'live') live = b;
    const n = b.truth.length;
    const dmg = [0, 0, 0, 0];
    for (const t of b.truth) dmg[t.damage]!++;
    const cnt = (k: string) => b.events.filter((e) => e.kind === k).length;
    const replies = b.events.filter((e) => e.kind === 'sms_reply');
    const withText = replies.filter((e) => e.kind === 'sms_reply' && e.text).length;
    const hi = b.world.hexes.map((c) => c.hazardIndex ?? 0);
    rows.push({
      event: b.world.eventId, MB: +(bytes / 1e6).toFixed(1), hh: n, cells: b.world.hexes.length,
      'hh/cell': Math.round(n / b.world.hexes.length),
      'dmg0/1/2/3 %': dmg.map((d) => Math.round((100 * d) / n)).join('/'),
      needsHelp: b.truth.filter((t) => t.safety === 'needs_help').length,
      'hazIdx mean/max': `${(hi.reduce((a, v) => a + v, 0) / hi.length).toFixed(2)}/${Math.max(...hi).toFixed(2)}`,
      'reply%': +((100 * replies.length) / cnt('sms_sent')).toFixed(1),
      texts: withText, claims: cnt('claim'), fieldRep: cnt('field_report'), silent: silentSevere(b).length,
    });
  }
  console.log(`\n== ${region}`);
  console.table(rows);
  if (live) {
    const hh = live.world.households;
    const share = (f: (h: (typeof hh)[number]) => boolean | undefined) => `${((100 * hh.filter((h) => f(h)).length) / hh.length).toFixed(1)}%`;
    const langs: Record<string, number> = {};
    for (const h of hh) langs[h.primaryLanguage ?? '?'] = (langs[h.primaryLanguage ?? '?'] ?? 0) + 1;
    console.log(`live household attributes: age65 ${share((h) => h.age65)}, age75 ${share((h) => h.age75)}, alone ${share((h) => h.livesAlone)}, kids ${share((h) => h.childrenUnder18)}, disability ${share((h) => h.disability)}, noVehicle ${share((h) => h.noVehicle)}, limitedEnglish ${share((h) => h.limitedEnglish)}, mobileHome ${share((h) => h.mobileHome)}, awayDaytime ${share((h) => h.awayDaytime)}, floodPolicy ${share((h) => h.floodPolicy)}, quakeEndorsement ${share((h) => h.earthquakeEndorsement)}`);
    console.log(`languages: ${Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${((100 * v) / hh.length).toFixed(1)}%`).join(', ')}`);
    const fac = live.world.facilities ?? [];
    const kinds: Record<string, number> = {};
    for (const f of fac) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
    console.log(`facilities: ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    const sample = live.events.filter((e) => e.kind === 'sms_reply' && e.text).slice(0, 400);
    const byLang = new Map<string, string>();
    for (const e of sample) if (e.kind === 'sms_reply' && !byLang.has(e.language!)) byLang.set(e.language!, `[${e.language}] safety=${e.safety} damage=${e.damage}: "${e.text}"`);
    console.log('sample free-text replies:\n  ' + [...byLang.values()].join('\n  '));
    const silent = silentSevere(live).slice(0, 8);
    console.log(`\nlive silent-severe cells (top ${silent.length}):`);
    console.table(silent.map(({ c, s }) => ({
      hex: c.hex, hazIdx: c.hazardIndex, ...(live!.world.hazardType === 'earthquake' ? { mmi: c.shakingMmi, liq: c.liquefaction } : { wind: c.windMph, flood: c.floodDepthFt }),
      outage: c.towerOutagePct, zone: c.analystZone, hh: s.households, sent: s.smsSent, replies: s.smsReplies, claims: s.claims, severe: s.severeOrNeedsHelp,
    })));
    for (const { c } of silent.slice(0, 5)) console.log(`  ${c.hex} (${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}): ${nearby(fac, c) || 'no facility within 2.5 km'}`);
  }
}
console.log(`\nTotal data/real size: ${(total / 1e6).toFixed(1)} MB`);
if (errors.length) {
  console.error(`\n${errors.length} validation error(s):`);
  for (const e of errors.slice(0, 50)) console.error('  ' + e);
  process.exit(1);
}
console.log('All checks passed.');
