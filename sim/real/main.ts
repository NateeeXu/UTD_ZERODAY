// Real-geography simulator entry point.
// Usage (from sim/):
//   node real/main.ts tx [--households 20000] [--backtest-households 15000]
//   node real/main.ts ca [--households 30000] [--backtest-households 15000]
// Writes data/real/<region>/{live,backtest-1..N}.json (Texas: 8 backtests, Bay Area: 5) and sim-meta.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventBundle } from '../../shared/types.ts';
import { REGIONS } from './regions.ts';
import type { RegionDef } from './regions.ts';
import { loadRegion } from './load.ts';
import type { RegionData } from './load.ts';
import { buildBaseWorld } from './world.ts';
import { CA_SCENARIOS, TX_SCENARIOS } from './scenarios.ts';
import type { Scenario } from './scenarios.ts';
import { simulate } from './simulate.ts';
import { ACS_YEAR, LODES_YEAR, OUT_DIR } from './sources.ts';

const DEFAULTS: Record<RegionDef['id'], { live: number; backtest: number }> = {
  'tx-corpus-christi': { live: 20000, backtest: 15000 },
  'ca-bay-area': { live: 30000, backtest: 15000 },
};

function dataSources(d: RegionData): string[] {
  const u = new Set(d.used);
  const out: string[] = [
    'SYNTHETIC: the hazard event, every household/policyholder, SMS replies, claims and field reports are simulated. Geography, demographics, facilities and hazard inputs below are real public data.',
  ];
  if (u.has('census-pl2020')) out.push('U.S. Census Bureau, 2020 Census Redistricting Data (P.L. 94-171), block/tract internal points, POP100, HU100. https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171/ (public domain)');
  if (u.has('acs5')) out.push(`U.S. Census Bureau, American Community Survey ${ACS_YEAR - 4}-${ACS_YEAR} 5-year estimates, tables B01001, B11001, B11005, B11007, B25024, B25034, B18101, B08201, C16001, C16002, B25003, B25032, B14007 (table-based summary file). https://www2.census.gov/programs-surveys/acs/summary_file/${ACS_YEAR}/table-based-SF/ (public domain)`);
  if (u.has('census-gq2020')) out.push('U.S. Census Bureau, 2020 Census P.L. 94-171 table P5 (group quarters), P5_008N college/university student housing, by block (public domain)');
  if (u.has('ipeds')) out.push('NCES IPEDS 2023: institutional characteristics (HD2023) and fall enrollment (EF2023A, EFALEVEL=1 EFTOTLT). https://nces.ed.gov/ipeds/datacenter/DataFiles.aspx (public domain)');
  if (u.has('lodes')) out.push(`U.S. Census Bureau, LEHD Origin-Destination Employment Statistics (LODES8) ${LODES_YEAR}, WAC and RAC (S000, JT00). https://lehd.ces.census.gov/data/lodes/LODES8/ (public domain)`);
  if (u.has('svi2022')) out.push('CDC/ATSDR Social Vulnerability Index 2022 (tract): EP_DISABL, RPL_THEMES. https://svi.cdc.gov/ (Centers for Disease Control and Prevention/ Agency for Toxic Substances and Disease Registry/ Geospatial Research, Analysis, and Services Program. CDC/ATSDR Social Vulnerability Index 2022 Database)');
  if (u.has('nces')) out.push('NCES EDGE Public School Administrative Data 2023-24 (locations and enrollment). https://nces.ed.gov/programs/edge/ (public domain)');
  if (u.has('osm')) out.push('OpenStreetMap: hospitals, fire stations, shelters, communication masts, natural=coastline, via Overpass API. © OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright');
  out.push('Terrain Tiles on AWS Open Data (Terrarium encoding, zoom 12; sources include USGS 3DEP/NED, SRTM, GMTED2010, ETOPO1). https://registry.opendata.aws/terrain-tiles/');
  if (d.region.hazardType === 'earthquake') {
    out.push('USGS Earthquake Hazards Program, ShakeMap scenario catalog (HayWired M7.05 and BSSC2014 / legacy Bay Area scenarios), grid.xml MMI. https://earthquake.usgs.gov/scenarios/ (public domain)');
    if (u.has('cgs')) out.push('California Geological Survey, Seismic Hazard Zones: Liquefaction Zones (CGS_Liquefaction_Zones feature service). https://maps.conservation.ca.gov/cgs/EQZApp/');
  }
  for (const f of d.fallbacks) out.push(`FALLBACK: ${f}`);
  return out;
}

/** Compact but diffable JSON: one array element per line. */
function serialize(b: EventBundle): string {
  const arr = (items: unknown[]) => '[\n' + items.map((i) => '    ' + JSON.stringify(i)).join(',\n') + '\n  ]';
  const { hexes, households, facilities, ...worldHead } = b.world;
  const head = JSON.stringify(worldHead).slice(1, -1);
  return '{\n'
    + `  "world": {${head},\n  "facilities": ${arr(facilities ?? [])},\n  "hexes": ${arr(hexes)},\n  "households": ${arr(households)}},\n`
    + `  "events": ${arr(b.events)},\n`
    + `  "truth": ${arr(b.truth)}\n`
    + '}\n';
}

function parseArgs(argv: string[]): { region: RegionDef['id']; live?: number; backtest?: number; only?: string } {
  const alias: Record<string, RegionDef['id']> = { tx: 'tx-corpus-christi', ca: 'ca-bay-area', 'tx-corpus-christi': 'tx-corpus-christi', 'ca-bay-area': 'ca-bay-area' };
  const region = alias[argv[0] ?? ''];
  if (!region) throw new Error('usage: node real/main.ts <tx|ca> [--households N] [--backtest-households N] [--only live|backtest-1|...]');
  const get = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  return { region, live: num(get('--households')), backtest: num(get('--backtest-households')), only: get('--only') };
}

const args = parseArgs(process.argv.slice(2));
const region = REGIONS[args.region];
const t0 = Date.now();
const data = loadRegion(region);
const base = buildBaseWorld(data);
console.log(`[${region.id}] ${base.cells.length} cells, ${base.facilities.length} facilities, ${base.masts.length} masts (${Date.now() - t0} ms)`);
for (const f of data.fallbacks) console.log(`  FALLBACK: ${f}`);
const outDir = join(OUT_DIR, region.id);
mkdirSync(outDir, { recursive: true });
const scenarios: Scenario[] = region.hazardType === 'hurricane' ? TX_SCENARIOS : CA_SCENARIOS;
const sources = dataSources(data);
const metas: ReturnType<typeof simulate>['meta'][] = [];
for (const sc of scenarios) {
  if (args.only && args.only !== sc.eventId) continue;
  const t1 = Date.now();
  const isLive = sc.eventId === 'live';
  const n = isLive ? (args.live ?? DEFAULTS[region.id].live) : (args.backtest ?? DEFAULTS[region.id].backtest);
  const { bundle, meta } = simulate(base, data, sc, { regionPrefix: region.id.slice(0, 2), households: n, fieldReports: !isLive, dataSources: sources });
  const text = serialize(bundle);
  JSON.parse(text);
  const path = join(outDir, `${sc.eventId}.json`);
  writeFileSync(path, text);
  metas.push(meta);
  console.log(`  ${sc.eventId.padEnd(11)} ${n} households, ${bundle.events.length} events, ${(text.length / 1e6).toFixed(2)} MB (${Date.now() - t1} ms)`);
}
// With --only, merge the regenerated world(s) into the existing sim-meta.json instead of replacing it.
const metaPath = join(outDir, 'sim-meta.json');
let worlds: unknown[] = metas;
if (args.only && existsSync(metaPath)) {
  const prev = JSON.parse(readFileSync(metaPath, 'utf8')) as { worlds: Array<{ eventId: string }> };
  const order = scenarios.map((s) => s.eventId);
  worlds = [...prev.worlds.filter((w) => !metas.some((m) => m.eventId === w.eventId)), ...metas]
    .sort((a, b) => order.indexOf((a as { eventId: string }).eventId) - order.indexOf((b as { eventId: string }).eventId));
}
writeFileSync(metaPath, JSON.stringify({
  note: 'Simulator diagnostics for demo scripting. Not part of the contract; the engine must not train on this.',
  region: region.id, studyArea: base.notes, fallbacks: data.fallbacks, worlds,
}, null, 2) + '\n');
console.log(`[${region.id}] done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
