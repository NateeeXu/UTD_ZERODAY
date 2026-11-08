// Loads the cached raw datasets for one region into plain in-memory structures.
// Every loader degrades gracefully: missing inputs are recorded in `fallbacks` and replaced by a
// documented proxy so generation can continue.

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { RegionDef } from './regions.ts';
import { ACS_TABLES, ACS_YEAR, LODES_YEAR, RAW_DIR } from './sources.ts';
import { buildPolyIndex } from './geo.ts';
import type { PolyIndex } from './geo.ts';

export interface Block {
  geoid: string;     // 15-digit 2020 block GEOID
  tract: string;     // 11-digit tract GEOID
  lat: number;
  lng: number;
  pop2020: number;   // 2020 Census POP100
  hu2020: number;    // 2020 Census HU100
  jobs: number;      // LODES WAC C000 (jobs located in the block)
  workers: number;   // LODES RAC C000 (employed residents of the block)
  gqCollege: number; // 2020 Census P5_008N: population in college/university student housing
}

export interface Tract {
  geoid: string;
  lat: number; lng: number;          // 2020 internal point
  pop2020: number;
  // ACS 5-year
  pop: number;
  shareU18: number;
  share65: number;
  households: number;
  housingUnits: number;
  shareHhKids: number;        // households with 1+ people under 18
  shareHh65: number;          // households with 1+ people 65+
  shareAlone65OfHh65: number; // 65+ living alone, as a share of households with 65+
  shareAlone: number;         // householder living alone, share of all households
  shareMobile: number;        // mobile homes, share of housing units
  sharePre1980: number;       // structures built 1979 or earlier
  share75Of65: number;        // persons 75+ / persons 65+
  disab65: number;            // disability rate among persons 65+
  disabU65: number;           // disability rate among persons 18-64
  shareNoVehicle: number;     // households with no vehicle
  shareRenter: number;        // B25003 renter-occupied / occupied
  shareCondoOfOwner: number;  // B25032 owner-occupied units in 2+ unit structures / owner-occupied (condo proxy)
  kidsPerKidHh: number;       // persons under 18 / households with children
  share5to17OfU18: number;    // persons 5-17 / persons under 18
  collegePop: number;         // B14007 enrolled in college (undergraduate + graduate)
  /** Household language groups (C16002): share of households and limited-English rate within the group. */
  lang: { en: number; es: number; ie: number; api: number; other: number };
  limited: { es: number; ie: number; api: number; other: number };
  /** Person-level splits (C16001) inside the groups, used to pick a concrete language code. */
  apiSplit: Record<string, number>;   // ko, zh, vi, tl, other-api
  ieSplit: Record<string, number>;    // fr, de, ru, other-ie
  otherSplit: Record<string, number>; // ar, other
  // CDC/ATSDR SVI 2022 (optional)
  sviOverall?: number;        // RPL_THEMES percentile 0-1
  pctDisabled?: number;       // EP_DISABL
  pctLimitedEnglish?: number; // EP_LIMENG
}

export interface RawFacility {
  kind: 'school' | 'university' | 'hospital' | 'shelter' | 'fire_station' | 'mast';
  name: string;
  lat: number; lng: number;
  enrollment?: number;
  source: string;
  sourceId: string;
}

export interface RegionData {
  region: RegionDef;
  blocks: Block[];
  tracts: Map<string, Tract>;
  coastWays: Array<Array<{ lat: number; lon: number }>>;
  facilities: RawFacility[];
  masts: Array<{ lat: number; lng: number; id: string; name: string }>;
  liquefaction: PolyIndex | null;
  fallbacks: string[];
  used: string[];
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);
}

/** Read an ACS table-based summary-file extract into Map<tractGeoid, Map<column, value>>. */
function readAcs(path: string): Map<string, Record<string, number>> {
  const lines = readLines(path);
  const head = lines[0]!.split('|');
  const out = new Map<string, Record<string, number>>();
  for (const line of lines.slice(1)) {
    const f = line.split('|');
    const rec: Record<string, number> = {};
    head.forEach((h, i) => { if (i > 0) rec[h] = Number(f[i]); });
    out.set(f[0]!.split('US')[1]!, rec);
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function loadRegion(r: RegionDef): RegionData {
  const fallbacks: string[] = [];
  const used: string[] = [];
  const fips = r.stateFips + r.countyFips;

  // ---- 2020 blocks and tract internal points (PL 94-171 geographic header) ----
  const plPath = join(RAW_DIR, 'pl', `blocks_${fips}.csv`);
  if (!existsSync(plPath)) throw new Error(`missing ${plPath}; run node real/fetch.ts ${r.id}`);
  const blocks: Block[] = [];
  const tracts = new Map<string, Tract>();
  for (const line of readLines(plPath).slice(1)) {
    const [sumlev, geoid, , , pop, hu, lat, lng] = line.split(',');
    if (sumlev === '750') {
      blocks.push({ geoid: geoid!, tract: geoid!.slice(0, 11), lat: Number(lat), lng: Number(lng), pop2020: Number(pop), hu2020: Number(hu), jobs: 0, workers: 0, gqCollege: 0 });
    } else {
      tracts.set(geoid!, {
        geoid: geoid!, lat: Number(lat), lng: Number(lng), pop2020: Number(pop),
        pop: Number(pop), shareU18: 0.22, share65: 0.17, households: 0, housingUnits: Number(hu),
        shareHhKids: 0.3, shareHh65: 0.3, shareAlone65OfHh65: 0.27, shareAlone: 0.28, shareMobile: 0.02, sharePre1980: 0.4,
        share75Of65: 0.45, disab65: 0.33, disabU65: 0.10, shareNoVehicle: 0.08,
        shareRenter: 0.4, shareCondoOfOwner: 0.05, kidsPerKidHh: 1.8, share5to17OfU18: 0.72, collegePop: 0,
        lang: { en: 0.78, es: 0.13, ie: 0.04, api: 0.04, other: 0.01 }, limited: { es: 0.2, ie: 0.1, api: 0.25, other: 0.15 },
        apiSplit: { zh: 1 }, ieSplit: { 'other-ie': 1 }, otherSplit: { other: 1 },
      });
    }
  }
  used.push('census-pl2020');

  // ---- LODES ----
  const byBlock = new Map(blocks.map((b) => [b.geoid, b]));
  for (const kind of ['wac', 'rac'] as const) {
    const p = join(RAW_DIR, 'lodes', `${kind}_${fips}_${LODES_YEAR}.csv`);
    if (!existsSync(p)) { fallbacks.push(`LODES ${kind.toUpperCase()} missing: ${kind === 'rac' ? 'resident workers estimated as 0.45 x population (assumption)' : 'daytime workers set to 0'}`); continue; }
    for (const line of readLines(p).slice(1)) {
      const [g, c] = line.split(',');
      const b = byBlock.get(g!);
      if (!b) continue;
      if (kind === 'wac') b.jobs += Number(c); else b.workers += Number(c);
    }
  }
  if (!fallbacks.some((f) => f.startsWith('LODES RAC'))) used.push('lodes'); else for (const b of blocks) b.workers = Math.round(0.45 * b.pop2020);

  // ---- ACS 5-year ----
  const acsPath = (t: string) => join(RAW_DIR, 'acs', `acs5_${ACS_YEAR}_${t}_${fips}.psv`);
  if (ACS_TABLES.every((t) => existsSync(acsPath(t)))) {
    const b01001 = readAcs(acsPath('b01001'));
    const b11001 = readAcs(acsPath('b11001'));
    const b11005 = readAcs(acsPath('b11005'));
    const b11007 = readAcs(acsPath('b11007'));
    const b25024 = readAcs(acsPath('b25024'));
    const b25034 = readAcs(acsPath('b25034'));
    const b18101 = readAcs(acsPath('b18101'));
    const b08201 = readAcs(acsPath('b08201'));
    const c16001 = readAcs(acsPath('c16001'));
    const c16002 = readAcs(acsPath('c16002'));
    const b25003 = readAcs(acsPath('b25003'));
    const b25032 = readAcs(acsPath('b25032'));
    const b14007 = readAcs(acsPath('b14007'));
    const sum = (rec: Record<string, number>, table: string, cols: number[]) =>
      cols.reduce((a, c) => a + (rec[`${table}_E${String(c).padStart(3, '0')}`] ?? 0), 0);
    const safe = (num: number, den: number, dflt: number) => (den > 0 ? num / den : dflt);
    for (const t of tracts.values()) {
      const a = b01001.get(t.geoid), hh = b11001.get(t.geoid), k = b11005.get(t.geoid), s = b11007.get(t.geoid);
      const u = b25024.get(t.geoid), y = b25034.get(t.geoid);
      const d = b18101.get(t.geoid), v = b08201.get(t.geoid), l1 = c16001.get(t.geoid), l2 = c16002.get(t.geoid);
      if (!a || !hh || !k || !s || !u || !y || !d || !v || !l1 || !l2) continue;
      t.pop = sum(a, 'B01001', [1]);
      t.shareU18 = safe(sum(a, 'B01001', [3, 4, 5, 6, 27, 28, 29, 30]), t.pop, 0.22);
      t.share65 = safe(sum(a, 'B01001', [20, 21, 22, 23, 24, 25, 44, 45, 46, 47, 48, 49]), t.pop, 0.17);
      t.households = sum(hh, 'B11001', [1]);
      t.shareAlone = safe(sum(hh, 'B11001', [8]), t.households, 0.28);
      t.shareHhKids = safe(sum(k, 'B11005', [2]), sum(k, 'B11005', [1]), 0.3);
      t.shareHh65 = safe(sum(s, 'B11007', [2]), sum(s, 'B11007', [1]), 0.3);
      t.shareAlone65OfHh65 = safe(sum(s, 'B11007', [3]), sum(s, 'B11007', [2]), 0.27);
      t.housingUnits = sum(u, 'B25024', [1]);
      t.shareMobile = safe(sum(u, 'B25024', [10]), t.housingUnits, 0.02);
      t.sharePre1980 = safe(sum(y, 'B25034', [7, 8, 9, 10, 11]), sum(y, 'B25034', [1]), 0.4);
      const p65 = sum(a, 'B01001', [20, 21, 22, 23, 24, 25, 44, 45, 46, 47, 48, 49]);
      t.share75Of65 = safe(sum(a, 'B01001', [23, 24, 25, 47, 48, 49]), p65, 0.45);
      t.disab65 = safe(sum(d, 'B18101', [16, 19, 35, 38]), sum(d, 'B18101', [15, 18, 34, 37]), 0.33);
      t.disabU65 = safe(sum(d, 'B18101', [10, 13, 29, 32]), sum(d, 'B18101', [9, 12, 28, 31]), 0.10);
      t.shareNoVehicle = safe(sum(v, 'B08201', [2]), sum(v, 'B08201', [1]), 0.08);
      const hhL = sum(l2, 'C16002', [1]);
      if (hhL > 0) {
        t.lang = {
          en: sum(l2, 'C16002', [2]) / hhL, es: sum(l2, 'C16002', [3]) / hhL, ie: sum(l2, 'C16002', [6]) / hhL,
          api: sum(l2, 'C16002', [9]) / hhL, other: sum(l2, 'C16002', [12]) / hhL,
        };
        t.limited = {
          es: safe(sum(l2, 'C16002', [4]), sum(l2, 'C16002', [3]), 0.2), ie: safe(sum(l2, 'C16002', [7]), sum(l2, 'C16002', [6]), 0.1),
          api: safe(sum(l2, 'C16002', [10]), sum(l2, 'C16002', [9]), 0.25), other: safe(sum(l2, 'C16002', [13]), sum(l2, 'C16002', [12]), 0.15),
        };
      }
      const split = (cols: Record<string, number>, dflt: string) => {
        const tot = Object.values(cols).reduce((x, c) => x + sum(l1, 'C16001', [c]), 0);
        const out: Record<string, number> = {};
        for (const [code, c] of Object.entries(cols)) out[code] = tot > 0 ? sum(l1, 'C16001', [c]) / tot : (code === dflt ? 1 : 0);
        return out;
      };
      t.apiSplit = split({ ko: 18, zh: 21, vi: 24, tl: 27, 'other-api': 30 }, 'zh');
      t.ieSplit = split({ fr: 6, de: 9, ru: 12, 'other-ie': 15 }, 'other-ie');
      t.otherSplit = split({ ar: 33, other: 36 }, 'other');
      const ten = b25003.get(t.geoid), tu = b25032.get(t.geoid), en = b14007.get(t.geoid);
      if (ten) t.shareRenter = safe(sum(ten, 'B25003', [3]), sum(ten, 'B25003', [1]), 0.4);
      if (tu) t.shareCondoOfOwner = safe(sum(tu, 'B25032', [5, 6, 7, 8, 9, 10]), sum(tu, 'B25032', [2]), 0.05);
      const u18 = sum(a, 'B01001', [3, 4, 5, 6, 27, 28, 29, 30]);
      const hhKids = sum(k, 'B11005', [2]);
      t.kidsPerKidHh = hhKids > 0 ? Math.max(1, u18 / hhKids) : 1.8;
      t.share5to17OfU18 = safe(sum(a, 'B01001', [4, 5, 6, 28, 29, 30]), u18, 0.72);
      if (en) t.collegePop = sum(en, 'B14007', [17, 18]);
    }
    used.push('acs5');
  } else {
    fallbacks.push('ACS 5-year extracts missing: tract shares fall back to SVI 2022 (age 65+, under 17) and national-average assumptions for households');
  }

  // ---- SVI 2022 (optional) ----
  const sviPath = join(RAW_DIR, 'svi', `${r.plStateDir}.csv`);
  if (existsSync(sviPath)) {
    const lines = readLines(sviPath);
    const head = parseCsvLine(lines[0]!.replace(/^﻿/, ''));
    const col = (n: string) => head.indexOf(n);
    const iF = col('FIPS'), iR = col('RPL_THEMES'), iD = col('EP_DISABL'), iL = col('EP_LIMENG'), i65 = col('EP_AGE65'), i17 = col('EP_AGE17'), iPop = col('E_TOTPOP'), iHh = col('E_HH');
    const acsOk = used.includes('acs5');
    for (const line of lines.slice(1)) {
      if (!line.includes(fips)) continue;
      const f = parseCsvLine(line);
      const t = tracts.get(f[iF]!);
      if (!t) continue;
      const num = (i: number) => { const v = Number(f[i]); return Number.isFinite(v) && v >= 0 ? v : undefined; };
      t.sviOverall = num(iR);
      t.pctDisabled = num(iD);
      t.pctLimitedEnglish = num(iL);
      if (!acsOk) {
        t.pop = num(iPop) ?? t.pop;
        t.share65 = (num(i65) ?? 17) / 100;
        t.shareU18 = (num(i17) ?? 22) / 100;
        t.households = num(iHh) ?? Math.round(t.pop / 2.5);
      }
    }
    used.push('svi2022');
  } else fallbacks.push('SVI 2022 missing: medical-device rate uses the county-wide assumption only');

  // ---- OSM (facilities, masts, coastline) ----
  const facilities: RawFacility[] = [];
  const masts: RegionData['masts'] = [];
  const coastWays: RegionData['coastWays'] = [];
  const osmPath = join(RAW_DIR, 'osm', `${r.stateAbbr}_overpass.json`);
  if (existsSync(osmPath)) {
    const j = JSON.parse(readFileSync(osmPath, 'utf8')) as { elements: Array<{ type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }> }> };
    for (const e of j.elements) {
      const tags = e.tags ?? {};
      if (tags.natural === 'coastline' && e.geometry) { coastWays.push(e.geometry); continue; }
      const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
      if (lat === undefined || lon === undefined) continue;
      const sourceId = `osm:${e.type}/${e.id}`;
      if (tags.man_made === 'mast' || tags.man_made === 'tower') { masts.push({ lat, lng: lon, id: sourceId, name: tags.name ?? (tags.operator ? `${tags.operator} mast` : 'Communication mast') }); continue; }
      const kind = tags.amenity === 'hospital' ? 'hospital'
        : tags.amenity === 'fire_station' ? 'fire_station'
        : tags.amenity === 'school' ? 'school'
        : (tags.social_facility === 'shelter' || tags.amenity === 'shelter') ? 'shelter' : null;
      if (!kind) continue;
      const name = tags.name ?? tags.official_name ?? (kind === 'fire_station' && tags.ref ? `Fire Station ${tags.ref}` : '');
      if (!name) continue;
      facilities.push({ kind, name, lat, lng: lon, source: 'OpenStreetMap', sourceId });
    }
    used.push('osm');
  } else fallbacks.push('OSM Overpass result missing: no hospitals / fire stations / masts; coastline proxy used');

  // ---- NCES public schools (preferred over OSM schools when available) ----
  const ncesPath = join(RAW_DIR, 'nces', `nces_publicsch_2324_${r.stateAbbr}.json`);
  if (existsSync(ncesPath)) {
    const j = JSON.parse(readFileSync(ncesPath, 'utf8')) as { features?: Array<{ attributes: Record<string, string | number | null> }> };
    const feats = j.features ?? [];
    if (feats.length) {
      for (let i = facilities.length - 1; i >= 0; i--) if (facilities[i]!.kind === 'school') facilities.splice(i, 1);
      for (const { attributes: a } of feats) {
        if (String(a.SY_STATUS_TEXT ?? '').toLowerCase().includes('closed')) continue;
        if (String(a.VIRTUAL ?? '').toLowerCase().includes('full')) continue;
        const total = Number(a.TOTAL);
        facilities.push({
          kind: 'school', name: titleCase(String(a.SCH_NAME)), lat: Number(a.LATCOD), lng: Number(a.LONCOD),
          enrollment: Number.isFinite(total) && total > 0 ? total : undefined,
          source: 'NCES EDGE 2023-24', sourceId: `nces:${a.NCESSCH}`,
        });
      }
      used.push('nces');
    } else fallbacks.push('NCES query returned no schools: OSM amenity=school used instead');
  } else fallbacks.push('NCES school file missing: OSM amenity=school used instead');

  // ---- 2020 Census group quarters: college/university student housing (P5_008N) ----
  const gqPath = join(RAW_DIR, 'pl', `gq_${fips}.csv`);
  if (existsSync(gqPath)) {
    for (const line of readLines(gqPath).slice(1)) {
      const [g, n] = line.split(',');
      const b = byBlock.get(g!);
      if (b) b.gqCollege = Number(n);
    }
    used.push('census-gq2020');
  } else fallbacks.push('2020 group-quarters extract missing: no dormitory boost for collegeStudent');

  // ---- IPEDS colleges / universities (HD2023 directory + EF2023A fall enrollment) ----
  const hdPath = join(RAW_DIR, 'ipeds', 'HD2023.zip'), efPath = join(RAW_DIR, 'ipeds', 'EF2023A.zip');
  if (existsSync(hdPath) && existsSync(efPath)) {
    const unzipText = (zip: string) => execFileSync('unzip', ['-p', zip], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8').split(/\r?\n/).filter((l) => l);
    const hd = unzipText(hdPath);
    const hh = parseCsvLine(hd[0]!.replace(/^\uFEFF/, ''));
    const ix = (n: string) => hh.indexOf(n);
    const ef = unzipText(efPath);
    const eh = parseCsvLine(ef[0]!.replace(/^\uFEFF/, ''));
    const eU = eh.indexOf('UNITID'), eL = eh.indexOf('EFALEVEL'), eT = eh.indexOf('EFTOTLT');
    const enroll = new Map<string, number>();
    for (const line of ef.slice(1)) {
      const f = parseCsvLine(line);
      if (f[eL]?.trim() === '1') enroll.set(f[eU]!.trim(), Number(f[eT]));
    }
    const countyCode = String(Number(r.stateFips + r.countyFips));
    let n = 0;
    for (const line of hd.slice(1)) {
      const f = parseCsvLine(line);
      if (String(Number(f[ix('COUNTYCD')])) !== countyCode) continue;
      const e = enroll.get(f[ix('UNITID')]!.trim()) ?? 0;
      const level = f[ix('ICLEVEL')]?.trim(); // 1 = 4-year+, 2 = 2-year
      if (e < 300 || (level !== '1' && level !== '2')) continue; // drop small vocational / beauty schools
      facilities.push({
        kind: 'university', name: f[ix('INSTNM')]!, lat: Number(f[ix('LATITUDE')]), lng: Number(f[ix('LONGITUD')]),
        enrollment: e, source: 'IPEDS 2023 (HD2023, EF2023A)', sourceId: `ipeds:${f[ix('UNITID')]}`,
      });
      n++;
    }
    if (n) used.push('ipeds'); else fallbacks.push('IPEDS returned no institutions in the county');
  } else {
    fallbacks.push('IPEDS files missing: no university facilities / collegeEnrollment');
  }

  // ---- CGS liquefaction zones (CA only) ----
  let liquefaction: PolyIndex | null = null;
  if (r.hazardType === 'earthquake') {
    const p = join(RAW_DIR, 'cgs', `cgs_liquefaction_zones_${r.stateAbbr}.geojson`);
    if (existsSync(p)) { liquefaction = buildPolyIndex(JSON.parse(readFileSync(p, 'utf8'))); used.push('cgs'); }
    else fallbacks.push('CGS liquefaction zones missing: liquefaction proxied from low elevation near the bay shoreline');
  }

  return { region: r, blocks, tracts, coastWays, facilities, masts, liquefaction, fallbacks, used };
}

function titleCase(s: string): string {
  if (s !== s.toUpperCase()) return s.trim();
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bIsd\b/g, 'ISD').replace(/\bJ H\b/g, 'J H').trim();
}
