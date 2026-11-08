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
| Model LOEO severe Brier / ECE / AUC | 0.068 / 0.020 / 0.947 | 0.055 / 0.014 / 0.914 | 0.102 / 0.018 / 0.882 |

The Bay Area is a weekday-daytime earthquake: most people are away when it hits, so many replies cannot describe the house (damage unknown). That is why its Brier is higher than before (0.071 → 0.102): the model has less damage information there, by design.
