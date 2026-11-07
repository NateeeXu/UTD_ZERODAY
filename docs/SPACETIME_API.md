# Triage Loop: SpacetimeDB API

Reference for the frontend (manager dashboard, adjuster phone, policyholder SMS page) and anyone
running the backend. The module lives in `spacetimedb/`. Database name: `triage-loop`.

> All data is synthetic (fictional Harbor Bend, TX). The `household` table is public for that
> reason; with real customers it would sit behind per-role views.

## 1. What runs inside Spacetime

Everything below is a reducer or a table inside the database. The browser only subscribes and calls reducers.

```
scripts/seed.ts ──► seed_* reducers ──► hex, household, sim_truth (private), staged_event (private), model_state
                                                                         │
start_replay ──► replay_tick (scheduled, every 1 s) ── releases due staged events ──┐
submit_sms_reply (policyholder page) ───────────────────────────────────────────────┤
submit_field_report (adjuster, permission-checked) ─────────────────────────────────┤
                                                                                    ▼
                              onEvent(): insert event row ─► hex_stats counters + metrics (incremental)
                                                         └─► recomputeHex(): fusion engine for that cell
                                                               ├─► household_estimate (per household)
                                                               └─► hex_stats priority / verification / severity ...
```

- **Events**: `sms_sent`, `sms_reply`, `claim`, `field_report` tables. Every ingest path goes through one function, `onEvent` (`spacetimedb/src/ingest.ts`).
- **Permissions**: only `adjuster` members can file field reports. Only `manager` members (or the owner) can drive the replay and assign work. Only the owner can seed.
- **Real-time statistics**: `hex_stats` counters and global `metrics` are updated in the same transaction as the event.
- **Fusion**: the real engine (`engine/src`, logistic regression calibrated on backtests) is copied into `spacetimedb/src/fusion/engine/` and runs inside the reducers. `metrics.engine = 'engine'` shows it is active. If no model is loaded, a temporary rule-based estimator (`src/fusion/stub.ts`) is used and `metrics.engine = 'stub'`.
- **Learning loop**:
  - A field report updates its household and cell right away; the engine's neighbour update adjusts the other households in that cell too.
  - Source trust moves one capped step after every 10 non-holdout field reports.
  - Holdout households are scored against the private truth into `metrics.holdout*`.

## 2. Quick start (local)

```bash
# terminal 1: local server (keep running; data persists in ~/.local/share/spacetime/data)
spacetime start

# terminal 2
cd spacetimedb
npm install
npm run publish:local            # = spacetime publish -s local --module-path . --yes triage-loop
npm run seed                     # loads data/live.json (+ data/model.json), sets passcodes, resets to t=0
npm run smoke                    # optional end-to-end check (roles, replay, field report, rejections)
```

Other commands (run inside `spacetimedb/`):

| Command | What it does |
|---|---|
| `npm run publish:local:clean` | Republish and **delete all data** (needed after a breaking schema change), then `npm run seed` again |
| `npm run generate` | Regenerate `spacetimedb/bindings/` (used by the Node scripts; `.ts` import suffixes) |
| `node scripts/seed.ts --model-only` | Reload `data/model.json` after recalibration, then reset the demo |
| `node scripts/seed.ts --wipe` | Delete the whole world first (hexes, households, events), then seed |
| `npm run sync-engine` | Re-copy `engine/src/*.ts` into `src/fusion/engine/` (do this after engine changes, then typecheck and publish) |
| `node scripts/parity.ts --t 1440 --reports 25` | Check that the database's estimates equal the engine's offline `estimateAll` exactly |
| `npm run typecheck` | Type-check the module and the scripts |
| `spacetime logs -s local triage-loop -f` | Follow module logs (rejected reducer calls show up as ERROR lines) |
| `spacetime sql -s local triage-loop "SELECT * FROM metrics"` | Ad-hoc SQL (the owner can also read private tables) |
| `spacetime call -s local triage-loop jump_to 1440` | Call a reducer from the CLI (as the owner) |

**Always pass `-s local`**: the CLI's default server is Maincloud.

### Frontend bindings

Generate your own copy into the client (default import style, for Vite or another bundler):

```bash
spacetime generate --lang typescript --out-dir client/src/module_bindings --module-path spacetimedb
```

Client package: `npm install spacetimedb` (same major version as the CLI, 2.x). React helpers come from `spacetimedb/react`.

## 3. Roles, identities, passcodes (demo auth)

- Every connection has an **Identity**. A browser without a stored token gets a fresh anonymous identity from the server. **Persist the token** (`onConnect` gives it to you) in `localStorage`, or the user loses their role on reload.
- Use a different storage key per screen (for example `triage-token-manager` and `triage-token-adjuster`). Then one laptop can run the manager and adjuster screens side by side as two identities.
- Roles are self-assigned with `join_as(role, name, passcode)`:
  - `manager`, `adjuster`: need the **staff passcode**.
  - `policyholder_demo`: needs the **reply passcode** (the staff passcode also works).
- The policyholder page can skip `join_as` and pass the reply passcode directly to `submit_sms_reply`.
- Passcodes live in the private `config` table and are set by `scripts/seed.ts` from `STAFF_PASSCODE` / `REPLY_PASSCODE`. The defaults are `triage-staff` / `triage-reply`, which are public in this repo, so **set your own for Maincloud**.
- The **owner** (the identity that published the module, i.e. the logged-in `spacetime` CLI) can seed and can also act as a manager.
- This is demo auth. A real deployment would use OIDC (SpacetimeAuth, Auth0, Clerk) and an owner-managed member list instead of shared passcodes.

## 4. Public tables

Field names below are the **client (camelCase)** names. In SQL (subscriptions, `spacetime sql`) use snake_case: `householdId` becomes `household_id`, `p0Cells` becomes `p_0_cells`. Types: `u64` is a `bigint`, `timestamp` is a `Timestamp` (`.toDate()`), `identity` is an `Identity` (`.toHexString()`). Times `t` / `simMinutes` are **minutes after landfall** (0 to 4320 = 72 h).

### `world` (singleton, id = 0)
| field | type | meaning |
|---|---|---|
| eventId, name, landfallIso | string | e.g. `live`, `Harbor Bend, TX`, `2026-11-07T04:00:00.000Z` |
| centerLat, centerLng | f64 | map center |

### `hex` (331 rows, static)
| field | type | meaning |
|---|---|---|
| hex | string (PK) | H3 index, resolution 8 |
| displayOrder | u32 | stable order (file order, sorted by hex id) |
| lat, lng | f64 | cell center |
| windMph, floodDepthFt, towerOutagePct | f64 | hazard layer |
| analystZone | u8 | 0 none, 1 moderate, 2 severe (human-annotated, deliberately imperfect) |

### `household` (3000 rows, static)
`id` (PK, e.g. `live-h00001`), `hex`, `lat`, `lng`, `age65`, `livesAlone`, `medicalDevice`, `windCovered`, `floodPolicy`, `earthquakeEndorsement`, `phoneOnFile`, `holdout` (true = evaluation only; adjusters can still visit). Same meaning as `Household` in `shared/types.ts`.

### Event tables: `sms_sent`, `sms_reply`, `claim`, `field_report`
Common fields:

| field | type | meaning |
|---|---|---|
| id | u64 (PK, auto) | not sequential; order by `t` or `ingestedAt` |
| householdId, hex | string | |
| t | u32 | sim minute of the event |
| source | string | `replay` (from data/live.json) or `live` (submitted during the demo) |
| ingestedBy | identity | who caused the insert (the database itself for replayed events) |
| ingestedAt | timestamp | wall-clock insert time |

Extra fields:
- `sms_reply`: `safety` (`safe` / `needs_help`), `damage` (0 to 3).
- `claim`: `peril` (`wind` / `flood`), `reportedDamage` (0 to 3).
- `field_report`: `adjusterId` (the adjuster's display name), `safety` (`safe` / `needs_help` / `unsure`), `damage`, `note`.

### `replay_state` (singleton, id = 0)
| field | type | meaning |
|---|---|---|
| running | bool | replay clock ticking |
| simMinutes | f64 | current sim time |
| speed | f64 | sim minutes per real second |
| nextSeq, totalStaged | u32 | released / total staged events (progress bar) |
| maxMinutes | u32 | 4320 |
| lastTickAt | timestamp | |

### `hex_stats` (one row per cell): the map layer
| field | type | meaning |
|---|---|---|
| hex, displayOrder | | |
| households, phones | u32 | households, households with phoneOnFile |
| smsSent, smsReplies | u32 | distinct households texted / replied |
| replyRate | f64 | smsReplies / smsSent |
| severeReplies, helpReplies | u32 | reply events with damage ≥ 2 / safety = needs_help |
| claims, fieldReports | u32 | event counts |
| verifiedHouseholds | u32 | distinct households with a field report |
| **priority** | string | `P0` / `P1` / `P2` (color) |
| **verification** | string | `verified` / `needs_verification` (hatching) |
| severity | f64 0–1 | `1 - (1 - severeShare)(1 - maxPNeedsHelp)` |
| confidence | f64 0–1 | evidence coverage x decidedness |
| silence | f64 0–1 | expected signal that is missing (hazard-weighted) |
| expectedSevere | f64 | expected households with damage ≥ 2 |
| maxPNeedsHelp | f64 | highest P(needs help) in the cell |
| reason | string | one-line explanation for tooltips, e.g. `~10.1 of 14 likely severe; silence 86%: 0/12 replied, outage 100%; confidence 5%` |
| updatedAt, updatedSimMinutes | | last material change of the fusion output |

### `household_estimate` (one row per household)
| field | type | meaning |
|---|---|---|
| householdId (PK), hex | string | |
| pSevere | f64 | P(damage ≥ 2) |
| pNeedsHelp | f64 | P(safety = needs_help) |
| uncertainty | f64 0–1 | higher = less sure |
| verified | bool | has a field report |
| inspectScore | f64 0–1 | active-inspection ranking (engine formula: severe + help + uncertainty + cell silence + needs-verification). 0 when verified. **Sort the adjuster queue by this.** |
| updatedAt | timestamp | rows are rewritten only when a value moves by ≥ 0.0005 |

### `metrics` (singleton, id = 0): the three small dashboard numbers and more
| field | meaning |
|---|---|
| hexes, households | totals |
| smsSent, smsReplies, helpReplies, claims, fieldReports | running totals |
| verifiedHouseholds, verifiedCoverage | "verified coverage" (0–1) |
| p0Cells, p1Cells, p2Cells, needsVerificationCells | cell counts by status |
| holdoutN | 0 until first computed (450 when ready) |
| holdoutBrierSevere, holdoutBrierHelp | "holdout error" (Brier, lower is better), computed every sim hour, on jump, reset |
| holdoutSevereRecall | share of truly severe holdout households with pSevere ≥ 0.5 |
| holdoutSimMinutes | sim time of that evaluation |
| trustHazard, trustSms, trustClaims, trustUpdates | "source trust" (0–1) and how many batch updates happened |
| modelVersion, engine | `engine` = real fusion engine; `stub` = temporary rules |

### `model_state` (singleton, id = 0)
`loaded`, `version`, `paramsJson` (the ModelParams JSON; parse it for calibration Brier/ECE and feature names). Trust fields:
- `baseTrust*`: trust at calibration.
- `trust*`: current trust.
- `trustUpdates`.
- `lastScore*`: 1 − Brier of each source in the last batch, or −1 if the source voiced too few opinions.
- `pendingFieldReports`: progress toward the next update (batch of 10).
- `holdoutReports`.

### `member`
`identity` (PK), `role` (`manager` / `adjuster` / `policyholder_demo`), `name`, `joinedAt`. Use it for the adjuster picker in the manager UI (`identity.toHexString()` is what `assign` expects).

### `assignment`
`id` (u64), `householdId`, `hex`, `adjuster` (identity), `assignedBy`, `status` (`assigned` / `done` / `cancelled`), `createdAt`, `updatedAt`. A field report by the assigned adjuster marks it `done` automatically.

### Views (per caller)
- `my_member`: the caller's own member row (0 or 1 rows). Use it to show "joined as ...".
- `my_assignments`: the caller's own assignments (the adjuster task list).

### Private tables (not subscribable)
- `config`: owner and passcodes.
- `sim_truth`: TruthRow, used only for holdout scoring.
- `staged_event`: data/live.json events waiting for the replay clock.
- `replay_tick`: schedule.

## 5. Reducers

Client call style: `conn.reducers.submitFieldReport({ householdId, safety, damage, note })` returns a Promise that **rejects with the error message** when the reducer throws (wrong role, bad input). React: `const submit = useReducer(reducers.submitFieldReport)`.

| Reducer (SQL name) | Args | Who | Effect |
|---|---|---|---|
| `join_as` | role, name, passcode | anyone | Create or replace the caller's member row (switching roles is allowed) |
| `leave` | — | anyone | Remove the caller's member row |
| `submit_sms_reply` | householdId, safety (`safe`/`needs_help`), damage (0–3), passcode (`''` if joined) | `policyholder_demo` / `manager` member, owner, or anyone with the reply passcode | Inserts an `sms_reply` at the current sim minute (and an `sms_sent` if that household was never texted), then recomputes the cell |
| `submit_field_report` | householdId, safety (`safe`/`needs_help`/`unsure`), damage (0–3), note (≤ 500 chars) | **`adjuster` members only** | Inserts a `field_report`, recomputes the cell (household becomes verified), completes the adjuster's assignment, and feeds the trust batch |
| `assign` | householdId, adjusterIdentityHex | manager / owner | New `assigned` row; cancels another adjuster's open assignment for that household |
| `assign_hex` | hex, adjusterIdentityHex, count (1–50) | manager / owner | Active inspection: assigns the `count` unverified, unassigned households of the cell with the highest `inspectScore` |
| `update_assignment` | id (u64), status | the assigned adjuster, or manager / owner | Set `assigned` / `done` / `cancelled` |
| `remove_member` | identityHex | manager / owner | Housekeeping |
| `start_replay` | speed (sim min per second, 0 < speed ≤ 1440) | manager / owner | Starts or resumes the 1-second tick (also changes speed). Suggested: 30 (72 h in 2.4 min) or 60 |
| `set_speed` | speed | manager / owner | Change speed only |
| `pause_replay` | — | manager / owner | Stops ticking (no scheduled calls while paused) |
| `jump_to` | minutes (0–4320) | manager / owner | Forward: release everything due at once. **Backward: resets the demo** (drops live replies, field reports, assignments) and replays up to `minutes` |
| `reset_demo` | — | manager / owner | Clear all events, estimates and assignments, rewind to t = 0, recompute (members are kept) |
| `recompute_all` | — | manager / owner | Recount every counter from the event tables and recompute every cell (repair tool) |
| `refresh_metrics` | — | manager / owner | Rescore the holdout set now |
| `set_passcodes` | staffPasscode, replyPasscode | owner | Demo passcodes (≥ 4 chars) |
| `seed_world` | eventId, name, landfallIso, centerLat, centerLng | owner | Upsert `world` |
| `seed_hexes` | hexes: HexInput[] | owner | Upsert cells (+ empty `hex_stats` rows) |
| `seed_households` | households: HouseholdInput[] | owner | Upsert households |
| `seed_truth` | rows: TruthInput[] | owner | Upsert private truth |
| `seed_staged_events` | events: StagedEventInput[] (seq, t, kind, householdId, safety, damage, peril, reportedDamage, adjusterId) | owner | Upsert private staged events (seq = order in the bundle) |
| `load_model` | json (ModelParams) | owner | Validate and store data/model.json, reset trust to its `sourceTrust`, recompute everything |
| `wipe_world` | — | owner | Delete world, households, truth, staged events, events, stats |

The seeding batches are typed arrays (not JSON strings), so bindings check them.

## 6. Subscriptions per screen

Subscribe once per screen. All tables are small (the biggest is `household` / `household_estimate` with 3,000 rows each). With React, `useTable(tables.hexStats)` subscribes and returns `[rows, isReady]`; filtered: `useTable(tables.household.where(r => r.hex.eq(hexId)))`.

**Manager dashboard**
```sql
SELECT * FROM world
SELECT * FROM hex
SELECT * FROM hex_stats            -- map color (priority) + hatching (verification) + tooltip (reason)
SELECT * FROM metrics              -- verified coverage, holdout error, source trust, P0/P1/P2 counts
SELECT * FROM replay_state         -- clock, progress, play/pause state
SELECT * FROM model_state          -- calibration info, trust batch progress
SELECT * FROM member               -- adjuster picker
SELECT * FROM assignment
SELECT * FROM household            -- action queue details (coverage flags, vulnerability)
SELECT * FROM household_estimate   -- action queue: sort by pNeedsHelp / inspectScore
SELECT * FROM field_report         -- live event feed (+ sms_reply, claim if wanted)
SELECT * FROM sms_reply
```
- Action queue (P0 first): cells with `priority = 'P0'`, then households by `pNeedsHelp` desc.
- Verification queue: cells with `verification = 'needs_verification'` by `severity` desc, or households by `inspectScore` desc (cap about 3 per cell to spread adjusters).
- Assign with `assign_hex(hex, adjusterHex, 3)`.
- Live feed: `onInsert` callbacks on `field_report` / `sms_reply` / `claim`, newest first (`ingestedAt`).

**Adjuster phone**
```sql
SELECT * FROM my_member
SELECT * FROM my_assignments
SELECT * FROM household WHERE id = 'live-h00644'            -- one query per assigned household
SELECT * FROM household_estimate WHERE household_id = 'live-h00644'
SELECT * FROM hex_stats WHERE hex = '8848906cadfffff'        -- context for the card
SELECT * FROM sms_reply WHERE household_id = 'live-h00644'   -- contact history
SELECT * FROM claim WHERE household_id = 'live-h00644'
```
Re-subscribe when `my_assignments` changes. The whole `household` + `household_estimate` tables are also fine on Wi-Fi. The form calls `submit_field_report`.

**Policyholder SMS page** (QR code, e.g. `/reply?h=live-h00123&code=<reply passcode>`)
```sql
SELECT * FROM household WHERE id = 'live-h00123'
SELECT * FROM sms_reply WHERE household_id = 'live-h00123'
```
SAFE / HELP and 0–3 call `submit_sms_reply(householdId, safety, damage, code)`. The reply lands on the manager map within one round trip.

## 7. Minimal client code

```ts
import { DbConnection, tables, reducers } from './module_bindings';
import { SpacetimeDBProvider, useTable, useReducer, useSpacetimeDB } from 'spacetimedb/react';

const HOST = import.meta.env.VITE_SPACETIME_HOST ?? 'ws://127.0.0.1:3000'; // Maincloud: 'https://maincloud.spacetimedb.com'
const DB = import.meta.env.VITE_SPACETIME_DB ?? 'triage-loop';
const TOKEN_KEY = 'triage-token-manager'; // one key per screen

const builder = DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB)
  .withToken(localStorage.getItem(TOKEN_KEY) ?? undefined)
  .onConnect((_conn, identity, token) => {
    localStorage.setItem(TOKEN_KEY, token);
    console.log('connected as', identity.toHexString());
  });

export function App() {
  return <SpacetimeDBProvider connectionBuilder={builder}><Map /></SpacetimeDBProvider>;
}

function Map() {
  const [cells, ready] = useTable(tables.hexStats);
  const [metrics] = useTable(tables.metrics);
  const joinAs = useReducer(reducers.joinAs);
  const startReplay = useReducer(reducers.startReplay);
  // joinAs({ role: 'manager', name: 'Dana', passcode }).catch(e => alert(e.message));
  // startReplay({ speed: 30 });
  return null;
}
```

Node scripts (`spacetimedb/scripts/lib.ts`) show the non-React form: `connect()`, `subscriptionBuilder().onApplied(...).subscribe([...])`, `conn.db.hexStats.iter()`.

## 8. Fusion engine integration

- `src/fusion/index.ts` is the adapter. `recomputeHex(ctx, hexId)` gathers one cell's households and events from the tables and calls a pure `CellEstimator`, then writes `household_estimate` and the fusion columns of `hex_stats`.
- `src/fusion/engine-adapter.ts` builds the engine's `Snapshot` for that one cell, plus world reference rates (`refReplyRate`, `claimRatePerHazard`) computed from `hex_stats`. It then calls the engine's own `estimateCellHouseholds` and `classifyCell`.
- `scripts/parity.ts` checks that the database matches the engine's offline `estimateAll` on the same events:
  - checked at t = 300, 1440 and 4320, with and without live field reports;
  - max difference about 1e-15, 0 priority or verification mismatches.
- `src/fusion/stub.ts`: the TEMPORARY rule-based fallback. It is used only when no model is loaded or the engine rejects `model.json`.
- `src/fusion/trust.ts`: batched trust learning with the engine's rules:
  - per source, 1 − Brier of its opinions against the adjuster's finding;
  - a step of learning rate 0.1 toward that score, clamped to [0.3, 1];
  - batch of 10 non-holdout reports.

  The engine keeps trust display-only by default (`cfg.trust.applyToInference = false`).
- **After the engine changes**: `npm run sync-engine && npm run typecheck && npm run publish:local && node scripts/parity.ts --t 1440 --reports 25`.
- **After `data/model.json` changes**: `node scripts/seed.ts --model-only`.

## 9. Publishing to Maincloud (when the team decides)

The judges' phones need a public URL, so the live demo should run on Maincloud.

```bash
cd spacetimedb
spacetime login                                   # already done on the team laptop
spacetime publish -s maincloud --module-path . triage-loop-<suffix>    # names are global; `triage-loop` may be taken
SPACETIME_HOST=https://maincloud.spacetimedb.com SPACETIME_DB=triage-loop-<suffix> \
  STAFF_PASSCODE='<choose>' REPLY_PASSCODE='<choose>' npm run seed
spacetime logs -s maincloud triage-loop-<suffix> -f
```

- Client env: `VITE_SPACETIME_HOST=https://maincloud.spacetimedb.com`, `VITE_SPACETIME_DB=triage-loop-<suffix>`.
- The seed script authenticates as the CLI login (`~/.config/spacetime/cli.toml`) or `SPACETIME_TOKEN`; that identity becomes the owner on publish.
- Keep the local server as the offline fallback (same commands with `-s local`).

## 10. Limits and costs

- **Per-event cost**: one live event recomputes one cell (about 9 households; 5 index scans) plus one pass over `hex_stats` for the world reference rates.
- **Batch costs**:
  - a full `jump_to(4320)` (4,620 events + 331 cells + holdout scoring) takes about 65 ms locally;
  - `recompute_all` takes about 10–20 ms.
- **World refs drift**: each event slightly changes the world reference rates, which affect every cell. Untouched cells pick this up at the next full recompute (every sim hour during replay, and on jump or reset). Between those, untouched cells can lag by a small amount.
- **Maincloud energy**:
  - While running, `replay_tick` fires once per second, and a full recompute runs every 60 sim minutes (every 2 s at speed 30). **Pause when not demoing**: a paused replay schedules nothing.
  - Rows are only rewritten when a value moves by ≥ 0.0005, so subscribers do not get 3,000 updates per tick from the model's time feature.
- **Demo auth only**: passcodes in a private table, roles self-assigned. Anyone holding the staff passcode can become a manager.
- **Live SMS replies**: a reply for a household that was never texted also inserts an `sms_sent` row, so `replyRate` stays ≤ 1.
- **Field report attribution**: a field report's `adjusterId` is the adjuster's display name; the identity is in `ingestedBy`.
