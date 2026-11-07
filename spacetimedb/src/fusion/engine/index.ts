// COPIED from engine/src/index.ts by spacetimedb/scripts/sync-engine.ts. Do not edit here; edit engine/src and re-sync.
// Public surface of the fusion engine core. Everything here is pure,
// deterministic and free of Node APIs, so it can be copied into the
// SpacetimeDB TypeScript module as-is.
//
// Intended for the Spacetime module (online path):
//   config.ts    DEFAULT_CONFIG, TriageConfig
//   features.ts  buildSnapshot, applyEventToSignals, aggregateCellCounts, computeRefs,
//                fillExpected, householdFeatureRecord, selectFeatures, hazardScore
//   logistic.ts  sigmoid, predictProb (inference only)
//   infer.ts     resolveModels, estimateHousehold, classifyCell, cellSilence,
//                estimateHouseholdsFromSnapshot, estimateHexesFromSnapshot, estimateAll
//   learning.ts  initLearningState, observeFieldReport, recordFieldReport,
//                applyFieldReportToSnapshot, reestimateCell, localUpdate
//   active.ts    recommendInspections, recommendCells, routeOrder
//   metrics.ts   brier, ece, verifiedCoverage (for the live metrics table)
// Offline only (calibration): logistic.ts fitLogistic, metrics.ts auc/summarize.

export * from './config.ts';
export * from './rng.ts';
export * from './features.ts';
export * from './logistic.ts';
export * from './metrics.ts';
export * from './infer.ts';
export * from './learning.ts';
export * from './active.ts';
