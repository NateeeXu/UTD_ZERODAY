// Event configurations. Every place name, storm and household here is fictional.
// The basemap coordinates are used only to position the grid on a map; no real data is involved.

export interface StormConfig {
  /** x offset (km, + = east) where the track crosses the coastline (south edge). */
  coastCrossKm: number;
  /** Heading in degrees from due north; negative = toward the north-west. */
  headingDeg: number;
  /** Track curvature: extra x offset (km) per km^2 of northward travel. */
  curvature: number;
  /** Peak sustained wind at the coast on the track (mph). */
  vmaxMph: number;
  /** e-folding distance (km) of wind decay away from the track. */
  windDecayKm: number;
  /** Peak storm surge at the coastline (ft). */
  surgeFt: number;
  /** e-folding distance (km) of surge decay inland. */
  surgeInlandKm: number;
  /** Number of additional random tower-outage clusters (besides the one on the track). */
  extraOutageClusters: number;
}

export interface EventConfig {
  eventId: string;
  name: string;
  seed: number;
  landfallIso: string;
  center: { lat: number; lng: number };
  households: number;
  /** Include adjuster field_report events (backtests only; live reports come from the demo). */
  fieldReports: boolean;
  storm: StormConfig;
}

/** Default live-event center. Only used to place the fictional grid on a basemap. */
export const LIVE_CENTER = { lat: 28.7, lng: -96.2 };

export const H3_RESOLUTION = 8;
export const GRID_RADIUS = 10; // gridDisk(center, 10) -> 331 cells
export const HORIZON_MIN = 4320; // 72 hours after landfall
export const HOUSEHOLDS_PER_EVENT = 3000;
export const HOLDOUT_SHARE = 0.15;
export const FIELD_REPORT_SHARE = 0.12; // share of non-holdout households with a field report (backtests)

export const LIVE_EVENT: EventConfig = {
  eventId: 'live',
  name: 'Harbor Bend, TX',
  seed: 20261107,
  landfallIso: '2026-11-07T04:00:00.000Z',
  center: LIVE_CENTER,
  households: HOUSEHOLDS_PER_EVENT,
  fieldReports: false,
  storm: {
    coastCrossKm: -1.5,
    headingDeg: -18,
    curvature: 0.012,
    vmaxMph: 136,
    windDecayKm: 4.5,
    surgeFt: 11,
    surgeInlandKm: 4.5,
    extraOutageClusters: 2,
  },
};

// Six fictional past storms, each in its own fictional world.
export const BACKTEST_EVENTS: EventConfig[] = [
  {
    eventId: 'backtest-1', name: 'Pelican Point, TX', seed: 1101, landfallIso: '2019-09-14T07:00:00.000Z',
    center: { lat: 28.45, lng: -96.6 }, households: HOUSEHOLDS_PER_EVENT, fieldReports: true,
    storm: { coastCrossKm: 2.0, headingDeg: -25, curvature: 0.0, vmaxMph: 118, windDecayKm: 5.0, surgeFt: 7, surgeInlandKm: 4.0, extraOutageClusters: 2 },
  },
  {
    eventId: 'backtest-2', name: 'Saltgrass Bay, TX', seed: 2202, landfallIso: '2020-08-27T03:30:00.000Z',
    center: { lat: 28.9, lng: -95.75 }, households: HOUSEHOLDS_PER_EVENT, fieldReports: true,
    storm: { coastCrossKm: -4.0, headingDeg: 10, curvature: 0.015, vmaxMph: 145, windDecayKm: 4.0, surgeFt: 13, surgeInlandKm: 5.0, extraOutageClusters: 3 },
  },
  {
    eventId: 'backtest-3', name: 'Cypress Landing, TX', seed: 3303, landfallIso: '2021-09-02T22:00:00.000Z',
    center: { lat: 29.1, lng: -95.3 }, households: HOUSEHOLDS_PER_EVENT, fieldReports: true,
    storm: { coastCrossKm: 5.5, headingDeg: -35, curvature: -0.01, vmaxMph: 98, windDecayKm: 6.0, surgeFt: 5, surgeInlandKm: 3.5, extraOutageClusters: 2 },
  },
  {
    eventId: 'backtest-4', name: 'Redfish Hollow, TX', seed: 4404, landfallIso: '2022-10-09T12:00:00.000Z',
    center: { lat: 28.25, lng: -96.85 }, households: HOUSEHOLDS_PER_EVENT, fieldReports: true,
    storm: { coastCrossKm: 0.0, headingDeg: -5, curvature: 0.02, vmaxMph: 132, windDecayKm: 4.5, surgeFt: 10, surgeInlandKm: 4.5, extraOutageClusters: 2 },
  },
  {
    eventId: 'backtest-5', name: 'Gull Harbor, TX', seed: 5505, landfallIso: '2023-08-21T05:15:00.000Z',
    center: { lat: 27.95, lng: -97.1 }, households: HOUSEHOLDS_PER_EVENT, fieldReports: true,
    storm: { coastCrossKm: -6.0, headingDeg: 28, curvature: -0.015, vmaxMph: 110, windDecayKm: 5.5, surgeFt: 6, surgeInlandKm: 4.0, extraOutageClusters: 3 },
  },
  {
    eventId: 'backtest-6', name: 'Oyster Creek Flats, TX', seed: 6606, landfallIso: '2024-09-30T18:45:00.000Z',
    center: { lat: 29.3, lng: -94.95 }, households: HOUSEHOLDS_PER_EVENT, fieldReports: true,
    storm: { coastCrossKm: 3.0, headingDeg: -12, curvature: 0.008, vmaxMph: 138, windDecayKm: 4.0, surgeFt: 12, surgeInlandKm: 5.5, extraOutageClusters: 2 },
  },
];
