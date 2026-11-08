// Shared by real/main.ts (fixed scenarios) and real/random.ts (random disasters).
import type { EventBundle } from '../../shared/types.ts';
import type { RegionData } from './load.ts';
import { ACS_YEAR, LODES_YEAR } from './sources.ts';

export function dataSources(d: RegionData): string[] {
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
export function serialize(b: EventBundle): string {
  const arr = (items: unknown[]) => '[\n' + items.map((i) => '    ' + JSON.stringify(i)).join(',\n') + '\n  ]';
  const { hexes, households, facilities, ...worldHead } = b.world;
  const head = JSON.stringify(worldHead).slice(1, -1);
  return '{\n'
    + `  "world": {${head},\n  "facilities": ${arr(facilities ?? [])},\n  "hexes": ${arr(hexes)},\n  "households": ${arr(households)}},\n`
    + `  "events": ${arr(b.events)},\n`
    + `  "truth": ${arr(b.truth)}\n`
    + '}\n';
}

