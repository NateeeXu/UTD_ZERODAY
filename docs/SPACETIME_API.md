# Saviu: SpacetimeDB API

Reference for the frontend (manager dashboard, adjuster phone, policyholder SMS page) and anyone
running the backend. The module lives in `spacetimedb/`. **One database per world**: the same module
is published under different names and seeded with one bundle each.

| World | Bundle + model | Cells / households / events | Hazard | Local database |
|---|---|---|---|---|
| Harbor Bend, TX (fictional) | `data/live.json` + `data/model.json` | 331 / 3,000 / 4,620 | hurricane (night) | `triage-loop` |
| Corpus Christi, TX | `data/real/tx-corpus-christi/{live,model}.json` | 449 / 20,000 / 33,249 | hurricane (Sat 02:00) | `triage-loop-tx` |
| Bay Area (Hayward Fault), CA | `data/real/ca-bay-area/{live,model}.json` | 611 / 30,000 / 35,994 | earthquake (Fri 10:40 local: daytime + school hours) | `triage-loop-ca` |

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
4. **"Safe" expires for vulnerable people**: a vulnerable household whose last contact is older than 24 h goes back to the queue as `recheck` (daily welfare check; ranks below never-contacted households).
5. **Life-safety reports cannot stall**: a life-safety reply, an adjuster finding someone who needs help, or a missing member opens a referral with timers (not referred in 30 min, or not acknowledged in 60 min → `referral_overdue`).

| Where | Columns |
|---|---|
| `metrics` | `accounted`, `unaccounted`, `accountedRate`; `vulnerable`, `vulnerableAccounted`, `vulnerableAccountedRate` (equity check vs `accountedRate`); `highRiskUnaccounted`, `longestWaitMin` (longest a high-risk household has gone without contact); `recheckDue`; `openReferrals`, `overdueReferrals`, `membersMissing`; `closedNoContact` |
| `hex_stats` | the same counters per cell (`accounted`, `unaccounted`, `vulnerable`, `unaccountedVulnerable`, `highRiskUnaccounted`, `longestWaitMin`, `recheckDue`, `openReferrals`, `overdueReferrals`, `membersMissing`, `closedNoContact`) |
| `household_estimate`, `inspection_candidate` | `accounted` (bool), `escalation` |
| `household_followup` | per household: `memberMissing`, `reportedSimMinutes`, `referralStatus` (`''` / `referred` / `acknowledged` / `resolved`), `referralSimMinutes` (when referred, or when resolved), `closureReason` (`vacant` / `not_in_area` / `unreachable_after_visit`), `closureNote` (why; required with a reason), `closedBy` |
| `unaccounted_queue` | top 5 per cell that still need contact: `rank`, `weight`, `waitSinceMin`, `escalation`, `vulnerable`, `cellPriority` |
| `staff_sim` (singleton) | `enabled`, `callsPerHour`, `visitsPerHour`, `inspectionsPerHour`, `lastRunMin`, counters (see below) |

`escalation` values:
- **Not heard from** (high-risk = vulnerable, pNeedsHelp ≥ 0.3, or a P0 cell; the step never moves backwards):
  - high-risk: `sms_sent` → `sms_resend` (30 min) → `agent_call` (90 min) → `field_visit` (4 h)
  - standard: `sms_sent` → `sms_resend` (2 h) → `agent_call` (6 h) → `field_visit` (12 h; 48 h for low-risk P2 cells)
  - no phone on file: `agent_call` (agent / emergency contact) → `field_visit`
- **Life safety** (life-safety reply, adjuster found `needs_help`, or missing member, until resolved): `emergency_referral` → `referral_pending` → `referral_acknowledged`; `referral_overdue` when a timer runs out. Pick the button from `household_followup.referralStatus`: `''` → "Refer to 911 / local agency", `referred` → "Agency acknowledged", `acknowledged` → "Resolved".
- **Heard from**: `accounted`, `recheck` (vulnerable, last contact > 24 h ago), `verified` (field report), `closed` (documented reason).

Queue score (rank across cells on the client; rows only change when the ranking changes):
```ts
const score = q.weight * (1 + (replay.simMinutes - q.waitSinceMin) / 360);
queue.sort((a, b) => score(b) - score(a));
```

Reducers:
| Reducer | Who | Effect |
|---|---|---|
| `report_member_missing(householdId, passcode)` | reply page (policyholder_demo, manager, or reply passcode) | "Someone in my household is unaccounted for": opens a referral (a repeat report keeps the original clock) |
| `update_referral(householdId, status)` | manager | `referred` / `acknowledged` / `resolved`; a life-safety reply after `resolved` opens a new referral |
| `close_household(householdId, reason, note)` | manager or adjuster | `vacant`, `not_in_area`, `unreachable_after_visit` (needs a field report with safety `unsure` for the household first), or `''` to reopen. `note` (≥ 3 chars) is required with a reason and stored in `closureNote`; closing marks the household's open assignments `done`; reopening clears the note and leaves assignments alone |
| `set_staff_sim(enabled, callsPerHour, visitsPerHour, inspectionsPerHour)` | manager | simulated staff on/off and capacity (0 = default) |

Vulnerable = 75+, disability, no vehicle, limited English, medical device, or 65+ living alone.
Dashboard idea: big "Unaccounted N → 0" and "Longest wait (high-risk) h:mm", the outreach queue with one action button per `escalation`, a referrals panel (overdue in red), and `accountedRate` vs `vulnerableAccountedRate` side by side.
### People vs property, and the kind of help (v3 data)

- **People are tracked by contact, property by inspection.** A reply or call reaches the person wherever they are and accounts for the PEOPLE. An adjuster visit inspects the PROPERTY; it accounts for the people only if they were there (`field_report.safety` `safe` / `needs_help`). `safety = 'unsure'` = house inspected, nobody seen → escalation `locate` (emergency contact, shelter lists), then a documented closure.
- **A reply from someone not at home** (`sms_reply.notHome`) accounts for the people but says nothing about the house: `damageKnown = false`, and the household stays in the inspection queue (the model treats it as "damage unknown", not "no damage").
- **Three kinds of help** (`sms_reply.lifeSafety`, `needs`):
  | Kind | Signal | Escalation | Goes to |
  |---|---|---|---|
  | Life safety | `lifeSafety = true` (trapped, injured, gas, device without power, generic "help"), adjuster found `needs_help`, missing member | `emergency_referral` → `referral_*` | 911 / local agency (State Farm refers, never rescues) |
  | Assistance | `needs_help` without `lifeSafety` (`needs`: shelter, medical, water_food, transport, other) | `assistance` | State Farm customer care |
  | Inspection | `needs` contains `inspection` | `inspection_request` | adjuster queue |
- New columns: `sms_reply` / `staged_event` `damageKnown`, `lifeSafety`, `needs` (comma-separated), `notHome`, `channel` (`sms` / `call`); `hex_stats` / `metrics` `callContacts` (staff calls, not counted as SMS replies), `assistanceRequests`, `inspectionRequests`, `locateDue`; `staff_sim.visitsNobodyHome`.
- New reducer for the Claude parser: `submit_parsed_reply(householdId, safety, damage (0–3, 255 = unknown), lifeSafety, needs, notHome, text, language, passcode)`; see docs/CLAUDE_PARSER.md. The "I need help" button (`submit_sms_reply` with `needs_help`) counts as a generic plea = life safety.
- Data assumptions and limitations: docs/DATA.md.

### SMS delivery receipts (phone dead, broken, or person unable to answer)

From the outside these all look like silence. The carrier receipt separates them: `sms_sent.delivered` (false = phone off, dead, lost or out of signal).
- Not delivered: resending is pointless. The ladder goes straight to `agent_call` (emergency contact) and visits on the high-risk clock (4 h), because lost phones go with wrecked homes.
- Delivered but silent, high-risk household: the phone works and nobody answers; visit after 3 h instead of 4 h.
- Simulated staff calls to a household whose texts were not delivered go to the emergency contact (lower answer rate).
- Counts (`hex_stats` / `metrics`): `undeliveredUnaccounted`, `deliveredNoReply` (both among households not heard from yet). Show them next to "Unaccounted".

### Hazard on the map

`world.hazardGeometryJson` (JSON string, '' when none): draw the event itself on the map.
- Hurricane: `{ kind: 'hurricane', landfall: {lat, lng}, track: [{lat, lng}, ...], headingDeg, vmaxMph, category, rmaxKm }`: landfall marker + forecast center line (`track`). `cone: { polygon: [{lat, lng}, ...], issuedHoursBeforeLandfall, radiusAtLandfallKm }` is an NHC-style forecast cone issued 24 h before landfall (2026 Atlantic two-thirds probability radii: 25 / 39 / 49 / 62 n mi at 12 / 24 / 36 / 48 h): narrow at the storm's position when issued, wider with lead time; draw it under the cells with low opacity and a thin outline.
- Earthquake: `{ kind: 'earthquake', epicenter: {lat, lng}, rupture: [{lat, lng}, {lat, lng}] | null, magnitude, faultName }`: epicentre marker + rupture line (`null` for USGS ShakeMap scenarios).

### Uncertainty on the map

- `hex_stats.severeLo` / `severeHi`: 90 % interval for the number of severely damaged households in the cell (show as "6–11"); `expectedSevere` is the point estimate. `severeVar` is its variance.
- `metrics.expectedSevereTotal`, `severeTotalLo` / `severeTotalHi` (region range = summed cell bounds), `severeIntervalWidth` (falls as calls, visits and inspections arrive: a good "uncertainty shrinking" chart), `intervalCoverageLive` (share of cells whose interval contains the simulated truth; show it next to the map, it should approach 90 %).
- Staff now also do property inspections: `staff_sim.inspectionsPerHour` (default 0.2 % of households), `inspectionsMade`; `set_staff_sim(enabled, callsPerHour, visitsPerHour, inspectionsPerHour)` (0 = default).
- How it is computed and validated: docs/DATA.md section 8.

### Simulated staff (`staff_sim`, on by default)

So the numbers move during the demo without anyone clicking, simulated staff work the queues every 30 sim minutes (src/staff.ts). Outcomes come from the private sim truth, never from the model.
- **Referral desk** (no limit): refers every new life-safety report (including missing members) at the next step; the agency acknowledges after 30 min and resolves after 6 h. Assistance requests go to customer care, not 911.
- **Agents** (`callsPerHour`, default 2% of households): call the top of `unaccounted_queue` once the text has had an hour; retry after 2 h, at most 3 tries. P(answer) = 0.75 (0.4 via emergency contact when no phone) × 0.5 if they really need help × 0.8 limited English × 0.7 destroyed home. Phones travel with people. A reached call is an `sms_reply` with `channel = 'call'` and `source = 'staff_sim'`; people away when it hit cannot say how the house is (damage unknown).
- **Adjusters** (`visitsPerHour`, default 0.3%): visit queue households after two failed calls, or one failed call and 4 h of silence (a re-check only if the person was last known at home). A visit always inspects the house (`field_report` from `sim-adjuster`, feeds trust learning); the people are seen only if they are home at that time (away people get home 4–12 h after it hit; badly damaged homes are empty). Nobody home → `locate`: up to 3 emergency-contact tries, then closed as `unreachable_after_visit` by `sim-staff`.
- Counters in `staff_sim`: `callsMade`, `callsReached`, `visitsMade`, `referralsMade`, `referralsResolved`, `helpFound` (people who needed help, found by a call or visit).
- `set_staff_sim(enabled, callsPerHour, visitsPerHour, inspectionsPerHour)` (manager; 0 = default). Turn it off to show "no staff" vs "staff working the queue". Settings survive `reset_demo`.

Measured, 72 h replays (v3 data with SMS delivery receipts and the coverage-aware inspection queue; local server, default capacity, `jump_to` in 24 h steps):
| | no staff | staff on |
|---|---|---|
| Harbor Bend accounted at 24 h / 48 h | 1,590 / 1,693 of 3,000 | 2,264 / **3,000** |
| Harbor Bend high-risk unaccounted at 24 h | 760 | 107 |
| Harbor Bend overdue 911 referrals | 7 | 0 |
| Bay Area accounted at 24 h / 72 h | 8,138 / 8,981 of 30,000 | 15,326 / **27,598** |
| Bay Area overdue 911 referrals | 65 | 0 |

Splitting life safety from assistance cut Harbor Bend's 911 referrals from 55 to 7 (the rest are assistance or inspection requests). In the Bay Area (weekday-daytime quake) 65% of staff visits find nobody home (4,021 of 6,210 over 72 h): the visited homes are the badly damaged ones, and their people have already left, so the next step is `locate`, not more door-knocking.

Cost: one staff step for the Bay Area is ~80 ms. The running replay does one step per tick; `step_replay(240)` takes ~1 s on Maincloud; a Bay Area `jump_to(1440)` takes ~4 s, so fast-forward big regions with repeated `step_replay(240)` calls (the UI also updates between them).
Holdout metrics now score only households without a field report (verified households are known, not predicted).

## 1. What runs inside Spacetime

Everything below is a reducer or a table inside the database. The browser only subscribes and calls reducers.

```
scripts/seed.ts ──► seed_* reducers ──► world, hex, household, facility, sim_truth (private), staged_event (private), model_state
                                                                         │
start_replay ──► replay_tick (scheduled, every 1 s) ── releases due staged events ──┐
submit_sms_reply / submit_sms_text_reply (policyholder page) ───────────────────────┤
submit_raw_reply ─► reply_inbox ─► Claude worker (Node) ─► submit_parsed_reply ─────┤
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
  - 45 features: CMIST vulnerability, tenure, students, school hours, away-at-work;
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
| `npm run imessage:bridge` | Optional, Mac only: send new task notices as real iMessages to one demo phone (section 9). `npm run imessage:bridge -- --dry-run` prints them and sends nothing |
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
- `field_report`: `adjusterId` (the adjuster's display name), `safety` (`safe` / `needs_help` / `unsure`), `damage` (0 to 3; 0 when `damageKnown` is false), `damageKnown` (false = the adjuster checked the people but did not assess the house; the note says why, and the house stays unverified and in the inspection queue), `note`.

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
| **verification** | string | `verified` / `needs_verification` (on the map: opacity = `confidence`, plus a pulse ring on silent high-hazard cells) |
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
| verified | bool | has a field report that assessed the house (a people-only report, damage 255, does not verify the property) |
| inspectScore | f64 0–1 | active-inspection score (engine `inspectionScore`: severe + help + uncertainty + cell silence + needs-verification), 0 when verified |
| updatedAt | timestamp | rows are rewritten only when a value moves by ≥ 0.0005 |

### `inspection_candidate`: the verification queue without downloading every household
The top 3 unverified households of each cell by `inspectScore` (the engine's `perCellCap`): at most 3 × cells rows (≤ 1,833 in the Bay Area). Sorting this table by `inspectScore` gives exactly the engine's `recommendInspections()` order (checked by `parity.ts`).
**Coverage-aware:** only houses whose policy covers this event's peril (homeowners / condo / no policy type, and hurricane: `windCovered` or `floodPolicy`, earthquake: `earthquakeEndorsement`) or that filed a claim are eligible; renters only via a claim (`src/fusion/coverage.ts`). Everyone else still gets estimates, accounting, escalation and counts in `hex_stats`; only this queue (and the staff sim's property inspections) skips them. Bay Area: 1,815 → 1,283 rows at t = 0 (1,419 at 24 h without staff, as claims arrive); 12.2 % of its households carry an earthquake endorsement, and 6.8 % are endorsed non-renters (the ones eligible before any claim).

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
`loaded`, `version`, `paramsJson`: the ModelParams JSON. Parse it for `region`, `hazardType`, calibration Brier/ECE/AUC and the baseline without live signals (hazard + static attributes). Trust fields:
- `baseTrust*`: trust at calibration.
- `trust*`: current trust.
- `trustUpdates`.
- `lastScore*`: 1 − Brier of each source in the last batch, or −1 if the source voiced too few opinions.
- `pendingFieldReports`: progress toward the next update (batch of 10).
- `holdoutReports`.

### `member`
`identity` (PK), `role` (`manager` / `adjuster` / `policyholder_demo`), `name`, `joinedAt`. Use it for the adjuster picker in the manager UI (`identity.toHexString()` is what `assign` expects).

### `assignment`
`id` (u64), `householdId`, `hex`, `adjuster` (identity), `assignedBy`, `status` (`assigned` / `done` / `cancelled`), `createdAt`, `updatedAt`. A field report by the assigned adjuster, or `close_household` with a reason, marks it `done` automatically.

### `adjuster_location`
`identity` (PK), `lat`, `lng`, `source` (`demo` = picked on the map / `gps`), `updatedAt`. One row per adjuster with a position. Public so the manager map can show positions (names from `member`). Demo only: a real deployment would restrict it to managers.

### `adjuster_recommendation`: the adjuster "Next best" list
Top 10 per adjuster, at most 3 per cell. An adjuster with no position has no rows. Clients read their own rows through `my_recommendations`.

| field | type | meaning |
|---|---|---|
| id (PK) | u64 | |
| adjuster | identity | whose list |
| rank | u8 | 1 = best |
| householdId, hex | string | |
| kind | string | `welfare` / `inspection` |
| priority | string | the cell's priority when the list was built |
| score | f64 | value per minute; compare only within one priority |
| distanceKm | f64 | straight line |
| etaMin | f64 | drive only, not routing (formula below) |
| reason | string | one line for the card: `No reply 14 h`, `Inspect · first in area`, `Inspect · likely severe`, `Inspect · damage unclear` |
| createdAt | timestamp | when the list was last rebuilt |

**Candidates:** `unaccounted_queue` rows with `escalation = 'field_visit'` (welfare) plus `inspection_candidate` rows (inspection), minus households with an open assignment. A household in both stays welfare.

**Ranking** (`spacetimedb/src/recommend-rank.ts`): deterministic rules; Claude does not rank. Cell priority first, so a nearer P1 never beats a P0. Within a priority, highest value per minute:
```ts
const driveMin = ((km * 1.3) / 35) * 60;  // straight-line km x road factor, at 35 km/h
const score = value / (driveMin + 15);    // 15 min on site
const welfareValue = 0.5 + 0.5 * Math.min(1, weight * (1 + waitMin / 360));
const inspectionValue = (inspectScore * 2) / (2 + verifiedHouseholdsInCell);
```

**When the list changes:**
- Rebuilt only when the adjuster updates location, refreshes, accepts a task or submits a field report. Never on the tick, so it never replaces a task on its own.
- Hooks in other reducers: `assign`, `assign_hex`, `accept_recommendation`, `submit_field_report` and `close_household` with a reason remove the household from every adjuster's list. Remaining rows keep their `rank` until that adjuster's next rebuild.
- `submit_field_report` also moves an adjuster with a `demo` location to that household (`gps` stays) and rebuilds their list.
- Replies and simulated staff do not touch the list; `accept_recommendation` catches those cases.
- `join_as` with another role, `leave` and `remove_member` delete the adjuster's location and list. `reset_demo` clears both tables.

### `chat_message`: conversation per household
`id` (u64 PK), `householdId`, `sender` (`adjuster` / `policyholder` / `system`), `senderName` (the adjuster's member name; `Automated assistant` for `system`; `''` for `policyholder`), `text`, `createdAt`. Three writers: the notice below, `send_chat_message` and `submit_raw_reply`. Replies through `submit_sms_reply`, `submit_sms_text_reply` or `submit_parsed_reply` (buttons, and the worker's parse of a typed reply) add no row. Public only because this demo has no policyholder login; production restricts it. Cleared with the demo state.

### `imessage_outbox`: iMessage notices
`id` (u64 PK), `householdId`, `text`, `status` (`queued` / `sent` / `failed`), `error` (`''`, or why the send failed, truncated to 200), `createdAt`, `updatedAt`. No phone number is stored. Rows stay `queued` unless `scripts/imessage-bridge.ts` (section 9) is running, so **the UI must label `queued` rows as simulated**. Public only because this demo has no policyholder login; production restricts it. Cleared with the demo state.

**Notice on accept:** when `accept_recommendation` creates the assignment, the same transaction adds one `chat_message` (`sender = 'system'`) and one `imessage_outbox` row (`queued`).
- In the app: `Adjuster {name} has been assigned to {task}. Reply here with any update. If anyone is in danger, call 911.`
- By iMessage: the same, with `Reply in the app with any update.`, because iMessage replies are not read.
- `{task}` is `inspect your home` (`kind = 'inspection'`) or `check on your household` (`welfare`). Neither text promises an arrival time.
- No notice when the task was no longer needed, and none for manager assignments (`assign`, `assign_hex`).

### `disaster_request`: the "New random disaster" button
`id` (u64 PK), `region` (`tx` hurricane / `ca` earthquake), `status` (`queued` / `running` / `done` / `failed`), `error` (`''`, or why it failed), `requestedBy`, `createdAt`, `updatedAt`. At most one row: the current or latest request. Survives `wipe_world` and `reset_demo`, because the load it asks for runs them. `scripts/disaster-worker.ts` (section 9) does the work; with no worker a request stays `queued` until cancelled.

### `reply_inbox`: raw free-text replies for the Claude parser worker
`id` (u64 PK), `householdId`, `text` (1–500 chars, trimmed), `language` (hint: `household.primaryLanguage`, `''` if none), `status` (`pending` / `parsed` / `failed`), `receivedAt`, `parsedAt` (option timestamp, unset while pending), `error` (`''`; `review: <reasons>` = parsed but a person should look; `parser: <code>; fallback submitted` = Claude failed and the reply went in as "needs help, a person calls back"; `submit: <message>` = the reducer rejected it). The reply page writes it with `submit_raw_reply` (no Anthropic key in the browser) and can watch its own row; `scripts/claude-worker.ts` turns each pending row into `submit_parsed_reply` (docs/CLAUDE_PARSER.md). Cleared with the demo state.

### Views (per caller)
- `my_member`: the caller's own member row (0 or 1 rows). Use it to show "joined as ...".
- `my_assignments`: the caller's own assignments (the adjuster task list).
- `my_recommendations`: the caller's own `adjuster_recommendation` rows (the "Next best" list).

### Private tables (not subscribable)
- `config`: owner, passcodes, static-data stamp.
- `sim_truth`: TruthRow, used only for holdout scoring.
- `staged_event`: bundle events waiting for the replay clock.
- `cell_agg`: per-cell counters behind the engine's world reference rates.
- `replay_tick`: schedule.

## 5. Reducers

Client call style: `conn.reducers.submitFieldReport({ householdId, safety, damage, note, memberMissing })` returns a Promise that **rejects with the error message** when the reducer throws (wrong role, bad input). React: `const submit = useReducer(reducers.submitFieldReport)`.

| Reducer (SQL name) | Args | Who | Effect |
|---|---|---|---|
| `join_as` | role, name, passcode | anyone | Create or replace the caller's member row (switching roles is allowed) |
| `leave` | — | anyone | Remove the caller's member row |
| `submit_sms_reply` | householdId, safety (`safe`/`needs_help`), damage (0–3), passcode (`''` if joined) | `policyholder_demo` / `manager` member, owner, or anyone with the reply passcode | Inserts an `sms_reply` at the current sim minute (and an `sms_sent` if that household was never texted), then recomputes the cell |
| `submit_sms_text_reply` | householdId, safety, damage, text (≤ 1000 chars), language, passcode | same | Same, and stores the original free-text reply + language (safety/damage are its parsed values) |
| `submit_parsed_reply` | householdId, safety (`safe`/`needs_help`), damage (0–3, 255 = unknown), lifeSafety, needs (comma-separated subset of `medical,power_for_device,shelter,water_food,transport,inspection,other`), notHome, text, language, passcode | same | The full parse of a free-text reply (the Claude worker calls it as a manager). See docs/CLAUDE_PARSER.md |
| `submit_raw_reply` | householdId, text (1–500 chars after trimming), passcode | same | Free-text reply page: stores the raw text in `reply_inbox` (`pending`) for the Claude worker. At most 5 pending rows per household and 500 in total. Also appends the text to `chat_message` (`sender = 'policyholder'`); the worker still parses it, so a danger message in chat escalates normally |
| `mark_reply_parsed` | id (u64), status (`parsed` / `failed` / `pending` = re-queue), error (truncated to 500) | manager / owner | Worker bookkeeping on `reply_inbox` (sets `parsedAt`) |
| `submit_field_report` | householdId, safety (`safe`/`needs_help`/`unsure`), damage (0–3, or **255 = house not assessed**), note (≤ 500 chars; **required, ≥ 3 chars, with 255**, e.g. `unsafe to enter`, `no access: flooded`, `dark, no power`), memberMissing (bool) | **`adjuster` members only** | Inserts a `field_report`, recomputes the cell and completes the adjuster's assignment. Damage 0–3: the household becomes verified, neighbours get the engine's residual update, the report feeds the trust batch. Damage 255: `damageKnown = false`; `safety` still accounts the people (`safe` / `needs_help`), the house stays unverified and in the inspection queue, no trust update; a later people-only report keeps the earlier assessed damage. `memberMissing = true`: someone is unaccounted for on site (same as `report_member_missing`; keeps an open referral) |
| `assign` | householdId, adjusterIdentityHex | manager / owner | New `assigned` row; cancels another adjuster's open assignment for that household |
| `assign_hex` | hex, adjusterIdentityHex, count (1–50) | manager / owner | Active inspection: assigns the `count` unverified, unassigned households of the cell with the highest `inspectScore` |
| `update_assignment` | id (u64), status | the assigned adjuster, or manager / owner | Set `assigned` / `done` / `cancelled` |
| `update_my_location` | lat, lng, source (`demo` / `gps`) | **`adjuster` members only** | Sets the caller's `adjuster_location` and rebuilds their "Next best" list |
| `refresh_recommendations` | none | **`adjuster` members only** | Rebuilds the caller's list. Rejects with `set your location first` when there is no position |
| `accept_recommendation` | householdId | **`adjuster` members only** | Self-assigns a household from the caller's list, notifies the policyholder (`chat_message` plus a queued `imessage_outbox` row, see section 4) and rebuilds the list. If the task is no longer needed, removes the row and refreshes the list, with no assignment, no notice and no error. Rejects with `not in your Next best list` for any other household |
| `send_chat_message` | householdId, text (1–500 chars after trimming) | **`adjuster` members only**, with a non-cancelled assignment on that household | Appends a `chat_message` (`sender = 'adjuster'`). Also works after the visit (`done`). In the app only, never sent by iMessage. Rejects with `only the assigned adjuster can message this household` |
| `mark_imessage` | id (u64), status (`sent` / `failed`), error (truncated to 200) | manager / owner | Delivery result from `scripts/imessage-bridge.ts`: sets `status`, `error` and `updatedAt` on `imessage_outbox` |
| `request_new_disaster` | region (`tx` / `ca`) | manager / owner | Queues one random disaster. Rejected while another is `queued` or `running`. Replaces the previous finished row. |
| `cancel_disaster_request` | — | manager / owner | Deletes a `queued` request. Rejected once it is `running`. |
| `update_disaster_request` | id (u64), status, error (truncated to 200) | owner | Worker only. Allowed: `queued` to `running` or `failed`; `running` to `done` or `failed`. |
| `remove_member` | identityHex | manager / owner | Housekeeping |
| `start_replay` | speed (sim min per second, 0 < speed ≤ 1440) | manager / owner | Starts or resumes the 1-second tick (also changes speed). Suggested: 30 (72 h in 2.4 min) |
| `set_speed` | speed | manager / owner | Change speed only |
| `pause_replay` | — | manager / owner | Stops ticking (no scheduled calls while paused) and recomputes every cell, so a paused map equals the engine exactly |
| `step_replay` | minutes (0 < m ≤ 1440) | manager / owner | Advance the clock by `minutes` exactly like one tick (works while paused; good for a "step" button) |
| `jump_to` | minutes (0–horizon) | manager / owner | Forward: release everything due at once. **Backward: resets the demo** (drops live replies, field reports, assignments, chat and iMessage notices) and replays up to `minutes`. Always ends with a full recompute |
| `set_recompute_cadence` | minutes (0–4320) | manager / owner | Full-recompute cadence of the running replay (default 60). Larger worlds at high speed: 120–180 |
| `reset_demo` | — | manager / owner | Clear all events, estimates, assignments, `chat_message` and `imessage_outbox`, rewind to t = 0, recompute (members and cadence are kept) |
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
SELECT * FROM hex_stats            -- map color (priority) + opacity (confidence) + pulse ring (silent high-hazard cells) + tooltip (reason, silenceCause)
SELECT * FROM facility             -- schools / hospitals / fire stations / masts layer
SELECT * FROM metrics              -- verified coverage, holdout error, source trust, P0/P1/P2 counts
SELECT * FROM replay_state         -- clock, progress, play/pause state
SELECT * FROM model_state          -- calibration info, trust batch progress
SELECT * FROM member               -- adjuster picker
SELECT * FROM adjuster_location    -- adjuster positions on the map (names from member)
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
SELECT * FROM my_recommendations                                -- "Next best" card
SELECT * FROM adjuster_location WHERE identity = <my identity>  -- my position on the map
SELECT * FROM household WHERE id = 'ca-live-h020813'            -- one query per assigned household
SELECT * FROM household_estimate WHERE household_id = 'ca-live-h020813'
SELECT * FROM hex_stats WHERE hex = '88283460b5fffff'            -- context for the card (reason)
SELECT * FROM sms_reply WHERE household_id = 'ca-live-h020813'   -- contact history (with text)
SELECT * FROM claim WHERE household_id = 'ca-live-h020813'
SELECT * FROM chat_message WHERE household_id = 'ca-live-h020813'     -- Message thread
SELECT * FROM imessage_outbox WHERE household_id = 'ca-live-h020813'  -- status of the accept notice
SELECT * FROM facility WHERE id = '<household.nearestSchoolId>'  -- reunification / shelter point
```
Re-subscribe when `my_assignments` changes. The form calls `submit_field_report`. Show CMIST flags (`age75`, `disability`, `noVehicle`, `limitedEnglish` + `primaryLanguage`, `mobileHome`) and coverage (`policyType`, `windCovered`, `floodPolicy`, `earthquakeEndorsement`) on the card.

"Next best" hooks (the card is the row with the lowest `rank`, not `rank === 1`; see `adjuster_recommendation`):
```ts
const [nextBest] = useTable(tables.myRecommendations);
const updateLocation = useReducer(reducers.updateMyLocation);    // updateLocation({ lat, lng, source: 'demo' })
const refresh = useReducer(reducers.refreshRecommendations);     // refresh()
const accept = useReducer(reducers.acceptRecommendation);        // accept({ householdId })
```
Message thread (docs/ADJUSTER_APP.md section 2.8): `useReducer(reducers.sendChatMessage)`, called with `{ householdId, text }`. Sort `chat_message` rows by `id`.

The manager map uses `useTable(tables.adjusterLocation)` with `member` names.

**Policyholder SMS page** (QR code, e.g. `/reply?db=triage-loop-ca&h=ca-live-h000552&code=<reply passcode>`)
```sql
SELECT * FROM household WHERE id = 'ca-live-h000552'
SELECT * FROM sms_reply WHERE household_id = 'ca-live-h000552'
SELECT * FROM chat_message WHERE household_id = 'ca-live-h000552'
```
- The simulator assumes an English-only check-in text (limited-English households reply less). Outreach in `household.primaryLanguage` is a roadmap item; replies can already be in any language.
- SAFE / HELP and 0–3 call `submit_sms_reply(householdId, safety, damage, code)`.
- A free-text reply calls `submit_raw_reply(householdId, text, code)`; the Claude worker (`npm run worker`) parses it into `submit_parsed_reply` within a few seconds. Watch `SELECT * FROM reply_inbox WHERE household_id = '…'` for its status.
- The thread with the assigned adjuster is `chat_message`. A typed reply uses the same `submit_raw_reply`, which appends it to the thread and still reaches the Claude worker, so a danger message escalates normally. Button replies are not mirrored.
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
- The parser worker / field-report change adds columns (`field_report.damageKnown`, `household_followup.closureNote`) and a table (`reply_inbox`): republish existing databases with `--delete-data=always` and reseed.
- Claude parser worker: runs on a laptop next to the demo, not in Spacetime. Put `ANTHROPIC_API_KEY` in `spacetimedb/.env` (gitignored, never in the frontend) and run `npm run worker` (reads `SPACETIME_HOST` / `SPACETIME_DB` / `STAFF_PASSCODE` from `.env`; one worker per world database, `--db <name>`). See docs/CLAUDE_PARSER.md.
- Task notices add two tables (`chat_message`, `imessage_outbox`) and two reducers: republish each database and regenerate the client bindings.
- iMessage bridge (optional): runs on a Mac next to the demo, not in Spacetime, and sends task notices through Messages.app, because Apple has no public API. All households are synthetic, so every notice goes to the one recipient in `IMESSAGE_DEMO_TO` (`spacetimedb/.env`, gitignored); the database holds no phone number. Run `npm run imessage:bridge` (reads `SPACETIME_HOST` / `SPACETIME_DB` / `STAFF_PASSCODE` from `.env` and joins as a manager; one process per world database, `npm run imessage:bridge -- --db <name>`). One-way: iMessage replies are not read, so the text says to reply in the app. It sends only notices created after it starts, at most 20 per run; later rows stay `queued`. `--dry-run` prints what it would send, sends nothing and marks nothing. Each send is recorded with `mark_imessage`.
- Random disaster worker (optional): runs on a Mac next to the demo, because the generator reads `data/real` and loading needs the owner token. Run `npm run disaster:worker -- --host wss://maincloud.spacetimedb.com --db triage-loop-nateeexu-dev` in `spacetimedb/`. On Maincloud it refuses every database except dev, and only runs requests made after it starts.

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
