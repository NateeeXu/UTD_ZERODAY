// Constants describing the public datasets, plus small geo helpers shared by fetch and generate.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = join(HERE, '..', '..');
export const RAW_DIR = join(ROOT_DIR, 'data', 'raw');
export const OUT_DIR = join(ROOT_DIR, 'data', 'real');

/** ACS 5-year vintage (2020-2024 estimates). */
export const ACS_YEAR = 2024;
/**
 * ACS detailed tables used:
 * - B01001 Sex by age: total pop (E001); under 18 = E003-E006 + E027-E030; 65+ = E020-E025 + E044-E049.
 * - B11001 Household type: total households (E001); householder living alone (E008).
 * - B11005 Households by presence of people under 18: with 1+ people under 18 (E002).
 * - B11007 Households by presence of people 65+ by household size: with 1+ people 65+ (E002);
 *   1-person household with a person 65+ = 65+ living alone (E003).
 * - B25024 Units in structure: total (E001); mobile home (E010).
 * - B25034 Year structure built: total (E001); built 1979 or earlier (E007-E011).
 * - B18101 Sex by age by disability status: with a disability by age band (65+ = E016,E019,E035,E038;
 *   under 65 = E004,E007,E010,E013,E023,E026,E029,E032), denominators the matching age totals.
 * - B08201 Household size by vehicles available: total households (E001); no vehicle (E002).
 * - C16002 Household language by limited-English-speaking status: English only (E002), Spanish (E003,
 *   limited E004), other Indo-European (E006, limited E007), Asian & Pacific Island (E009, limited E010),
 *   other (E012, limited E013).
 * - C16001 Language spoken at home, population 5+: used only to split the Asian & Pacific Island and
 *   other groups into Korean (E018), Chinese (E021), Vietnamese (E024), Tagalog (E027), other Asian &
 *   PI (E030), Arabic (E033), other (E036); and Indo-European into French/Haitian/Cajun (E006),
 *   German (E009), Russian/Polish/Slavic (E012), other Indo-European (E015).
 */
export const ACS_TABLES = ['b01001', 'b11001', 'b11005', 'b11007', 'b25024', 'b25034', 'b18101', 'b08201', 'c16001', 'c16002', 'b25003', 'b25032', 'b14007'] as const;
export const LODES_YEAR = 2023;
export const TERRAIN_ZOOM = 12;

export interface ShakeScenario {
  eventId: string;          // USGS scenario catalog id
  label: string;
  role: 'live' | 'backtest-1' | 'backtest-2' | 'backtest-3';
}
export const SHAKEMAP_SCENARIOS: ShakeScenario[] = [
  { eventId: 'gllegacyhaywiredm7p05_se', label: 'HayWired M7.05 Hayward Fault scenario (USGS)', role: 'live' },
  { eventId: 'bssc2014sanandreaspeninsula2_m7p38_se', label: 'San Andreas (Peninsula) M7.38 scenario (USGS BSSC2014)', role: 'backtest-1' },
  { eventId: 'nclegacycalaverascnccm7p0_se', label: 'Calaveras North+Central M7.0 scenario (USGS legacy)', role: 'backtest-2' },
  { eventId: 'bssc2014haywardso2011cfmellb_m7p_se', label: 'Hayward (South) M7.0 scenario (USGS BSSC2014)', role: 'backtest-3' },
];

// ---- Web-mercator tile math (for terrain tiles) ----
export function lngToTileX(lng: number, z: number): number { return ((lng + 180) / 360) * 2 ** z; }
export function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}
export function tilesForBbox(bbox: [number, number, number, number], z: number, pad = 0): Array<[number, number]> {
  const [s, w, n, e] = bbox;
  const x0 = Math.floor(lngToTileX(w - pad, z));
  const x1 = Math.floor(lngToTileX(e + pad, z));
  const y0 = Math.floor(latToTileY(n + pad, z));
  const y1 = Math.floor(latToTileY(s - pad, z));
  const out: Array<[number, number]> = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y]);
  return out;
}
