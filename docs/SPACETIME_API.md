# Triage Loop: SpacetimeDB API

Reference for the frontend (manager dashboard, adjuster phone, policyholder SMS page) and anyone
running the backend. The module lives in `spacetimedb/`. **One database per world**: the same module
is published under different names and seeded with one bundle each.

| World | Bundle + model | Cells / households / events | Hazard | Local database |
|---|---|---|---|---|
| Harbor Bend, TX (fictional) | `data/live.json` + `data/model.json` | 331 / 3,000 / 4,620 | hurricane (night) | `triage-loop` |
| Corpus Christi, TX | `data/real/tx-corpus-christi/{live,model}.json` | 449 / 20,000 / 33,249 | hurricane (Sat 02:00) | `triage-loop-tx` |
| Bay Area (Hayward Fault), CA | `data/real/ca-bay-area/{live,model}.json` | 611 / 30,000 / 35,994 | earthquake (Thu 10:00: daytime + school hours) | `triage-loop-ca` |

> All households, events and outcomes are synthetic. The real-geography worlds use real public
> geography, demographics, facilities and hazard inputs (see `world.dataSourcesJson`). The
> `household` table is public for that reason; with real customers it would sit behind per-role views.

## 0. Shared Maincloud databases (use these for frontend work)

All three run the v2 module (engine v2) and use the same private passcodes.

| Database (client `withDatabaseName`) | World | Households | Cells | Use |
|---|---|---|---|---|
| `triage-loop-nateeexu-dev` | Harbor Bend, TX (fictional, `data/live.json`) | 3,000 | 331 | Development; reset it freely |
| `triage-loop-nateeexu-tx` | Corpus Christi, TX hurricane (`data/real/tx-corpus-christi`) | 20,000 | 449 | Demo |
| `triage-loop-nateeexu-ca` | Alameda County, CA Hayward Fault quake (`data/real/ca-bay-area`) | 30,000 | 611 | Demo |

| Setting | Value |
|---|---|
| Host (client `withUri`) | `wss://maincloud.spacetimedb.com` |
| Passcodes | **not in the repo**: ask the database owner; they are in the owner's `spacetimedb/.env` (see `spacetimedb/.env.example`) |
| Full-recompute cadence | 120 sim minutes on all three (set at seed time with `--cadence`) |

- The default passcodes in this doc (`triage-staff` / `triage-reply`) work only on a local server.
- Membership is per database: join each world separately with `join_as`.
- Only the owner can seed or wipe. Managers can `reset_demo`, `start_replay`, `pause_replay`, `jump_to`.
- **Pause the replay when you are not testing**: a running replay ticks every second and uses Maincloud energy. All three were left paused at t = 0.
- Client bindings: `spacetime generate --lang typescript --out-dir client/src/module_bindings --module-path spacetimedb` (needs the CLI), or copy `spacetimedb/bindings/`. Regenerate whenever the schema changes.
- `spacetime sql` and `spacetime call` run inside `spacetimedb/` pick up `spacetime.json` (database `triage-loop`). Run them from another folder, e.g. `spacetime sql -s maincloud triage-loop-nateeexu-tx "SELECT * FROM metrics"`.
- Schema changes that add columns need `--delete-data=always` and a reseed (owner only, see §9).

## 0b. "No one overlooked" (accounted / unaccounted)

**Accounted** = we heard from the household (SMS reply, claim, field report, missing-member report, open referral) or a manager/adjuster closed it with a documented reason. Everyone else is **unaccounted**, never "fine". `accounted` never flips back on its own, so the headline number only rises over the replay.

Five guarantees, each backed by data the frontend can show:
1. **Nobody is silently "fine"**: silence = unaccounted; the only exits are contact or a documented closure (`close_household`).
2. **Everyone has a next step**: every household has an `escalation`, and the ladder ends with a person at the door (low-risk households too, after 48 h).
3. **Nobody starves in the queue**: `unaccounted_queue` ranks by risk x waiting time, so every hour of silence raises a household.
4. **"Safe" expires for high-risk people**: a vulnerable / high-risk household whose last contact is older than 12 h goes back to the queue as `recheck`.
5. **Life-safety reports cannot stall**: a needs-help reply or a missing member opens a referral with timers (not referred in 30 min, or not acknowledged in 60 min → `referral_overdue`).

| Where | Columns |
|---|---|
| `metrics` | `accounted`, `unaccounted`, `accountedRate`; `vulnerable`, `vulnerableAccounted`, `vulnerableAccountedRate` (equity check vs `accountedRate`); `highRiskUnaccounted`, `longestWaitMin` (longest a high-risk household has gone without contact); `recheckDue`; `openReferrals`, `overdueReferrals`, `membersMissing`; `closedNoContact` |
| `hex_stats` | the same counters per cell (`accounted`, `unaccounted`, `vulnerable`, `unaccountedVulnerable`, `highRiskUnaccounted`, `longestWaitMin`, `recheckDue`, `openReferrals`, `overdueReferrals`, `membersMissing`, `closedNoContact`) |
| `household_estimate`, `inspection_candidate` | `accounted` (bool), `escalation` |
| `household_followup` | per household: `memberMissing`, `reportedSimMinutes`, `referralStatus` (`''` / `referred` / `acknowledged` / `resolved`), `referralSimMinutes` (when referred, or when resolved), `closureReason` (`vacant` / `not_in_area` / `unreachable_after_visit`), `closedBy` |
| `unaccounted_queue` | top 5 per cell that still need contact: `rank`, `weight`, `waitSinceMin`, `escalation`, `vulnerable`, `cellPriority` |

`escalation` values:
- **Not heard from** (high-risk = vulnerable, pNeedsHelp ≥ 0.3, or a P0 cell; the step never moves backwards):
  - high-risk: `sms_sent` → `sms_resend` (30 min) → `agent_call` (90 min) → `field_visit` (4 h)
  - standard: `sms_sent` → `sms_resend` (2 h) → `agent_call` (6 h) → `field_visit` (12 h; 48 h for low-risk P2 cells)
  - no phone on file: `agent_call` (agent / emergency contact) → `field_visit`
- **Needs help** (reply or missing member, until resolved): `emergency_referral` → `referral_pending` → `referral_acknowledged`; `referral_overdue` when a timer runs out. Pick the button from `household_followup.referralStatus`: `''` → "Refer to 911 / local agency", `referred` → "Agency acknowledged", `acknowledged` → "Resolved".
- **Heard from**: `accounted`, `recheck` (high-risk, last contact > 12 h ago), `verified` (field report), `closed` (documented reason).

Queue score (rank across cells on the client; rows only change when the ranking changes):
```ts
const score = q.weight * (1 + (replay.simMinutes - q.waitSinceMin) / 360);
queue.sort((a, b) => score(b) - score(a));
```

Reducers:
| Reducer | Who | Effect |
|---|---|---|
| `report_member_missing(householdId, passcode)` | reply page (policyholder_demo, manager, or reply passcode) | "Someone in my household is unaccounted for": opens a referral (a repeat report keeps the original clock) |
| `update_referral(householdId, status)` | manager | `referred` / `acknowledged` / `resolved`; a needs-help reply after `resolved` opens a new referral |
| `close_household(householdId, reason)` | manager or adjuster | `vacant`, `not_in_area`, `unreachable_after_visit` (needs an assignment first), or `''` to reopen |

Vulnerable = 75+, disability, no vehicle, limited English, medical device, or 65+ living alone.
Dashboard idea: big "Unaccounted N → 0" and "Longest wait (high-risk) h:mm", the outreach queue with one action button per `escalation`, a referrals panel (overdue in red), and `accountedRate` vs `vulnerableAccountedRate` side by side.
Measured on the 72 h Harbor Bend replay with no staff actions: accounted 0 → 1,212 (5 h) → 1,748 (72 h), never decreasing; recheck due 616 at 72 h; Bay Area `jump_to(4320)` stays under 1 s.

## 1. What runs inside Spacetime

Everything below is a reducer or a table inside the database. The browser only subscribes and calls reducers.

```
scripts/seed.ts ──► seed_* reducers ──► world, hex, household, facility, sim_truth (private), staged_event (private), model_state
                                                                         │
start_replay ──► replay_tick (scheduled, every 1 s) ── releases due staged events ──┐
submit_sms_reply / submit_sms_text_reply (policyholder page) ───────────────────────┤
submit_field_report (adjuster, permission-checked) ─────────────────────────────────┤
                                                                                    ▼
             onEvent(): insert event row ─► hex_stats counters + metrics (incremental, same transaction)
                                        └─► recomputeCells(touched cells): fusion engine v2
                                              1. aggregate each touched cell ─► cell_agg (private)
                                              2. world reference rates from all cell_agg rows
                                              3. estimate ─► household_estimate, inspection_candidate,
                                                             hex_stats priority / verification / reason / silenceCause ...
```

- **Events**: `sms_sent`, `sms_reply` (now with the free-text reply and its language), `claim` (perils `wind` / `flood` / `earthquake`), `field_report`. Every ingest path goes through one function, `onEvent` (`spacetimedb/src/ingest.ts`).
- **Permissions**: only `adjuster` members can file field reports. Only `manager` members (or the owner) drive the replay and assign work. Only the owner seeds.
- **Real-time statistics**: `hex_stats` counters and global `metrics` are updated in the same transaction as the events.
- **Fusion**: engine v2 (`engine/src`, copied into `spacetimedb/src/fusion/engine/`) runs inside the reducers:
  - 44 features: CMIST vulnerability, tenure, students, school hours, away-at-work;
  - hazard-agnostic hazard score (`hazardIndex`);
  - silence baselines conditioned on coverage, tenure, language and being away;
  - `silenceCause`, a one-line `reason`, and per-region models (model version 2).

  `metrics.engine = 'engine'` shows the engine is active. With no model loaded, a temporary rule-based estimator runs and `metrics.engine = 'stub'`.
- **Learning loop**:
  - A field report updates its household and its cell immediately, including the engine's neighbour update.
  - Source trust moves one capped step after every 10 non-holdout reports.
  - Holdout households are scored against the private truth into `metrics.holdout*`.

## 2. Quick start (local)

```bash
# terminal 1: local server (keep running; data persists in ~/.local/share/spacetime/data)
spacetime start

# terminal 2 (all commands inside spacetimedb/; the scripts default to ws://127.0.0.1:3000)
cd spacetimedb
npm install

# publish the same module three times (add --delete-data=always when the schema changed)
spacetime publish -s local --module-path . --yes triage-loop
spacetime publish -s local --module-path . --yes triage-loop-tx
spacetime publish -s local --module-path . --yes triage-loop-ca

# seed each database with its bundle + model (~0.2 s / 0.8 s / 1.1 s)
node scripts/seed.ts --db triage-loop    --file ../data/live.json
node scripts/seed.ts --db triage-loop-tx --file ../data/real/tx-corpus-christi/live.json --model ../data/real/tx-corpus-christi/model.json
node scripts/seed.ts --db triage-loop-ca --file ../data/real/ca-bay-area/live.json       --model ../data/real/ca-bay-area/model.json

node scripts/smoke.ts --db triage-loop-ca      # end-to-end check: roles, replay, field report, rejections
```

- Shortcuts: `npm run publish:local:all`, then `npm run seed:hb`, `npm run seed:tx`, `npm run seed:ca`.
- `--model` defaults to `model.json` next to the bundle.
- All scripts accept `--db <name>` and `--host <ws url>`, or the env vars `SPACETIME_DB` / `SPACETIME_HOST`. Without them they target `ws://127.0.0.1:3000` and `triage-loop`.
- The scripts never read `.env` by themselves. **Always pass `-s local` to the CLI**: its default server is Maincloud.

| Command | What it does |
|---|---|
| `npm run publish:local:clean` | Republish `triage-loop` and **delete its data** (after a breaking schema change), then reseed |
| `npm run generate` | Regenerate `spacetimedb/bindings/` (used by the Node scripts; `.ts` import suffixes) |
| `node scripts/seed.ts --db <db> --model-only --model <model.json>` | Reload a recalibrated model, then reset the demo |
| `node scripts/seed.ts ... --wipe` | Delete the whole world first, then seed |
| `node scripts/seed.ts ... --cadence 120` | Seed and set the full-recompute cadence (see `set_recompute_cadence`) |
| `npm run sync-engine` | Re-copy `engine/src/*.ts` into `src/fusion/engine/` after engine changes, then typecheck and publish |
| `node scripts/parity.ts --db <db> --file <bundle> --t 1440 --reports 25 [--step 60]` | Database vs. the engine's offline `estimateAll` on the same events |
| `node scripts/bench.ts --db <db> [--speed 30] [--cadence 60]` | Reducer timings (tick, full recompute, jump, field report); leaves the database reset |
| `npm run typecheck` | Type-check the module and the scripts |
| `spacetime logs -s local triage-loop-ca -f` | Follow module logs (rejected reducer calls show up as ERROR lines) |
| `spacetime sql -s local triage-loop-ca "SELECT * FROM metrics"` | Ad-hoc SQL (run it outside `spacetimedb/` for names other than `triage-loop`; the owner can read private tables) |

### Frontend bindings

Generate your own copy into the client (default import style, for Vite or another bundler):

```bash
spacetime generate --lang typescript --out-dir client/src/module_bindings --module-path spacetimedb
```

Client package: `npm install spacetimedb` (same major version as the CLI, 2.x). React helpers come from `spacetimedb/react`. The bindings are identical for every world; only `withDatabaseName` changes.

## 3. Roles, identities, passcodes (demo auth)

- Every connection has an **Identity**. A browser without a stored token gets a fresh anonymous identity from the server. **Persist the token** (`onConnect` gives it to you) in `localStorage`, or the user loses their role on reload.
- Use a different storage key per screen (for example `triage-token-manager` and `triage-token-adjuster`). Then one laptop can run the manager and adjuster screens side by side. Identities are global, but **membership is per database**: join each world's database separately.
- Roles are self-assigned with `join_as(role, name, passcode)`:
  - `manager`, `adjuster`: need the **staff passcode**.
  - `policyholder_demo`: needs the **reply passcode** (the staff passcode also works).
- The policyholder page can skip `join_as` and pass the reply passcode directly to `submit_sms_reply` / `submit_sms_text_reply`.
- Passcodes live in the private `config` table and are set by `scripts/seed.ts` from `STAFF_PASSCODE` / `REPLY_PASSCODE`. The defaults are `triage-staff` / `triage-reply`, which are public in this repo, so **set your own for Maincloud**.
- The **owner** (the identity that published the module, i.e. the logged-in `spacetime` CLI) can seed and can also act as a manager.
- This is demo auth. A real deployment would use OIDC (SpacetimeAuth, Auth0, Clerk) and an owner-managed member list instead of shared passcodes.

## 4. Public tables

Field names below are the **client (camelCase)** names. In SQL (subscriptions, `spacetime sql`) use snake_case: `householdId` becomes `household_id`, `p0Cells` becomes `p_0_cells`, `age75` becomes `age_75`.

Types:
- `u64` is a `bigint`.
- `timestamp` is a `Timestamp` (`.toDate()`).
- `identity` is an `Identity` (`.toHexString()`).
- `option<T>` is `T | undefined`. It is undefined when the bundle has no value (Harbor Bend has none of the v2 fields).

Times `t` / `simMinutes` are **minutes after the event** (landfall or earthquake), from 0 to `world.horizonMinutes` (4320 = 72 h).

### `world` (singleton, id = 0)
| field | type | meaning |
|---|---|---|
| eventId, name, landfallIso | string | e.g. `live`, `HayWired M7.05 Hayward Fault scenario ...`, `2026-11-06T18:40:00.000Z` |
| centerLat, centerLng | f64 | map center |
| region | option string | `tx-corpus-christi`, `ca-bay-area`, undefined for Harbor Bend |
| hazardType | string | `hurricane` / `earthquake` |
| horizonMinutes | u32 | event length (4320) |
| eventLocalHour, eventWeekday | option u8 / option bool | as in the bundle |
| localHour, weekday, daytime, schoolHours | u8 / bool | engine world context (derived at seed time). `daytime` = weekday working hours (people with `awayDaytime` are not home); `schoolHours` = children at school |
| timeSource | string | `world` (from eventLocalHour) or `landfallIso` |
| dataSourcesJson | string | JSON array of data sources and licences (show on an "about the data" panel) |

### `facility` (static; 170 in Corpus Christi, 605 in the Bay Area, none in Harbor Bend)
| field | type | meaning |
|---|---|---|
| id (PK), name | string | |
| kind | string | `school` / `university` / `hospital` / `shelter` / `fire_station` / `mast` |
| lat, lng, hex | | location and H3 cell |
| enrollment, capacity | option u32 | students / shelter capacity when known |
| source | string | e.g. `NCES`, `OpenStreetMap` |

Map layer suggestion: schools as possible shelters and reunification points, hospitals, fire stations, masts (outage context). `household.nearestSchoolId` points at a school `id`.

### `hex` (one row per cell, static)
| field | type | meaning |
|---|---|---|
| hex | string (PK) | H3 index, resolution 8 |
| displayOrder | u32 | stable order (bundle order) |
| lat, lng | f64 | cell center |
| windMph, floodDepthFt, towerOutagePct | f64 | hazard layer (wind/flood are 0 for earthquakes) |
| analystZone | u8 | 0 none, 1 moderate, 2 severe (human-annotated, deliberately imperfect) |
| hazardIndex | option f64 | 0–1 hazard-agnostic intensity (the engine uses it when present) |
| shakingMmi, liquefaction | option f64 | earthquake: Modified Mercalli intensity, 0–1 liquefaction susceptibility |
| tractGeoid | option string | census tract |
| daytimeWorkers, residentWorkers | option f64 | LODES workers working / living in the cell |
| k12Enrollment, collegeEnrollment | option f64 | students enrolled in the cell's schools / colleges |

### `household` (static; 3,000 / 20,000 / 30,000 rows)
- **Core fields:** `id` (PK, e.g. `ca-live-h000552`), `hex`, `lat`, `lng`, `age65`, `livesAlone`, `medicalDevice`, `windCovered`, `floodPolicy`, `earthquakeEndorsement`, `phoneOnFile`, `holdout` (true = evaluation only; adjusters can still visit).
- **v2 optional fields:** `tractGeoid`, `childrenUnder18`, `awayDaytime`, `age75`, `disability`, `noVehicle`, `limitedEnglish`, `primaryLanguage` (`en es zh vi tl ko ...`), `mobileHome`, `policyType` (`homeowners` / `renters` / `condo`), `schoolAgeChildren`, `collegeStudent`, `nearestSchoolId`.

Same meaning as `Household` in `shared/types.ts`. **Large worlds: do not subscribe to the whole table on phones** (see §6).

### Event tables: `sms_sent`, `sms_reply`, `claim`, `field_report`
Common fields:

| field | type | meaning |
|---|---|---|
| id | u64 (PK, auto) | not sequential; order by `t` or `ingestedAt` |
| householdId, hex | string | |
| t | u32 | sim minute of the event |
| source | string | `replay` (from the bundle) or `live` (submitted during the demo) |
| ingestedBy | identity | who caused the insert (the database itself for replayed events) |
| ingestedAt | timestamp | wall-clock insert time |

Extra fields:
- `sms_reply`:
  - `safety` (`safe` / `needs_help`), `damage` (0 to 3);
  - `text` (option string): the free-text reply, possibly non-English, e.g. `se fue parte del techo, entra agua, todos estamos a salvo`;
  - `language` (option string, e.g. `es`, `zh`).

  `safety`/`damage` are the values parsed from the text. The bundles carry text for about a quarter of the replies.
- `claim`: `peril` (`wind` / `flood` / `earthquake`), `reportedDamage` (0 to 3).
- `field_report`: `adjusterId` (the adjuster's display name), `safety` (`safe` / `needs_help` / `unsure`), `damage`, `note`.

### `replay_state` (singleton, id = 0)
| field | type | meaning |
|---|---|---|
| running | bool | replay clock ticking |
| simMinutes | f64 | current sim time |
| speed | f64 | sim minutes per real second |
| nextSeq, totalStaged | u32 | released / total staged events (progress bar) |
| maxMinutes | u32 | `world.horizonMinutes` |
| lastTickAt | timestamp | |
| fullRecomputeEveryMin | u32 | how often (sim minutes) the running replay recomputes every cell and rescores the holdout set (default 60; 0 = only on jump/pause/end) |
| lastFullRecomputeMin | f64 | sim time of the last full recompute |

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
| **priority** | string | `P0` / `P1` / `P2` (color). A high-hazard silent cell is floored at P0 ("suspected P0") |
| **verification** | string | `verified` / `needs_verification` (hatching) |
| severity | f64 0–1 | `1 - (1 - severeShare)(1 - maxPNeedsHelp)` |
| confidence | f64 0–1 | evidence coverage x decidedness |
| silence | f64 0–1 | expected signal that is missing (hazard-weighted; baselines account for coverage, renters, limited English, people away) |
| **silenceCause** | string | `outage` (tower outage explains it), `away` (daytime event, residents at work), `trapped` (CMIST-vulnerable households dominate the silent ones), `unknown`, or `''` when the cell is not silent (silence < 0.2) |
| hazard | f64 0–1 | the cell's hazard score (hazardIndex when present) |
| expectedSevere | f64 | expected households with damage ≥ 2 |
| maxPNeedsHelp | f64 | highest P(needs help) in the cell |
| **reason** | string | the engine's one-line explanation, e.g. `P0: 11.3 of 14 expected severe; silence 35% (2/13 replied, 1 claim, outage 24%): vulnerable residents may be trapped; needs verification (confidence 46%)`. During school hours it can end with `827 students at Albany Middle and 1 more school (school hours)` |
| updatedAt, updatedSimMinutes | | last material change of the fusion output |

### `household_estimate` (one row per household)
| field | type | meaning |
|---|---|---|
| householdId (PK), hex | string | |
| pSevere | f64 | P(damage ≥ 2) |
| pNeedsHelp | f64 | P(safety = needs_help) |
| uncertainty | f64 0–1 | higher = less sure |
| verified | bool | has a field report |
| inspectScore | f64 0–1 | active-inspection score (engine `inspectionScore`: severe + help + uncertainty + cell silence + needs-verification), 0 when verified |
| updatedAt | timestamp | rows are rewritten only when a value moves by ≥ 0.0005 |

### `inspection_candidate`: the verification queue without downloading every household
The top 3 unverified households of each cell by `inspectScore` (the engine's `perCellCap`): at most 3 × cells rows (≤ 1,833 in the Bay Area). Sorting this table by `inspectScore` gives exactly the engine's `recommendInspections()` order (checked by `parity.ts`).

| field | type | meaning |
|---|---|---|
| householdId (PK), hex | string | |
| rank | u8 | 1 = best in its cell |
| inspectScore, pSevere, pNeedsHelp, uncertainty | f64 | copies from household_estimate |
| cellPriority, cellVerification | string | the cell's status |

### `metrics` (singleton, id = 0): the three small dashboard numbers and more
| field | meaning |
|---|---|
| hexes, households | totals |
| smsSent, smsReplies, helpReplies, claims, fieldReports | running totals |
| verifiedHouseholds, verifiedCoverage | "verified coverage" (0–1) |
| p0Cells, p1Cells, p2Cells, needsVerificationCells | cell counts by status |
| holdoutN | 0 until first computed (15% of households when ready) |
| holdoutBrierSevere, holdoutBrierHelp | "holdout error" (Brier, lower is better), computed at the full-recompute cadence, on jump, pause, reset |
| holdoutSevereRecall | share of truly severe holdout households with pSevere ≥ 0.5 |
| holdoutSimMinutes | sim time of that evaluation |
| trustHazard, trustSms, trustClaims, trustUpdates | "source trust" (0–1) and how many batch updates happened |
| modelVersion, engine | `engine` = real fusion engine; `stub` = temporary rules |

### `model_state` (singleton, id = 0)
`loaded`, `version`, `paramsJson`: the ModelParams JSON. Parse it for `region`, `hazardType`, calibration Brier/ECE/AUC and the hazard-only baseline. Trust fields:
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
- `config`: owner, passcodes, static-data stamp.
- `sim_truth`: TruthRow, used only for holdout scoring.
- `staged_event`: bundle events waiting for the replay clock.
- `cell_agg`: per-cell counters behind the engine's world reference rates.
- `replay_tick`: schedule.

## 5. Reducers

Client call style: `conn.reducers.submitFieldReport({ householdId, safety, damage, note })` returns a Promise that **rejects with the error message** when the reducer throws (wrong role, bad input). React: `const submit = useReducer(reducers.submitFieldReport)`.

| Reducer (SQL name) | Args | Who | Effect |
|---|---|---|---|
| `join_as` | role, name, passcode | anyone | Create or replace the caller's member row (switching roles is allowed) |
| `leave` | — | anyone | Remove the caller's member row |
| `submit_sms_reply` | householdId, safety (`safe`/`needs_help`), damage (0–3), passcode (`''` if joined) | `policyholder_demo` / `manager` member, owner, or anyone with the reply passcode | Inserts an `sms_reply` at the current sim minute (and an `sms_sent` if that household was never texted), then recomputes the cell |
| `submit_sms_text_reply` | householdId, safety, damage, text (≤ 1000 chars), language, passcode | same | Same, and stores the original free-text reply + language (safety/damage are its parsed values, e.g. from Claude on the reply page) |
| `submit_field_report` | householdId, safety (`safe`/`needs_help`/`unsure`), damage (0–3), note (≤ 500 chars) | **`adjuster` members only** | Inserts a `field_report`, recomputes the cell (household becomes verified; neighbours get the engine's residual update), completes the adjuster's assignment, and feeds the trust batch |
| `assign` | householdId, adjusterIdentityHex | manager / owner | New `assigned` row; cancels another adjuster's open assignment for that household |
| `assign_hex` | hex, adjusterIdentityHex, count (1–50) | manager / owner | Active inspection: assigns the `count` unverified, unassigned households of the cell with the highest `inspectScore` |
| `update_assignment` | id (u64), status | the assigned adjuster, or manager / owner | Set `assigned` / `done` / `cancelled` |
| `remove_member` | identityHex | manager / owner | Housekeeping |
| `start_replay` | speed (sim min per second, 0 < speed ≤ 1440) | manager / owner | Starts or resumes the 1-second tick (also changes speed). Suggested: 30 (72 h in 2.4 min) |
| `set_speed` | speed | manager / owner | Change speed only |
| `pause_replay` | — | manager / owner | Stops ticking (no scheduled calls while paused) and recomputes every cell, so a paused map equals the engine exactly |
| `step_replay` | minutes (0 < m ≤ 1440) | manager / owner | Advance the clock by `minutes` exactly like one tick (works while paused; good for a "step" button) |
| `jump_to` | minutes (0–horizon) | manager / owner | Forward: release everything due at once. **Backward: resets the demo** (drops live replies, field reports, assignments) and replays up to `minutes`. Always ends with a full recompute |
| `set_recompute_cadence` | minutes (0–4320) | manager / owner | Full-recompute cadence of the running replay (default 60). Larger worlds at high speed: 120–180 |
| `reset_demo` | — | manager / owner | Clear all events, estimates and assignments, rewind to t = 0, recompute (members and cadence are kept) |
| `recompute_all` | — | manager / owner | Recount every counter from the event tables and recompute every cell (repair tool) |
| `refresh_metrics` | — | manager / owner | Rescore the holdout set now |
| `set_passcodes` | staffPasscode, replyPasscode | owner | Demo passcodes (≥ 4 chars) |
| `seed_world` | world: WorldInput (eventId, name, landfallIso, centerLat, centerLng, region?, hazardType?, horizonMinutes?, eventLocalHour?, eventWeekday?, dataSources[]) | owner | Upsert `world` and derive the engine world context |
| `seed_hexes` | hexes: HexInput[] | owner | Upsert cells (+ empty `hex_stats` rows) |
| `seed_facilities` | facilities: FacilityInput[] | owner | Upsert facilities |
| `seed_households` | households: HouseholdInput[] | owner | Upsert households (validates `policyType`) |
| `seed_truth` | rows: TruthInput[] | owner | Upsert private truth |
| `seed_staged_events` | events: StagedEventInput[] (seq, t, kind, householdId, safety, damage, peril, reportedDamage, adjusterId, text, language) | owner | Upsert private staged events (seq = order in the bundle) |
| `load_model` | json (ModelParams) | owner | Validate and store a model, reset trust to its `sourceTrust`, recompute everything. **Rejects a model whose `region` / `hazardType` does not match the world** |
| `wipe_world` | — | owner | Delete world, facilities, households, truth, staged events, events, stats |

The seeding batches are typed arrays (not JSON strings), so bindings check them.

## 6. Subscriptions per screen

Subscribe once per screen. With React, `useTable(tables.hexStats)` subscribes and returns `[rows, isReady]`; filtered: `useTable(tables.household.where(r => r.hex.eq(hexId)))`.

**Size guide.** A full `household` subscription is fine for Harbor Bend (3,000 rows) and on a laptop for the real worlds. On phones, or on Maincloud with 20,000–30,000 households, use per-cell or per-household queries and `inspection_candidate` instead.

**Manager dashboard**
```sql
SELECT * FROM world                -- name, hazard type, daytime / school-hours flags, data sources
SELECT * FROM hex
SELECT * FROM hex_stats            -- map color (priority) + hatching (verification) + tooltip (reason, silenceCause)
SELECT * FROM facility             -- schools / hospitals / fire stations / masts layer
SELECT * FROM metrics              -- verified coverage, holdout error, source trust, P0/P1/P2 counts
SELECT * FROM replay_state         -- clock, progress, play/pause state
SELECT * FROM model_state          -- calibration info, trust batch progress
SELECT * FROM member               -- adjuster picker
SELECT * FROM assignment
SELECT * FROM inspection_candidate -- verification queue (≤ 3 per cell)
SELECT * FROM field_report         -- live event feed
SELECT * FROM household WHERE hex = '<selected cell>'            -- cell drill-down
SELECT * FROM household_estimate WHERE hex = '<selected cell>'
SELECT * FROM sms_reply WHERE hex = '<selected cell>'            -- replies incl. free text
```
- Action queue (P0 first): `hex_stats` with `priority = 'P0'`, ordered by `maxPNeedsHelp` then `severity`; show `reason`. Drill down into the cell's households.
- Verification queue: `inspection_candidate` by `inspectScore` desc. Assign with `assign_hex(hex, adjusterHex, 3)` or `assign(householdId, adjusterHex)`.
- Silence layer: `silenceCause` icons. `outage`: mast symbol. `away`: people at work (Bay Area daytime). `trapped`: needs a door knock.
- Live feed: `onInsert` callbacks on `field_report` / `sms_reply` / `claim`, newest first (`ingestedAt`). Subscribing to all `sms_reply` rows (up to ~10,000) is fine on a laptop.

**Adjuster phone**
```sql
SELECT * FROM my_member
SELECT * FROM my_assignments
SELECT * FROM household WHERE id = 'ca-live-h020813'            -- one query per assigned household
SELECT * FROM household_estimate WHERE household_id = 'ca-live-h020813'
SELECT * FROM hex_stats WHERE hex = '88283460b5fffff'            -- context for the card (reason)
SELECT * FROM sms_reply WHERE household_id = 'ca-live-h020813'   -- contact history (with text)
SELECT * FROM claim WHERE household_id = 'ca-live-h020813'
SELECT * FROM facility WHERE id = '<household.nearestSchoolId>'  -- reunification / shelter point
```
Re-subscribe when `my_assignments` changes. The form calls `submit_field_report`. Show CMIST flags (`age75`, `disability`, `noVehicle`, `limitedEnglish` + `primaryLanguage`, `mobileHome`) and coverage (`policyType`, `windCovered`, `floodPolicy`, `earthquakeEndorsement`) on the card.

**Policyholder SMS page** (QR code, e.g. `/reply?db=triage-loop-ca&h=ca-live-h000552&code=<reply passcode>`)
```sql
SELECT * FROM household WHERE id = 'ca-live-h000552'
SELECT * FROM sms_reply WHERE household_id = 'ca-live-h000552'
```
- Write the outreach text in `household.primaryLanguage`.
- SAFE / HELP and 0–3 call `submit_sms_reply(householdId, safety, damage, code)`.
- A free-text reply parsed by Claude calls `submit_sms_text_reply(householdId, safety, damage, text, language, code)`.
- The reply lands on the manager map within one round trip.

## 7. Minimal client code

```ts
import { DbConnection, tables, reducers } from './module_bindings';
import { SpacetimeDBProvider, useTable, useReducer, useSpacetimeDB } from 'spacetimedb/react';

const HOST = import.meta.env.VITE_SPACETIME_HOST ?? 'ws://127.0.0.1:3000'; // Maincloud: 'https://maincloud.spacetimedb.com'
const DB = new URLSearchParams(location.search).get('db') ?? import.meta.env.VITE_SPACETIME_DB ?? 'triage-loop';
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
  const [facilities] = useTable(tables.facility);
  const [queue] = useTable(tables.inspectionCandidate);
  const [metrics] = useTable(tables.metrics);
  const joinAs = useReducer(reducers.joinAs);
  const startReplay = useReducer(reducers.startReplay);
  // joinAs({ role: 'manager', name: 'Dana', passcode }).catch(e => alert(e.message));
  // startReplay({ speed: 30 });
  return null;
}
```

A world switcher just reconnects with another `withDatabaseName` (and keeps one token per screen; join again in each world). Node scripts (`spacetimedb/scripts/lib.ts`) show the non-React form: `connect()`, `subscriptionBuilder().onApplied(...).subscribe([...])`, `conn.db.hexStats.iter()`.

## 8. Fusion engine integration

- **`src/fusion/index.ts` (the adapter).** `recomputeCells(ctx, hexIds)` runs three phases:
  1. For each touched cell: gather households and events, aggregate with the engine's `aggregateCellCounts`, and persist the counters `computeRefs` needs in `cell_agg`.
  2. Compute world reference rates with the engine's `computeRefs` over all `cell_agg` rows: reply baselines by language × away, and claims per exposure for owners and renters.
  3. Estimate, then write `household_estimate`, `inspection_candidate` and `hex_stats`.

  A cell's aggregate only changes with its own events, and every event recomputes its cell in the same transaction, so `cell_agg` is always exact.
- **Static world cache.** Cells, households and facilities are kept in module memory, keyed by a stamp that the seed reducers bump. Decoding 30,000 household rows was about 25% of a full recompute.
- **`src/fusion/engine-adapter.ts`** builds the engine's `Snapshot` for one cell: world context, world refs and the cell's facilities. It then calls the engine's own functions:
  - `estimateCellHouseholds` (with the neighbour update);
  - `classifyCell` with the `CellContext` (for the students note);
  - `attachInspectScores`.

  `reason`, `silenceCause` and `hazard` come straight from the engine.
- **`scripts/parity.ts`** compares the database with the engine's offline `estimateAll` on the same bundle and events. It checks every household (pSevere, pNeedsHelp, uncertainty, inspectScore) and every cell (priority, verification, reason text, silenceCause, silence, confidence, hazard), plus `inspection_candidate` against `recommendInspections`. Result on all three worlds at t = 120, 600 + step 60, 1440 + 30 reports, 2880 + 20 reports + step 120, and 4320 + 40 reports:
  - 0 mismatches;
  - top-50 overlap 50/50;
  - values equal to about 1e-15, or within the 5e-4 write threshold.
- **`src/fusion/stub.ts`** is the TEMPORARY rule-based fallback (hazardIndex-aware). It is used only when no model is loaded or the engine rejects the model.
- **`src/fusion/trust.ts`** does batched trust learning with the engine's rules: 1 − Brier per source, learning rate 0.1, clamped to [0.3, 1], batches of 10 non-holdout reports. The engine keeps trust display-only by default.
- **After engine changes:** `npm run sync-engine && npm run typecheck`, publish, then run `parity.ts` on each world.
- **After a model changes:** `node scripts/seed.ts --db <db> --model-only --model <model.json>`.

## 9. Publishing to Maincloud (owner, when the team decides)

The judges' phones need a public URL, so the live demo runs on Maincloud: one database per world.

```bash
cd spacetimedb
set -a; source .env; set +a                       # owner only: STAFF_PASSCODE / REPLY_PASSCODE (never commit)
# first publish of a new world database:
spacetime publish -s maincloud --module-path . <db-name>
# upgrading an existing v1 database (e.g. the shared dev database) to this v2 module:
spacetime publish -s maincloud --module-path . --delete-data=always <db-name>
# seed (pick the bundle for that world):
node scripts/seed.ts --host https://maincloud.spacetimedb.com --db <db-name> --file ../data/real/ca-bay-area/live.json
spacetime logs -s maincloud <db-name> -f
```

- Database names are global (`triage-loop` may be taken).
- Client env: `VITE_SPACETIME_HOST=https://maincloud.spacetimedb.com`, plus `VITE_SPACETIME_DB=<db-name>` or `?db=<db-name>`.
- The seed script authenticates as the CLI login (`~/.config/spacetime/cli.toml`) or `SPACETIME_TOKEN`; that identity becomes the owner on publish.
- Keep the local server as the offline fallback (same commands with `-s local`).

## 10. Limits and measured costs

Measured on the local server (MacBook, `node scripts/bench.ts`). These are client round trips, i.e. reducer time plus about 1 ms. The tick is `step_replay(30)`, the same code path as one scheduled tick at speed 30, over the whole 72 h.

| | Harbor Bend | Corpus Christi | Bay Area |
|---|---|---|---|
| cells / households / events | 331 / 3,000 / 4,620 | 449 / 20,000 / 33,249 | 611 / 30,000 / 35,994 |
| seed (whole script) | 0.2 s | 0.8 s | 1.0 s |
| `reset_demo` (rebuild + recompute all) | 23 ms | 95 ms | 148 ms |
| `recompute_all` | 24 ms | 87 ms | 137 ms |
| `pause_replay` (full recompute + holdout) | 14 ms | 66 ms | 79 ms |
| `jump_to(4320)` from t = 0 (all events) | 83 ms | 355 ms | 535 ms |
| tick at speed 30, no full recompute: median / p95 / max | 5 / 16 / 25 ms | 12 / 67 / 99 ms | 9 / 87 / 162 ms |
| tick at speed 30 with full recompute (cadence 60): median / p95 / max | 22 / 29 / 43 ms | 96 / 138 / 168 ms | 116 / 185 / 253 ms |
| `submit_field_report` (one cell + world refs) | 4 ms | 5 ms | 5 ms |

- **Heaviest moments.** The heaviest ticks are the first sim hours, when 17,000–26,000 texts go out within 3 sim hours. A full Bay Area recompute costs about 80–140 ms; about a third of that is engine math.
- **Average load.** At speed 30 with cadence 60, a full recompute runs every 2 s of real time, which averages about 60 ms of reducer time per second for the Bay Area. On Maincloud, or at higher speeds, use `set_recompute_cadence(120)` or more. Touched cells are still recomputed every tick, and pause, jump and the end always recompute everything.
- **World refs drift.** Every reply or claim slightly changes the world reference rates, and the model has a time feature. Untouched cells pick both up at the next full recompute; between those they can lag slightly. `pause_replay` makes everything exact.
- **Maincloud energy.** While running, `replay_tick` fires once per second. **Pause when not demoing**: a paused replay schedules nothing. Rows are only rewritten when a value moves by ≥ 0.0005.
- **Demo auth only.** Passcodes live in a private table and roles are self-assigned. Anyone holding the staff passcode can become a manager.
- **Live SMS replies.** A reply for a household that was never texted also inserts an `sms_sent` row, so `replyRate` stays ≤ 1.
- **Field report attribution.** A field report's `adjusterId` is the adjuster's display name; the identity is in `ingestedBy`.
- **Schema upgrades.** v1 → v2 needs `--delete-data=always` and a reseed (new columns in existing tables).
