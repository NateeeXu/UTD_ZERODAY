import { locationAt } from '../src/needs.ts';
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

type T = 'string' | 'number' | 'boolean' | 'object' | 'number|null';
type Shape = Record<string, T>;
const HEX_REQ: Shape = { hex: 'string', lat: 'number', lng: 'number', windMph: 'number', floodDepthFt: 'number', towerOutagePct: 'number', analystZone: 'number' };
const HEX_OPT: Shape = { hazardIndex: 'number', shakingMmi: 'number', liquefaction: 'number', tractGeoid: 'string', daytimeWorkers: 'number', residentWorkers: 'number', k12Enrollment: 'number', collegeEnrollment: 'number' };
const HH_REQ: Shape = { id: 'string', hex: 'string', lat: 'number', lng: 'number', age65: 'boolean', livesAlone: 'boolean', medicalDevice: 'boolean', windCovered: 'boolean', floodPolicy: 'boolean', earthquakeEndorsement: 'boolean', phoneOnFile: 'boolean', holdout: 'boolean' };
const HH_OPT: Shape = { tractGeoid: 'string', childrenUnder18: 'boolean', awayDaytime: 'boolean', age75: 'boolean', disability: 'boolean', noVehicle: 'boolean', limitedEnglish: 'boolean', primaryLanguage: 'string', mobileHome: 'boolean', policyType: 'string', schoolAgeChildren: 'number', collegeStudent: 'boolean', nearestSchoolId: 'string' };
const FAC_REQ: Shape = { id: 'string', kind: 'string', name: 'string', lat: 'number', lng: 'number', hex: 'string', source: 'string' };
const FAC_OPT: Shape = { enrollment: 'number', capacity: 'number' };
const TRUTH: Shape = { householdId: 'string', damage: 'number', safety: 'string', peril: 'string', needType: 'string', location: 'string' };
const EV: Record<string, [Shape, Shape]> = {
  sms_sent: [{ kind: 'string', t: 'number', householdId: 'string' }, {}],
  sms_reply: [{ kind: 'string', t: 'number', householdId: 'string', safety: 'string', damage: 'number|null', lifeSafety: 'boolean', needs: 'object', notHome: 'boolean', channel: 'string' }, { text: 'string', language: 'string' }],
  claim: [{ kind: 'string', t: 'number', householdId: 'string', peril: 'string', reportedDamage: 'number' }, {}],
  field_report: [{ kind: 'string', t: 'number', householdId: 'string', adjusterId: 'string', safety: 'string', damage: 'number' }, {}],
};
const DAMAGES = new Set([0, 1, 2, 3]);
const NEEDS = new Set(['medical', 'power_for_device', 'shelter', 'water_food', 'transport', 'inspection', 'other']);

function shape(file: string, what: string, obj: unknown, req: Shape, opt: Shape = {}): boolean {
  if (typeof obj !== 'object' || obj === null) { fail(file, `${what} is not an object`); return false; }
  const o = obj as Record<string, unknown>;
  for (const [k, t] of Object.entries(req)) {
    const ok = t === 'number|null' ? o[k] === null || typeof o[k] === 'number' : typeof o[k] === t;
    if (!ok) { fail(file, `${what}.${k} should be ${t}, got ${typeof o[k]}`); return false; }
  }
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
  if (wk !== 'center,dataSources,eventId,eventLocalHour,eventWeekday,facilities,hazardType,hexes,households,landfallIso,name,region') fail(file, `world keys ${wk}`);
  if (!Number.isInteger(w.eventLocalHour) || w.eventLocalHour! < 0 || w.eventLocalHour! > 23 || typeof w.eventWeekday !== 'boolean') fail(file, 'bad eventLocalHour/eventWeekday');
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
    if (typeof c.k12Enrollment !== 'number' || typeof c.collegeEnrollment !== 'number' || c.k12Enrollment < 0 || c.collegeEnrollment < 0) fail(file, `k12/college enrollment missing at ${c.hex}`);
    if (isQuake && (c.windMph !== 0 || c.floodDepthFt !== 0 || typeof c.shakingMmi !== 'number')) fail(file, `quake cell ${c.hex} wind/flood must be 0 and MMI set`);
  }
  if (w.hexes.some((c, i) => i > 0 && w.hexes[i - 1]!.hex >= c.hex)) fail(file, 'hexes not sorted by id');
  for (const [i, f] of (w.facilities ?? []).entries()) {
    if (!shape(file, `facilities[${i}]`, f, FAC_REQ, FAC_OPT)) break;
    if (!['school', 'university', 'hospital', 'shelter', 'fire_station', 'mast'].includes(f.kind)) fail(file, `bad facility kind ${f.kind}`);
    if (!hexSet.has(f.hex)) fail(file, `facility ${f.id} outside world`);
  }
  const schoolIds = new Set((w.facilities ?? []).filter((f) => f.kind === 'school').map((f) => f.id));
  // k12Enrollment must equal the sum of school enrollment in the cell
  const k12 = new Map<string, number>();
  for (const f of w.facilities ?? []) if (f.kind === 'school') k12.set(f.hex, (k12.get(f.hex) ?? 0) + (f.enrollment ?? 0));
  for (const c of w.hexes) if ((k12.get(c.hex) ?? 0) !== c.k12Enrollment) fail(file, `k12Enrollment mismatch at ${c.hex}`);
  const ids = new Set<string>();
  for (const [i, h] of w.households.entries()) {
    if (!shape(file, `households[${i}]`, h, HH_REQ, HH_OPT)) break;
    if (ids.has(h.id)) fail(file, `duplicate household ${h.id}`);
    ids.add(h.id);
    if (!hexSet.has(h.hex)) fail(file, `household ${h.id} hex not in world`);
    if (!['homeowners', 'renters', 'condo'].includes(h.policyType ?? '')) fail(file, `bad policyType ${h.policyType}`);
    if (!Number.isInteger(h.schoolAgeChildren) || h.schoolAgeChildren! < 0) fail(file, `bad schoolAgeChildren ${h.schoolAgeChildren}`);
    if (h.schoolAgeChildren! > 0 && !h.childrenUnder18) fail(file, `schoolAgeChildren without childrenUnder18 ${h.id}`);
    if (!schoolIds.has(h.nearestSchoolId ?? '')) fail(file, `nearestSchoolId ${h.nearestSchoolId} is not a school facility`);
  }
  if (b.truth.length !== w.households.length) fail(file, 'truth rows != households');
  for (const [i, t] of b.truth.entries()) {
    if (!shape(file, `truth[${i}]`, t, TRUTH, { returnMin: "number" })) break;
    if (!ids.has(t.householdId)) fail(file, `truth for unknown ${t.householdId}`);
    if (!DAMAGES.has(t.damage)) fail(file, 'bad damage');
    const perils = isQuake ? ['earthquake', 'none'] : ['wind', 'flood', 'none'];
    if (!perils.includes(t.peril)) fail(file, `bad peril ${t.peril}`);
    if ((t.peril === 'none') !== (t.damage === 0)) fail(file, `peril/damage mismatch ${t.householdId}`);
  }
  const truthOf = new Map(b.truth.map((t) => [t.householdId, t]));
  for (const t of b.truth) {
    if (!['life_safety', 'assistance', 'none'].includes(t.needType ?? '')) fail(file, `bad needType ${t.needType}`);
    if ((t.needType === 'none') !== (t.safety === 'safe')) fail(file, `needType/safety mismatch ${t.householdId}`);
    if (!['home', 'away', 'displaced'].includes(t.location ?? '')) fail(file, `bad location ${t.location}`);
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
      if ((e.damage !== null && !DAMAGES.has(e.damage)) || !['safe', 'needs_help'].includes(e.safety)) fail(file, 'bad sms_reply');
      if (e.lifeSafety && e.safety !== 'needs_help') fail(file, `lifeSafety on a safe reply ${e.householdId}`);
      if (!(e.needs ?? []).every((n) => NEEDS.has(n))) fail(file, `bad needs ${JSON.stringify(e.needs)}`);
      if (!e.lifeSafety && (e.needs ?? []).includes('power_for_device')) fail(file, `power_for_device outside life safety ${e.householdId}`);
      const tl = truthOf.get(e.householdId);
      if (tl && e.notHome !== (locationAt(tl, e.t) !== 'home')) fail(file, `notHome disagrees with truth location ${e.householdId}`);
      if (e.damage === null && !e.notHome && e.text === undefined) fail(file, `unknown damage in a button reply while at home ${e.householdId}`);
      if ((e.text === undefined) !== (e.language === undefined)) fail(file, 'text/language must come together');
    }
    if (e.kind === 'claim' && (!DAMAGES.has(e.reportedDamage) || !(isQuake ? ['earthquake'] : ['wind', 'flood']).includes(e.peril))) fail(file, `bad claim ${JSON.stringify(e)}`);
    if (e.kind === 'field_report' && ((e.damage !== null && !DAMAGES.has(e.damage)) || !['safe', 'needs_help', 'unsure'].includes(e.safety))) fail(file, 'bad field_report');
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
    .filter((x) => x.d <= km && x.f.kind !== 'mast')
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
    const schoolHours = live.world.hazardType === 'earthquake' && live.world.eventWeekday === true && live.world.eventLocalHour! >= 8 && live.world.eventLocalHour! < 15;
    const tenure: Record<string, number> = {};
    for (const h of hh) tenure[h.policyType ?? '?'] = (tenure[h.policyType ?? '?'] ?? 0) + 1;
    console.log(`event local time ${live.world.eventLocalHour}:00, ${live.world.eventWeekday ? 'weekday' : 'weekend'}; school in session: ${schoolHours}`);
    console.log(`policy types: ${Object.entries(tenure).map(([k, v]) => `${k} ${((100 * v) / hh.length).toFixed(1)}%`).join(', ')}; collegeStudent ${share((h) => h.collegeStudent)}; households with school-age children ${share((h) => (h.schoolAgeChildren ?? 0) > 0)} (${hh.reduce((a, h) => a + (h.schoolAgeChildren ?? 0), 0)} children)`);
    const hexById = new Map(live.world.hexes.map((c) => [c.hex, c]));
    const facById = new Map((live.world.facilities ?? []).map((f) => [f.id, f]));
    const reunify = schoolHours ? hh.filter((h) => (h.schoolAgeChildren ?? 0) > 0 && (hexById.get(facById.get(h.nearestSchoolId ?? '')?.hex ?? '')?.hazardIndex ?? 0) >= 0.5).length : 0;
    console.log(`reunification-need households (school in session, school-age children, nearest school in a cell with hazardIndex >= 0.5): ${reunify}`);
    const exposed = live.world.hexes.filter((c) => (c.k12Enrollment ?? 0) > 0)
      .map((c) => ({ c, students: Math.round((c.k12Enrollment ?? 0) * (c.hazardIndex ?? 0)) }))
      .sort((a, b) => b.students - a.students).slice(0, 3);
    console.log(`top cells by students exposed (k12Enrollment x hazardIndex${schoolHours ? ', school in session' : '; NOT school hours, so potential only'}):`);
    for (const { c, students } of exposed) {
      const names = (live.world.facilities ?? []).filter((f) => f.kind === 'school' && f.hex === c.hex).map((f) => `${f.name} (${f.enrollment ?? '?'})`).join('; ');
      console.log(`  ${c.hex}: ${schoolHours ? students : 0} exposed (k12 ${c.k12Enrollment}, hazardIndex ${c.hazardIndex}, outage ${c.towerOutagePct}%): ${names}`);
    }
    console.log(`languages: ${Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${((100 * v) / hh.length).toFixed(1)}%`).join(', ')}`);
    const fac = live.world.facilities ?? [];
    const kinds: Record<string, number> = {};
    for (const f of fac) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
    console.log(`facilities: ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    const sample = live.events.filter((e) => e.kind === 'sms_reply' && e.text).slice(0, 400);
    const byLang = new Map<string, string>();
    for (const e of sample) if (e.kind === 'sms_reply' && !byLang.has(e.language!)) byLang.set(e.language!, `[${e.language}] safety=${e.safety} damage=${e.damage}: "${e.text}"`);
    console.log('sample free-text replies:\n  ' + [...byLang.values()].join('\n  '));
    {
      const cnt = (xs: (string | undefined)[]) => Object.entries(xs.reduce<Record<string, number>>((m, x) => ((m[x ?? '-'] = (m[x ?? '-'] ?? 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join(', ');
      const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '-');
      const reps = live.events.filter((e) => e.kind === 'sms_reply');
      const help = reps.filter((e) => e.kind === 'sms_reply' && e.safety === 'needs_help');
      const txt = reps.filter((e) => e.kind === 'sms_reply' && e.text);
      console.log(`truth needType {${cnt(live.truth.map((t) => t.needType))}}; location {${cnt(live.truth.map((t) => t.location))}}`);
      console.log(`replies ${reps.length}: needs_help ${help.length} (lifeSafety ${pct(help.filter((e) => e.kind === 'sms_reply' && e.lifeSafety).length, help.length)}), notHome ${pct(reps.filter((e) => e.kind === 'sms_reply' && e.notHome).length, reps.length)}, damage null ${pct(reps.filter((e) => e.kind === 'sms_reply' && e.damage === null).length, reps.length)} (text replies: ${pct(txt.filter((e) => e.kind === 'sms_reply' && e.damage === null).length, txt.length)}), needs {${cnt(reps.flatMap((e) => (e.kind === 'sms_reply' ? e.needs ?? [] : [])))}}`);
      console.log(`text replies by language {${cnt(txt.map((e) => (e.kind === 'sms_reply' ? e.language : undefined)))}}`);
    }
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
