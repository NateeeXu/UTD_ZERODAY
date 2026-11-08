// Downloads (and caches) every public dataset the real-geography simulator uses into data/raw/.
// Each step is cached: if the output file already exists it is skipped. A failed step is logged
// and the generator falls back to a documented proxy, so one dead endpoint never blocks the job.
//
// Usage (from sim/):  node real/fetch.ts [tx-corpus-christi|ca-bay-area ...]

import { createReadStream, createWriteStream, existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { dirname, join } from 'node:path';
import { REGIONS } from './regions.ts';
import type { RegionDef } from './regions.ts';
import { RAW_DIR, ACS_YEAR, ACS_TABLES, LODES_YEAR, SHAKEMAP_SCENARIOS, TERRAIN_ZOOM, tilesForBbox } from './sources.ts';

const UA = 'TriageLoop-HackUTD/0.1 (hackathon research; contact via github)';
const log = (msg: string) => console.log(`[fetch] ${msg}`);
const status: Record<string, string> = {};

async function download(url: string, path: string, init?: RequestInit): Promise<void> {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(600_000) });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const tmp = path + '.part';
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  renameSync(tmp, path);
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  try {
    await fn();
    status[name] = `ok (${((Date.now() - t0) / 1000).toFixed(0)} s)`;
  } catch (err) {
    status[name] = `FAILED: ${(err as Error).message}`;
  }
  log(`${name}: ${status[name]}`);
}

// ---- Census ACS 5-year (table-based summary file; the Census Data API now requires a key) ----
// One streaming pass per national table file extracts the tracts of every region at once.
export async function fetchAcsAll(regions: RegionDef[], tables: readonly string[] = ACS_TABLES): Promise<void> {
  await Promise.all(tables.map(async (t) => {
    const outs = regions.map((r) => ({
      prefix: `1400000US${r.stateFips}${r.countyFips}`,
      path: join(RAW_DIR, 'acs', `acs5_${ACS_YEAR}_${t}_${r.stateFips}${r.countyFips}.psv`),
      lines: [] as string[],
    }));
    if (outs.every((o) => existsSync(o.path))) return;
    mkdirSync(join(RAW_DIR, 'acs'), { recursive: true });
    const url = `https://www2.census.gov/programs-surveys/acs/summary_file/${ACS_YEAR}/table-based-SF/data/5YRData/acsdt5y${ACS_YEAR}-${t}.dat`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(1_800_000) });
    if (!res.ok || !res.body) throw new Error(`${res.status} for ${url}`);
    const rl = createInterface({ input: Readable.fromWeb(res.body as never), crlfDelay: Infinity });
    let head = '';
    for await (const line of rl) {
      if (!head) { head = line; continue; }
      if (line.charCodeAt(0) !== 49 || !line.startsWith('1400000US')) continue; // tract rows only
      for (const o of outs) if (line.startsWith(o.prefix)) o.lines.push(line);
    }
    for (const o of outs) writeFileSync(o.path, [head, ...o.lines].join('\n') + '\n');
  }));
}

// ---- 2020 Census PL 94-171 geographic header: block / tract internal points, POP100, HU100 ----
export async function fetchPl(r: RegionDef): Promise<void> {
  const zip = join(RAW_DIR, 'pl', `${r.stateAbbr}2020.pl.zip`);
  const out = join(RAW_DIR, 'pl', `blocks_${r.stateFips}${r.countyFips}.csv`);
  if (existsSync(out)) return;
  await download(`https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171/${r.plStateDir}/${r.stateAbbr}2020.pl.zip`, zip);
  const child = spawn('unzip', ['-p', zip, `${r.stateAbbr}geo2020.pl`]);
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const rows = ['sumlev,geoid,arealand,areawater,pop100,hu100,lat,lng'];
  for await (const line of rl) {
    const f = line.split('|');
    const sumlev = f[2];
    if ((sumlev !== '750' && sumlev !== '140') || f[14] !== r.countyFips) continue;
    const iLat = f.findIndex((v, i) => i > 20 && /^[+-]\d+\.\d+$/.test(v));
    if (iLat < 0) continue;
    const geoid = f[8]!.split('US')[1]!;
    rows.push([sumlev, geoid, f[iLat - 8], f[iLat - 7], f[iLat - 2], f[iLat - 1], Number(f[iLat]), Number(f[iLat + 1])].join(','));
  }
  writeFileSync(out, rows.join('\n') + '\n');
}

// ---- 2020 Census PL segment 3: group quarters, P5_008N college/university student housing (blocks) ----
export async function fetchGq(r: RegionDef): Promise<void> {
  const out = join(RAW_DIR, 'pl', `gq_${r.stateFips}${r.countyFips}.csv`);
  if (existsSync(out)) return;
  const zip = join(RAW_DIR, 'pl', `${r.stateAbbr}2020.pl.zip`);
  await download(`https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171/${r.plStateDir}/${r.stateAbbr}2020.pl.zip`, zip);
  const logrec = new Map<string, string>();
  const geo = createInterface({ input: spawn('unzip', ['-p', zip, `${r.stateAbbr}geo2020.pl`]).stdout, crlfDelay: Infinity });
  for await (const line of geo) {
    const f = line.split('|');
    if (f[2] === '750' && f[14] === r.countyFips) logrec.set(f[7]!, f[8]!.split('US')[1]!);
  }
  const rows = ['geoid,college_gq'];
  const seg = createInterface({ input: spawn('unzip', ['-p', zip, `${r.stateAbbr}000032020.pl`]).stdout, crlfDelay: Infinity });
  for await (const line of seg) {
    const f = line.split('|');
    const g = logrec.get(f[4]!);
    if (g && Number(f[12]) > 0) rows.push(`${g},${Number(f[12])}`); // P5_008N (fields: FILEID,STUSAB,CHARITER,CIFSN,LOGRECNO,P5_001N..P5_010N)
  }
  writeFileSync(out, rows.join('\n') + '\n');
}

// ---- IPEDS: institution directory (HD2023) and fall enrollment (EF2023A) ----
export async function fetchIpeds(): Promise<void> {
  for (const f of ['HD2023.zip', 'EF2023A.zip']) await download(`https://nces.ed.gov/ipeds/datacenter/data/${f}`, join(RAW_DIR, 'ipeds', f));
}

// ---- LEHD LODES8 WAC / RAC (all jobs, S000 / JT00), filtered to the county ----
export async function fetchLodes(r: RegionDef): Promise<void> {
  for (const kind of ['wac', 'rac'] as const) {
    const gz = join(RAW_DIR, 'lodes', `${r.stateAbbr}_${kind}_S000_JT00_${LODES_YEAR}.csv.gz`);
    const out = join(RAW_DIR, 'lodes', `${kind}_${r.stateFips}${r.countyFips}_${LODES_YEAR}.csv`);
    if (existsSync(out)) continue;
    await download(`https://lehd.ces.census.gov/data/lodes/LODES8/${r.stateAbbr}/${kind}/${r.stateAbbr}_${kind}_S000_JT00_${LODES_YEAR}.csv.gz`, gz);
    const rl = createInterface({ input: createReadStream(gz).pipe(createGunzip()), crlfDelay: Infinity });
    const rows: string[] = [];
    const pre = r.stateFips + r.countyFips;
    for await (const line of rl) {
      if (rows.length === 0) { rows.push(line.split(',').slice(0, 2).join(',')); continue; }
      if (line.startsWith(pre)) rows.push(line.split(',').slice(0, 2).join(','));
    }
    writeFileSync(out, rows.join('\n') + '\n');
  }
}

// ---- CDC/ATSDR SVI 2022 (state CSV) ----
export async function fetchSvi(r: RegionDef): Promise<void> {
  await download(`https://svi.cdc.gov/Documents/Data/2022/csv/states/${r.plStateDir}.csv`, join(RAW_DIR, 'svi', `${r.plStateDir}.csv`));
}

// ---- NCES EDGE public school administrative data 2023-24 (locations + enrollment) ----
export async function fetchNces(r: RegionDef): Promise<void> {
  const [s, w, n, e] = r.bbox;
  const params = new URLSearchParams({
    where: '1=1', geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'false', f: 'json',
    outFields: 'NCESSCH,SCH_NAME,LCITY,LSTATE,SCHOOL_LEVEL,SCHOOL_TYPE_TEXT,SY_STATUS_TEXT,VIRTUAL,TOTAL,MEMBER,LATCOD,LONCOD,NMCNTY',
  });
  await download(`https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_ADMINDATA_PUBLICSCH_2324/MapServer/1/query?${params}`,
    join(RAW_DIR, 'nces', `nces_publicsch_2324_${r.stateAbbr}.json`));
}

// ---- OpenStreetMap via Overpass: facilities, comms masts, coastline (one query per region) ----
export function overpassQuery(r: RegionDef): string {
  const [s, w, n, e] = r.bbox;
  const b = `${s},${w},${n},${e}`;
  const cb = `${(s - 0.12).toFixed(2)},${(w - 0.18).toFixed(2)},${(n + 0.1).toFixed(2)},${(e + 0.13).toFixed(2)}`;
  return `[out:json][timeout:180];
(
  nwr["amenity"="school"](${b});
  nwr["amenity"="hospital"](${b});
  nwr["amenity"="fire_station"](${b});
  nwr["social_facility"="shelter"](${b});
  nwr["amenity"="shelter"]["shelter_type"="emergency"](${b});
  nwr["man_made"~"^(mast|tower)$"]["tower:type"="communication"](${b});
  nwr["man_made"="mast"](${b});
);
out center tags;
way["natural"="coastline"](${cb});
out geom;
`;
}
export async function fetchOsm(r: RegionDef): Promise<void> {
  const path = join(RAW_DIR, 'osm', `${r.stateAbbr}_overpass.json`);
  await download('https://overpass-api.de/api/interpreter', path, {
    method: 'POST', body: new URLSearchParams({ data: overpassQuery(r) }),
  });
  JSON.parse(readFileSync(path, 'utf8'));
}

// ---- USGS ShakeMap scenario grids ----
export async function fetchShakeMaps(): Promise<void> {
  for (const sc of SHAKEMAP_SCENARIOS) {
    const detail = join(RAW_DIR, 'usgs', `detail_${sc.eventId}.json`);
    await download(`https://earthquake.usgs.gov/fdsnws/scenario/1/query?eventid=${sc.eventId}&format=geojson`, detail);
    const j = JSON.parse(readFileSync(detail, 'utf8'));
    const url = j.properties.products['shakemap-scenario'][0].contents['download/grid.xml'].url as string;
    await download(url, join(RAW_DIR, 'usgs', `grid_${sc.eventId}.xml`));
  }
}

// ---- California Geological Survey: Seismic Hazard Zones, liquefaction (regulatory zones) ----
export async function fetchCgs(r: RegionDef): Promise<void> {
  const [s, w, n, e] = r.bbox;
  const params = new URLSearchParams({
    where: '1=1', geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', outFields: 'QUAD_NAME', outSR: '4326',
    maxAllowableOffset: '0.0002', geometryPrecision: '5', resultRecordCount: '2000', f: 'geojson',
  });
  const path = join(RAW_DIR, 'cgs', `cgs_liquefaction_zones_${r.stateAbbr}.geojson`);
  await download(`https://services2.arcgis.com/zr3KAIbsRSUyARHG/arcgis/rest/services/CGS_Liquefaction_Zones/FeatureServer/0/query?${params}`, path);
  JSON.parse(readFileSync(path, 'utf8'));
}

// ---- Terrain: AWS Open Data "Terrain Tiles" (Terrarium PNG), used for ground elevation ----
export async function fetchTerrain(r: RegionDef): Promise<void> {
  const tiles = tilesForBbox(r.bbox, TERRAIN_ZOOM, 0.05);
  let i = 0;
  const work = tiles.map(([x, y]) => async () => {
    await download(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${TERRAIN_ZOOM}/${x}/${y}.png`,
      join(RAW_DIR, 'elev', `terrarium_${TERRAIN_ZOOM}_${x}_${y}.png`));
  });
  await Promise.all(Array.from({ length: 6 }, async () => { while (i < work.length) await work[i++]!(); }));
}

async function main(): Promise<void> {
  const ids = (process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(REGIONS)) as RegionDef['id'][];
  const regions = ids.map((id) => { const r = REGIONS[id]; if (!r) throw new Error(`unknown region ${id}`); return r; });
  const acs = step('acs5 (all regions)', () => fetchAcsAll(regions));
  for (const r of regions) {
    log(`== ${r.id}`);
    await step(`${r.id}/pl2020`, () => fetchPl(r));
    await step(`${r.id}/pl2020-gq`, () => fetchGq(r));
    await step(`${r.id}/lodes`, () => fetchLodes(r));
    await step(`${r.id}/svi`, () => fetchSvi(r));
    await step(`${r.id}/nces`, () => fetchNces(r));
    await step(`${r.id}/osm`, () => fetchOsm(r));
    await step(`${r.id}/terrain`, () => fetchTerrain(r));
    if (r.hazardType === 'earthquake') {
      await step(`${r.id}/shakemap`, () => fetchShakeMaps());
      await step(`${r.id}/cgs-liquefaction`, () => fetchCgs(r));
    }
  }
  await step('ipeds', () => fetchIpeds());
  await acs;
  writeFileSync(join(RAW_DIR, 'fetch-status.json'), JSON.stringify(status, null, 2) + '\n');
  log('done; status written to data/raw/fetch-status.json');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
