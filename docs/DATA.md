# Data card: Triage Loop

What is real, what is simulated, every assumption the simulator makes, and what we can honestly claim.
Data files: `data/live.json` + `data/backtest/` (Harbor Bend, fictional), `data/real/tx-corpus-christi/`, `data/real/ca-bay-area/` (real geography).
Generators: `sim/src/generate.ts` (Harbor Bend), `sim/real/simulate.ts` + `sim/real/textgen.ts` (real regions), `sim/src/needs.ts` (v3 help type / whereabouts / reply labels, shared), `spacetimedb/src/staff.ts` (simulated staff during the replay).

## 1. Real vs synthetic

| | Real (public data) | Synthetic (our simulator) |
|---|---|---|
| Geography | H3 cells over real blocks/tracts, OSM coastline, terrain | Harbor Bend (fictional town) |
| People | Census/ACS distributions per tract (age, household type, tenure, disability, vehicles, language, enrollment), LODES daytime workers, CDC SVI | Every household and policyholder (sampled from those distributions) |
| Places | NCES public schools, IPEDS universities, OSM hospitals / fire stations / shelters / masts | – |
| Hazard | USGS ShakeMap HayWired M7.05 MMI grid, CGS liquefaction zones | The Corpus Christi hurricane (hypothetical Cat 4 track), Harbor Bend hurricane |
| After the event | – | Damage and needs (truth), whereabouts, tower outages, SMS replies and their text, claims, field reports, simulated staff calls and visits |

### Sources and licenses (from `world.dataSources`)
- U.S. Census Bureau, 2020 Census Redistricting Data (P.L. 94-171), block/tract internal points, POP100, HU100; table P5 group quarters (P5_008N college housing). Public domain.
- U.S. Census Bureau, ACS 2020-2024 5-year, tables B01001, B11001, B11005, B11007, B25024, B25034, B18101, B08201, C16001, C16002, B25003, B25032, B14007. Public domain.
- U.S. Census Bureau, LEHD LODES8 2023, WAC and RAC (S000, JT00). Public domain.
- CDC/ATSDR Social Vulnerability Index 2022 (tract): EP_DISABL, RPL_THEMES.
- NCES EDGE Public School Administrative Data 2023-24; NCES IPEDS 2023 (HD2023, EF2023A). Public domain.
- OpenStreetMap via Overpass (hospitals, fire stations, shelters, communication masts, coastline). © OpenStreetMap contributors, **ODbL 1.0** (https://www.openstreetmap.org/copyright). OSM-derived data in `data/real/` stays under ODbL; credit it wherever the map or data is shown.
- Terrain Tiles on AWS Open Data (Terrarium z12; USGS 3DEP/NED, SRTM, GMTED2010, ETOPO1).
- Bay Area only: USGS ShakeMap scenario catalog (HayWired M7.05, BSSC2014), grid.xml MMI (public domain); California Geological Survey Seismic Hazard Zones, liquefaction.
- Every bundle starts its source list with: *"SYNTHETIC: the hazard event, every household/policyholder, SMS replies, claims and field reports are simulated."*

## 2. Simulator assumptions (exact values)

### Hazard and outages
| What | Rule |
|---|---|
| Damage score (0-3 scale) | wind `(mph − 60) / 26`; flood `depth_ft / 2.7`; shaking `(MMI − 6.8) / 1.6` |
| Hurricane house score | max(wind, flood) + 0.25 × min(wind, flood) + noise; wind +0.9 mobile home, +0.15 older building |
| Earthquake house score | shaking + 0.35 older building + 0.4 mobile home + liquefaction (≈ +0.8 when in a zone and MMI ≥ 7) + noise |
| Hidden vulnerability | +0.7 for some homes (not visible to the model) |
| Damage level | score < 1.0 → 0, < 1.8 → 1, < 2.6 → 2, else 3 |
| Tower outage | 85 × sigmoid((wind − 116)/8) or 80 × sigmoid((MMI − 9.2)/0.25), plus a 95 % outage blob at the worst area and extra clusters near exposed masts |
| Analyst zones | deliberate errors: one under-marked area (70 % downgraded), one over-marked area (75 % marked high), one over-reporting district (SMS damage +1 at 45 %) |

### Truth: needs help (logistic)
z = −4.6 + 1.9 (damage 3) / 0.8 (damage 2) + 0.5 age 65+ + 1.2 age 65+ living alone + 0.5 age 75+ + 0.7 disability + 1.8 medical device with outage > 60 % (0.5 otherwise) + no vehicle (hurricane 0.4, +0.6 if flood > 4 ft; quake 0.2) + 0.6 flood > 4 ft − 1.8 away when it hit. `needs_help` with probability sigmoid(z). Harbor Bend uses the subset age 65+, alone, medical device, flood.

### Truth v3: kind of help and whereabouts (`sim/src/needs.ts`)
| What | Rule |
|---|---|
| `needType = life_safety` | needs help **and** (damage 3, or flood > 4 ft, or medical device with outage > 40 %, or age 75+/disability with damage ≥ 2); otherwise life safety 20 % of the time |
| `needType = assistance` | the remaining needs-help households (shelter, power, medication, transport, water) |
| `location = away` | was away (work/school) when it hit; cannot see the house |
| `location = home` | anyone in a life-safety situation stays home (that is why they need help) |
| `location = displaced` | left because the home is badly damaged: 80 % at damage 3, 40 % at damage 2; knows the damage |
| `returnMin` (away people) | they get home 4–12 h after it hit (commute disruption); then `displaced` if damage ≥ 2, else `home`. Replies and visits use where people are at that minute |
| Concrete needs | medical device → `power_for_device` if outage > 40 % else `medical`; damage ≥ 2 → `shelter`; no vehicle (hurricane or damage ≥ 2) → `transport`; outage > 60 % → `water_food` |

### SMS check-in and replies
| What | Rule |
|---|---|
| Who gets a text | policyholders with a phone on file (88 %); sent 60-180 min after landfall (quake 20-120) |
| P(reply) | 0.78 × (1 − outage)^1.6, × 0.7 age 65+, × 0.85 age 75+, × 0.6 damage 3, × 0.5 needs help, × 0.55 limited English (texts are English-only), × 0.6 away; × 1.25 (max 0.95) parents with children at a school in a hit area |
| Reply delay | lognormal, median 40 × (1 + 20 × outage²) min |
| Reported damage | truth ± 1 at 30 % (50 % when away); +1 at 45 % in the over-reporting district; −1 at 30 % for 65+ (under-reporting) |
| Reported safety | needs help: says so 85 %; fine: says "needs help" 3 % |
| v3 labels | needs help + life-safety truth → `lifeSafety`; other needs-help replies → concrete needs only (a powered device without power is never put here, it reads as life safety); safe replies ask for an `inspection` 30 % when damaged; `notHome` when the person is away or displaced; away people do not know the damage 85 % → `damage = null` |
| Free text | ~25 % of replies, in the household's language (limited English always, bilingual 45 %; en/es/zh/vi/tl/ko templates, others fall back to English). The text is generated **from** the labels: 15 % of damage-1/2 texts say only "not sure how bad" → `damage = null`; 40 % of damage-0 texts only say "we're ok" → `damage = null` (home not described) |

### Claims and field reports
| What | Rule |
|---|---|
| P(claim) by damage | 0.03 / 0.35 / 0.75 / 0.9; × 0.15 flood without flood policy, × 0.2 wind not covered, × 0.08 quake without endorsement; renters × 1/0.3/0.5/0.7, condo × 1/0.8/0.8/0.9 |
| Claim delay | lognormal, median 8 × e^(3·outage²) × (1 + 0.3 damage) h (× 1.3 away), reported damage ± 1 at 25 % |
| Field reports (backtests only) | 12 % random non-holdout households, day 1-3, damage = truth, safety = truth (6 % "unsure") |

### Simulated staff during the replay (`spacetimedb/src/staff.ts`, v3 rules)
| What | Rule |
|---|---|
| Capacity | calls 2 % and visits 0.3 % of households per hour (e.g. 600 calls / 90 visits for 30,000); every 30 sim minutes |
| Referral desk | refers every life-safety report at the next step; agency acknowledges after 30 min, resolves after 6 h |
| P(call answered) | 0.75 with a phone on file, 0.4 without (emergency contact); × 0.5 if they really need help, × 0.8 limited English (interpreter line), × 0.7 destroyed home. Phones travel with people, so location does not matter |
| Calls | after the text has had 1 h; retry every 2 h, at most 3 failed tries; a reached call is an `sms_reply` with `channel = 'call'` |
| Visits | after 2 failed calls, or 1 failed call + 4 h of silence; the adjuster always sees the **house** (damage), sees the **people** only if they are home |
| Nobody home | the house is inspected but the people are not accounted → `locate`: call the emergency contact (P = 0.6) |
| Re-checks | vulnerable households, daily, phone first; a welfare visit only if their last known location was home |

## 3. People vs property

The household is two things that are tracked separately:

| | People | Property |
|---|---|---|
| Question | Are they OK, where are they? | How damaged is the house? |
| Reached by | SMS, agent call, emergency contact, wherever the people are | Adjuster visit (nobody needs to be home), claim, a resident who is there |
| Counts toward | `accounted` / "no one overlooked" | inspection queue / severity estimate |
| Reply from someone not at home | people accounted | damage unknown → stays in the inspection queue |
| Visit with nobody home | not accounted → `locate` (emergency contact) | inspected |
| Collapsed house, no reply, high hazard | silent high-hazard → P0 → life-safety referral to 911 / local agency (search and rescue is theirs, not State Farm's) | inspected later |

## 4. Help taxonomy

| Kind | Examples | Goes to |
|---|---|---|
| Life safety | trapped, injured, can't breathe, gas smell, fire, water rising inside, medical device without power, someone missing, a generic plea ("help", "SOS", "ayuda", "救命", "tulong", "send someone") | referral to 911 / local agency (State Farm refers, never rescues) |
| Assistance | need a place to stay, medication, water, a ride | State Farm customer care (e.g. additional living expense, claims) |
| Inspection request | "come look at the house", "need an adjuster" | adjuster queue |

## 5. Known limitations (say them before a judge does)

- **Circular validation.** The model is trained on backtests and tested on the live event from the same simulator. Calibration and holdout numbers show the pipeline is internally consistent; they are not evidence of real-world accuracy.
- **Household level, not person level.** "Member missing" is a flag, not a headcount.
- **Policyholders only.** People without a State Farm policy are not in the data; the honest claim is "no policyholder overlooked".
- **Bay Area is harder.** Weekday-daytime quake: most replies come from people who are not home, so damage is often unknown (LOEO severe Brier 0.102, ECE 0.018, AUC 0.882).
- **Template texts.** About 700 distinct template combinations per region; real messages are messier (see `data/eval/sms_parse_adversarial.jsonl`).
- **Invented staff rates.** Call answer rates, capacities and agency timings are assumptions chosen to be plausible, not measured.
- **Demo auth.** Roles use shared passcodes; a real deployment needs proper identity (OIDC).

## 6. How to talk about it

- "Real geography, real demographics, real hazard scenarios; the disaster response itself is simulated."
- "The model is calibrated on simulated past events; we show it is consistent, and we show what it does with the signals, not that it is accurate in a real hurricane yet."
- "Same staff, ranked queue: in the simulation everyone is reached within 48 h in Harbor Bend; without staff, silence just grows." (A simulation result, not a forecast.)
- "Silence is not safety: in the Bay Area replay most households that need help never say so." (A simulator assumption that matches the design principle, not a measured fact.)
- Never: "predicts who is trapped", "guarantees", promised response times.

## 7. Generated data stats (live events, regenerated with the v3 simulator)

| | Harbor Bend | Corpus Christi | Bay Area |
|---|---|---|---|
| Households / cells | 3,000 / 331 | 20,000 / 449 | 30,000 / 611 |
| Truth needs help (life safety / assistance) | 129 (96 / 33) | 826 (467 / 359) | 1,033 (805 / 228) |
| Whereabouts when it hit (home / away / displaced) | 2,391 / 0 / 609 | 17,445 / 0 / 2,555 | 8,930 / 17,353 / 3,717 |
| Replies (with text, unknown damage, not home) | 1,366 (0%, 0%, 13%) | 9,944 (25%, 5%, 10%) | 7,381 (25%, 39%, 58%) |
| Life-safety / assistance / inspection replies | 7 / 48 / 237 | 56 / 355 / 2,111 | 65 / 240 / 1,289 |
| Model LOEO severe Brier / ECE / AUC | 0.058 / 0.017 / 0.954 | 0.042 / 0.004 / 0.931 | 0.102 / 0.018 / 0.882 |

The Bay Area is a weekday-daytime earthquake: most people are away when it hits, so many replies cannot describe the house (damage unknown). That is why its Brier is higher than before (0.071 → 0.102): the model has less damage information there, by design.

## 8. Uncertainty: how the intervals are computed

**Cell severe-count interval (map, `hex_stats.severeLo/severeHi`).** Unverified households' severe count is a sum of independent Bernoulli(pSevere): its exact Poisson-binomial distribution gives the 5 % / 95 % quantiles; a small cell-level shared error (tau2, estimated from backtests: HB 0.012, TX 0.001, CA 0.008) widens it and shrinks as field reports arrive in the cell; verified households count as known. Code: `engine/src/interval.ts`.

| Region | Normal approx (old) | Exact, deployed (90 %) | Backtest-calibrated tail (not deployed) |
|---|---|---|---|
| Harbor Bend | 99.1 % / 2.38 | 96.8 % / 1.64 | 90.4 % / 0.97 |
| Corpus Christi | 98.9 % / 3.11 | 97.6 % / 2.44 | 90.2 % / 1.32 |
| Bay Area | 97.3 % / 5.65 | 95.4 % / 4.87 | 90.8 % / 3.84 |

(held-out coverage / mean width in households; leave-one-event-out, tau2 and tail chosen on the other events). The calibrated tail hits 90 % on historical-style events but was overconfident on the harder live events (Bay Area live cell coverage 67 % at t = 0), so live uses the conservative 90 % interval.

**Region total (`metrics.severeTotalLo/Hi`)** = the sum of the cell bounds. Within one event every cell can be off in the same direction (the Bay Area live event is under-predicted by about 12 % before any field report), so adding cell variances as if independent was overconfident (it excluded the true total); summed bounds include it at every time we checked.

**Live honesty check (`metrics.intervalCoverageLive`)**: share of cells whose interval contains the simulated true count. Measured with simulated staff on: Harbor Bend 96 % → 98 % (t = 0 → 72 h), Bay Area 73 % → 82 % → 91 % (0 / 24 / 72 h). Early in a harder-than-history event the model is biased; coverage recovers as field reports correct it. Summed cell width falls 69 % (HB) and 56 % (Bay Area) over 72 h, from new information (calls, visits, property inspections), not from narrower assumptions.

**Model metrics** (leave-one-event-out, 95 % cell-cluster bootstrap CI; the range across events is the real event-to-event spread):

| | Severe Brier [CI] (range) | AUC [CI] | ECE | Brier skill vs hazard-only (range) |
|---|---|---|---|---|
| Harbor Bend (10 events) | 0.058 [0.055, 0.062] (0.013–0.084) | 0.954 [0.949, 0.957] | 0.017 | 0.25 (0.20–0.30) |
| Corpus Christi (8) | 0.042 [0.040, 0.043] (0.005–0.123) | 0.931 [0.925, 0.935] | 0.004 | 0.21 (0.15–0.27) |
| Bay Area (5) | 0.102 [0.099, 0.105] (0.036–0.160) | 0.882 [0.877, 0.886] | 0.018 | 0.18 (0.09–0.24) |

The bootstrap CIs are narrow because they only measure sampling noise within these simulated events; they say nothing about real-world accuracy (see Known limitations).

## 9. Random disasters (out-of-sample demos)

Each database normally plays one fixed live event. For a demo where the judges pick the disaster, generate a new hypothetical event for the same region and load it; the calibrated model is kept, so the event is new to it (a genuine out-of-sample test, visible in `intervalCoverageLive` and the holdout metrics).

```bash
cd spacetimedb
node --env-file=.env scripts/new-disaster.ts --region tx --db triage-loop-nateeexu-tx --category 4 --hour 2
node --env-file=.env scripts/new-disaster.ts --region ca --db triage-loop-nateeexu-ca --fault Hayward --magnitude 7.0 --hour 17 --weekday true
node ../sim/real/random.ts list      # presets and faults
```
Generation takes about 1 s; loading the Bay Area into Maincloud about a minute. Omit options to draw them at random (`--seed N` reproduces a draw). Generated files go to `data/real/<region>/scenarios/` (gitignored).

- **Hurricanes** (Corpus Christi): category drawn from Texas landfall climatology, wind within the Saffir-Simpson band, radius of maximum wind shrinking with intensity, forward speed and heading from triangular distributions, landfall anywhere on the Coastal Bend (27.3–28.1° N), storm surge by category, more rain for slow storms, random local time. Spec: `sim/real/random-spec.ts`.
- **Earthquakes** (Bay Area): fault drawn by likelihood weight (Hayward, Calaveras, San Andreas Peninsula, Concord–Green Valley, Greenville), magnitude within the fault's range, epicentre along the fault; shaking from a finite rupture (Wells & Coppersmith 1994 length) and a California intensity prediction equation (Atkinson & Wald 2007). Code: `sim/real/quake-model.ts`.
- Everything downstream (households, replies, claims, truth, people's whereabouts) is generated exactly as for the fixed events.

Two random runs, simulated staff on (true severe count vs the live range):

| Event | t = 0 | 24 h | 72 h | true | cell coverage | reached by 72 h |
|---|---|---|---|---|---|---|
| Random Cat-1 hurricane, weekend 15:00 (TX seed 42) | 322 [37, 872] | 236 [193, 418] | 247 [241, 266] | 245 | 99–100 % | 20,000 / 20,000 |
| Hayward M7.0, weekday 03:00 (CA seed 8) | 12,138 [8,916, 15,417] | 12,790 [10,883, 14,791] | 12,598 [11,171, 14,139] | 12,296 | 88–92 % | 30,000 / 30,000 |

Caveat: the random parameter ranges are research-based but simplified (a straight rupture, one IPE, no site amplification beyond liquefaction; a parametric hurricane wind and surge model). They make realistic-looking, varied events for testing the pipeline, not hazard forecasts.

