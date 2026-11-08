// Region definitions for the real-geography simulator. Bounding boxes, county FIPS codes and
// study-area selection rules. Events and policyholders are synthetic; geography is real.

export interface RegionDef {
  id: 'tx-corpus-christi' | 'ca-bay-area';
  name: string;
  hazardType: 'hurricane' | 'earthquake';
  stateFips: string;
  countyFips: string;   // 3-digit
  stateAbbr: string;    // lower-case, as used in LODES / PL file names
  tz: string;           // IANA time zone, for World.eventLocalHour / eventWeekday
  plStateDir: string;   // directory name on www2.census.gov for the PL 94-171 file
  /** Overpass / study bbox: [south, west, north, east]. */
  bbox: [number, number, number, number];
  center: { lat: number; lng: number };
  /** Target number of H3 res-8 cells and synthetic households. */
  targetCells: number;
  households: number;
}

export const REGIONS: Record<RegionDef['id'], RegionDef> = {
  'tx-corpus-christi': {
    id: 'tx-corpus-christi',
    name: 'Corpus Christi, TX (Nueces County)',
    hazardType: 'hurricane',
    stateFips: '48', countyFips: '355', stateAbbr: 'tx', tz: 'America/Chicago', plStateDir: 'Texas',
    bbox: [27.53, -97.70, 27.93, -97.03],
    center: { lat: 27.74, lng: -97.38 },
    targetCells: 750,
    households: 3600,
  },
  'ca-bay-area': {
    id: 'ca-bay-area',
    name: 'Alameda County, CA (Hayward Fault corridor)',
    hazardType: 'earthquake',
    stateFips: '06', countyFips: '001', stateAbbr: 'ca', tz: 'America/Los_Angeles', plStateDir: 'California',
    bbox: [37.46, -122.34, 37.91, -121.88],
    center: { lat: 37.68, lng: -122.10 },
    targetCells: 800,
    households: 3800,
  },
};
