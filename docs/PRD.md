# Saviu: Product Requirements Document

HackUTD 2026 Zero Day. Tracks: State Farm "The Worst Day, at Scale" and Spacetime "Build with Spacetime".
Audience: hackathon judges and the team. Repository state described here: backend and docs on `setup/project-docs` at `0b85f54`, frontend on `origin/frontend/app` at `eeede95` (last client commit Nov 7 23:44).

> All households, replies, claims, field reports and outcomes in this project are synthetic. In the two real-geography worlds, the geography, demographics, facilities and seismic inputs are real public data. No real customer data is used.

**Build status labels used throughout**

| Label | Meaning |
|---|---|
| Built | Implemented on `setup/project-docs` (module, engine, simulator, worker) |
| Branch | Implemented in the client on `origin/frontend/app`, not merged into `setup/project-docs`. "Branch (partial)" means incomplete against the requirement |
| Spec | Designed in the docs, not implemented yet |
| Built; UI Spec | The table or reducer exists; no screen uses it yet |

## 0. Executive summary

**What it is.** Saviu is a post-disaster command center for an insurer's catastrophe (CAT) team. It answers two questions in real time: which policyholders need attention first, and who have we not heard from yet. It is not a rescue service. State Farm refers life-safety cases to 911 and local agencies; it never dispatches rescue.

**The problem.** After a disaster, claims surge and staff is limited, so the team must decide where to go first. The loudest place is often not the worst one. Where towers and roads fail, the hardest-hit households can go quiet. A team that sorts by incoming claims or SMS replies ranks those households last.

**How it works.**
- Fuses three imperfect signals per H3 cell: hazard intensity plus analyst zones, SMS check-ins, and claims compared with the expected volume.
- Outputs two separate axes: action priority (P0 / P1 / P2) and information status (verified / needs verification). A high-hazard silent cell is floored at P0 and can never default to safe.
- Accounts for every household. Silence means `unaccounted`, and the only exits are contact or a documented closure. An escalation ladder gives every household a next step, ending with a person at the door.
- Routes each request to its owner: life safety to a 911 or local-agency referral with timers, assistance to customer care, inspection requests to adjusters. People and property are tracked separately.
- Uses Claude Sonnet 5.5 only to read free-text replies. It sees the message text and nothing else, and it never scores or ranks.
- Shows its uncertainty: a 90% interval per cell, and a live check of how often those intervals contain the simulated truth.
- Runs on SpacetimeDB: tables, permissions, fusion, accounting and the replay clock all execute inside the database. The three worlds are published on Maincloud.

**What we measured (simulated events only).**

| Measure | Result |
|---|---|
| Severe-damage model, leave-one-event-out Brier / AUC | 0.058 / 0.954 Harbor Bend; 0.042 / 0.931 Corpus Christi; 0.102 / 0.882 Bay Area |
| 90% cell interval, held-out coverage | 96.8% / 97.6% / 95.4% |
| Live interval coverage with staff on (Bay Area) | 73% at t = 0, 79% at 24 h, 85% at 72 h |
| Households accounted, no staff vs simulated staff | Harbor Bend at 48 h: 1,693 vs 3,000 of 3,000. Bay Area at 72 h: 8,981 vs 27,598 of 30,000 |
| Overdue referrals, no staff vs simulated staff | Harbor Bend 7 vs 0; Bay Area 65 vs 0 |
| Reply parser, 800 cases in 6 languages (prompt v1) | Life-safety recall 222/224 (99.1%); false-safe 2/386 (0.5%); valid JSON 800/800 |
| `submit_field_report` round trip (local server) | 4–5 ms |

**Build state.** The backend is built: 31 tables, 3 views and 43 reducers, plus the engine, simulators, random disasters and Claude worker. The live client is on a branch: manager map, KPIs, outreach and referral panels, severe-damage range, staff switch, a basic adjuster form and a button reply page. It predates the last backend changes, so free-text replies, the delivery-receipt split and the five-screen adjuster app have no screens yet, and two reducer calls need regenerated bindings (R1 in section 11).

**What we do not claim.** Calibration comes from simulated events, so it shows the pipeline is internally consistent, not that it is accurate in a real hurricane. The honest claim is "no policyholder overlooked", not "no one". We never say the system predicts who is trapped, guarantees anything, or promises a response time.

## 1. Summary

| | |
|---|---|
| **Problem** | After a disaster, the signals an insurer receives are biased toward people who can still reach it. The hardest-hit households can be the quietest |
| **Solution** | A live, per-cell fusion of hazard, SMS and claims signals into P0 / P1 / P2 and verified / needs verification, plus household-level accounting that never lets silence pass as safety |
| **Who it is for** | State Farm CAT command-center managers, field adjusters, customer-care agents and the referral desk, and policyholders |
| **Why now** | US insured catastrophe losses ran about $89–113B a year in 2024–2025 (Swiss Re and Gallagher Re figures in `docs/research/sponsor-research.md`). A real-time database can now host the fusion logic itself. Multilingual free-text replies can be structured in about 1.4 s per message (parser eval) |
| **One-line pitch** | When a disaster hits, Saviu fuses three imperfect signals into a live P0–P2 map of which State Farm customers need help first and who we haven't heard from yet, and every field report makes the next decision more accurate |

## 2. Problem and context

### 2.1 The worst day, at scale

| Fact | Source |
|---|---|
| Claims spike in a short window and the team must choose where to go first | `docs/BACKGROUND.md` |
| The loudest place is not necessarily the worst hit: with roads and towers down, the worst-hit households may be unreachable | `docs/BACKGROUND.md` |
| Design inspiration, not the demo setting: in the 2008 Wenchuan earthquake, damaged roads and communications made the worst-hit places the quietest | `docs/BACKGROUND.md` |
| Katrina: people 75+ were about 6% of New Orleans residents and about 50% of deaths. Ian: of 87 deaths with a recorded age, 61 were over 60 | Research notes in `docs/FEATURES.md` |
| Existing tools: drones see houses, not people; help-request apps depend on people asking | `docs/research/sponsor-research.md` |

### 2.2 Why claims-first and SMS-first fail

| Signal | What it tells us | Where it fails | How the simulator represents it |
|---|---|---|---|
| Hazard + analyst zones | Where damage is likely | An estimate; says nothing about a given household; analysts make mistakes | Under-marked and over-marked areas are planted deliberately |
| SMS check-ins | Self-reported safety and damage | People with no signal cannot reply; some over- or under-report; people away cannot see the house | Harbor Bend reply rate by outage band (0–20 / 20–40 / 40–60 / 60–80 / 80–100%): about 65 / 37 / 19 / 11 / 1%. Damage 3 × 0.6 and needs help × 0.5 |
| Claims vs expected | Scale of loss for the insured | Late, and quiet where the loss is uninsured | Harbor Bend claims arrive at p10 / p50 / p90 of 5.6 / 15 / 49 h. Flood loss without a flood policy × 0.15 |

Fusing the signals matters because each one fails in a different place. All rates above are simulator assumptions, listed in `docs/DATA.md` and `data/README.md`.

### 2.3 Silence

| From the outside, silence can mean | How Saviu separates it | Field |
|---|---|---|
| Towers are down | Tower outage ≥ 50% explains the silence | `silenceCause = outage` |
| People are at work or school (daytime event) | Away residents dominate the silent households | `silenceCause = away` |
| People may be trapped | CMIST-vulnerable households dominate the silent households | `silenceCause = trapped` |
| Phone dead, lost or off | Carrier receipt says not delivered | `sms_sent.delivered = false` |
| Phone works, nobody answers | Carrier receipt says delivered, still silent | `metrics.deliveredNoReply` |

In the replay, most households with a life-safety need never say so: life-safety replies vs life-safety truth are 7 of 96 (Harbor Bend), 56 of 467 (Corpus Christi) and 65 of 805 (Bay Area). This is a simulator assumption that matches the design principle, not a measured fact.

## 3. Users and personas

| Persona | Context | Jobs to be done | Surface | Served today |
|---|---|---|---|---|
| **CAT command-center manager** | At a laptop, directing limited staff across a region | See where it is most urgent and where information is missing. Assign adjusters. Confirm nobody is stalled. Act on referrals | Manager dashboard | Map, KPIs, outreach, referrals, assignment, replay, staff switch: Branch |
| **Field adjuster** | Outdoors, one-handed, under stress, with poor signal | Know why they are at this door. Report people and house within 30 seconds. Never lose a report | Adjuster phone app | Join, task list, two-part form, close with a reason: Branch. Five-screen app and send state machine: Spec |
| **Customer-care agent / referral desk** | Works the phone queues | Call non-responders. Hand life-safety cases to 911 or local agencies and track them. Follow up on assistance requests | `unaccounted_queue`, `household_followup` | Simulated staff work these queues (Built). Requests tab on the manager dashboard: Branch. Dedicated care screen: Spec |
| **Policyholder** | Possibly displaced, possibly limited English, on a phone | Say in seconds whether they are safe and how bad the damage is, in their own words and language | QR-opened SMS page (simulated SMS) | Buttons and missing-member report: Branch. Free text via Claude: Built; UI Spec (box present, not connected) |

## 4. Goals, non-goals and principles

### 4.1 Goals

| ID | Goal | Measured by |
|---|---|---|
| G1 | Surface who needs attention first | `hex_stats.priority`, `household_estimate.pNeedsHelp`, leave-one-event-out calibration |
| G2 | Let no policyholder pass silently as fine | `metrics.unaccounted` falling, `metrics.highRiskUnaccounted`, `metrics.longestWaitMin` |
| G3 | Send each request to the right owner | `escalation` values, `metrics.openReferrals`, `overdueReferrals`, `assistanceRequests`, `inspectionRequests` |
| G4 | Be honest about what is not known | `hex_stats.severeLo/severeHi`, `metrics.intervalCoverageLive` |
| G5 | Keep every role in sync in real time | Fusion in the same transaction as the event; reducer latency in section 9.6 |
| G6 | Understand any language without letting an LLM decide | Parser eval: life-safety recall, false-safe rate, valid JSON |

### 4.2 Non-goals

| Not doing | Why |
|---|---|
| Rescue dispatch, search and rescue | That belongs to 911 and public agencies; State Farm refers, never rescues |
| Deciding coverage or paying claims | Liability; the app says "don't promise payment" |
| Real SMS sending or real policy-system integration | Demo uses simulated texts (roadmap). The optional iMessage bridge (TN-4) reaches one demo phone only |
| Training on real FEMA data | Roadmap |
| Real login system | Demo uses shared passcodes and role selection |
| Deep learning models | Out of scope (`docs/BACKGROUND.md`); two logistic models instead |
| Tracking strangers' phones, or Wireless Emergency Alerts | WEA is run through FEMA's IPAWS and needs authorized senders; State Farm cannot assume access |
| People without a State Farm policy | Not in the data |
| Push notifications with content, offline map tiles, photo upload, turn-by-turn navigation | Excluded from the adjuster app scope (`docs/ADJUSTER_APP.md` section 5) |

### 4.3 Principles

| Principle | How it is enforced |
|---|---|
| **Insurer, not rescuer** | Life safety opens a referral, never a dispatch. UI copy is "Referral created" and "Call 911 now if anyone is in danger.", never "help is on the way" |
| **No service promises** | The 24 h and 72 h figures are simulated scheduling targets only. Coverage-gap lines keep "don't promise payment" |
| **LLM understands, never scores** | Claude returns structured fields only; the engine and accounting rules produce every number and priority |
| **Silence is not safety** | High-hazard silent cells are floored at P0; unaccounted is the default state |
| **Honesty about uncertainty** | Intervals on cells, live coverage next to the map, conservative deployed tail, limitations stated |
| **Need, not identity** | Features follow CMIST functional needs. Race, ethnicity and income are not features |
| **People and property are separate** | Contact accounts for people; inspection accounts for the house |
| **Errors are asymmetric** | Calling someone safe who is not is the worst error. The parser says `unsure`, never a guessed `safe`; the keyword net can only escalate |
| **The UI tells the truth** | "Sent" appears only after commit; the `live` badge reflects the real connection (Spec) |
| **Minimum privacy exposure** | Existing customers only, via the phone on the policy; adjusters see needs, not labels; sensitive data never reaches the LLM (section 10) |

## 5. User journeys and the timeline of an event

### 5.1 Journeys

| Persona | Trigger | Steps | Outcome in the system |
|---|---|---|---|
| Manager | Event starts | Open map → read P0 and pulsing silent cells → open a cell's reason → assign top candidates → watch referrals and unaccounted | `assign_hex`, `assign`, `update_referral`, `close_household` |
| Adjuster | Task arrives | Tasks → Home ("why you're here") → Field report (people first, then home) → Report sent | `submit_field_report`; cell and neighbours recompute; assignment set to `done` |
| Adjuster, nobody home | No one seen | Report "Nobody seen · still unaccounted" and inspect house → `locate` → emergency contact → closure if unreachable | `field_report.safety = 'unsure'`, `close_household('unreachable_after_visit', note)` |
| Care or referral desk | Life-safety report | Refer to 911 or local agency → agency acknowledged → resolved | `update_referral`: `referred` → `acknowledged` → `resolved`, with timers |
| Policyholder | Check-in text | Reply SAFE / HELP and 0–3, or type freely in any language | `submit_sms_reply`, or `submit_raw_reply` → Claude worker → `submit_parsed_reply` |

### 5.2 Timeline of an event (simulated clock, T0 = landfall or earthquake)

| Time | System | People |
|---|---|---|
| T0 | Hazard layer and analyst zones in place; no signals yet | Manager sees the hazard-driven map |
| T+20–120 min (quake), T+60–180 min (hurricane) | Check-in text to policyholders with a phone on file (88%). Carrier receipts recorded; 8–31% of texts undelivered across the live events | Replies begin; median delay 40 × (1 + 20 × outage²) min |
| Text + 30 min | High-risk: `sms_resend` (standard: + 2 h) | |
| Text + 1 h | Simulated agents start calling the top of `unaccounted_queue` (retry every 2 h, at most 3 failed tries) | |
| Text + 90 min | High-risk: `agent_call` (standard: + 6 h). Undelivered or no phone: already at `agent_call` | Emergency contact tried |
| Text + 3 h / 4 h | `field_visit`: 3 h for high-risk delivered but silent; 4 h for other high-risk and any undelivered household | Adjuster at the door |
| T+4–12 h | Away people get home; displaced if damage ≥ 2 | Bay Area weekday case |
| T+5.6 / 15 / 49 h | Harbor Bend claims p10 / p50 / p90 | Claims lag most under outage |
| Text + 12 h | Standard: `field_visit` | |
| Last contact + 24 h | Vulnerable households return as `recheck` | Daily welfare check |
| Text + 48 h | Low-risk households in P2 cells: `field_visit` | Everyone gets a next step |
| T+72 h | Horizon (4,320 sim minutes) | Accounted and interval results (section 9) |

Any time: a life-safety report opens a referral. It goes overdue if not referred within 30 min, or not acknowledged within 60 min of referral. In the simulation, the agency acknowledges after 30 min and resolves after 6 h. The ladder clock starts at the first outreach text, or at T0 if none was sent.

### 5.3 Demo flow (3 minutes)

| # | Beat | Backend | Status |
|---|---|---|---|
| 1 | Silent map, press Start: SMS replies and claims stream in, cells color and gain confidence | `start_replay(30)` (72 h in 2.4 min) | Branch |
| 2 | Point at a pulsing cell: high hazard, towers down, zero replies → "suspected P0, needs verification" | `hex_stats.reason`, `silenceCause` | Branch |
| 3 | A judge scans the QR code and replies "I need help" / 3 → the cell updates on every screen. Free text in any language is the next step | `submit_sms_reply`; `submit_raw_reply` → worker | Buttons: Branch. Free text: Built; UI Spec |
| 4 | Adjuster submits a report → cell and neighbours update, verified coverage rises | `submit_field_report` | Branch |
| 5 | Close on metrics and real-time sync; staff vs no staff; unaccounted falling | `metrics`, `set_staff_sim` | Branch |

**60-second adjuster beat** (`docs/ADJUSTER_APP.md` section 4; needs the Spec adjuster app, while the manager's referral panel is Branch). Pre-flight on `triage-loop-nateeexu-tx`: `reset_demo`, `jump_to(840)` (T+14 h), then pause so simulated staff do not get there first.

| Time | Manager laptop | Phone | Line |
|---|---|---|---|
| 0–10 s | Click a pulsing P0 cell, Assign to J. Ortiz | Next up appears without refresh | "The map says this silent cell is the worst; one tap sends a person." |
| 10–20 s | | Open home; one line on why you're here | "No percentages in the field, just one line on why you're here." |
| 20–35 s | | Needs help; red `Call 911 now` appears (not tapped); 2 Severe; chip Trapped; Send report | "We never dispatch. The adjuster calls 911; our report opens a referral with a timer." |
| 35–50 s | Cell and neighbours recolor; referral timer starts; accounted +1 | "Referral created"; AREA range narrows | "One report, every screen; the uncertainty range narrowed." |
| 50–60 s | Click "Refer to 911 / local agency" | Pill changes to "Sent to 911" | "Nobody is silently fine, and nobody stalls in the queue." |

**Fallbacks:** airplane-mode beat (report is saved on the phone and resent once, with no duplicate); local server on a laptop hotspot; backup video.

## 6. Functional requirements

Priority: Must / Should / Could. Thresholds are the values in code (`engine/src/config.ts`, `spacetimedb/src/fusion/index.ts`, `spacetimedb/src/staff.ts`).

### 6.1 Fusion engine and map (FE)

| ID | Requirement | Pri | Status | Acceptance criteria |
|---|---|---|---|---|
| FE-1 | Fuse hazard + analyst zones, SMS and claims per H3 resolution-8 cell | Must | Built | One `hex_stats` row per cell (331 / 449 / 611) with `priority`, `verification`, `severity`, `confidence`, `silence`, `hazard`, `reason` |
| FE-2 | Two calibrated logistic models, P(severe) and P(needs help), on 45 features | Must | Built | `FEATURE_NAMES` has 45 entries (9 hazard, 19 static, 12 SMS, 5 claims); `metrics.engine = 'engine'` when a model is loaded, `stub` otherwise |
| FE-3 | One hazard-agnostic engine for hurricanes and earthquakes | Must | Built | Uses `hazardIndex` when present; `load_model` rejects a model whose `region` or `hazardType` does not match the world |
| FE-4 | Fusion runs inside the database transaction | Must | Built | Every ingest path goes through `onEvent` → `recomputeCells`; `hex_stats` counters and `metrics` update in the same transaction |
| FE-5 | Database output equals the offline engine | Must | Built | `scripts/parity.ts`: 0 mismatches and top-50 overlap 50/50 on all three worlds |
| FE-6 | A field report updates its household and cell at once | Must | Built | Verified households take p = 0.98 or 0.02; unverified neighbours get `logit += 2 × Σ(y − p̂) / (k + 2)` |
| FE-7 | Source trust moves slowly | Should | Built | One capped step per 10 non-holdout reports, learning rate 0.1, clamped to [0.3, 1], `metrics.trustUpdates`; display-only (`applyToInference = false`) |
| FE-8 | Holdout set never trains | Must | Built | 15% of households; `metrics.holdoutN`, `holdoutBrierSevere`, `holdoutBrierHelp`, `holdoutSevereRecall`; only unverified holdout households are scored |
| FE-9 | Map shows priority by color and confidence by opacity, with a pulse on the most urgent silent cells | Must | Branch | P0 `#d93a35`, P1 `#ee7d2b`, P2 `#e8b931`; `fillOpacity = 0.12 + 0.73 × confidence`; pulse on the top 10 cells with P0, `needs_verification`, silence ≥ 0.5, hazard ≥ 0.5, ranked by silence × hazard × households |
| FE-10 | Level of detail and facility layer | Should | Branch | Below zoom 12, cells merge into resolution-7 districts (highest child priority); `facility` layer (170 Corpus Christi, 605 Bay Area) |

### 6.2 Priority and verification (PV)

| ID | Requirement | Pri | Status | Acceptance criteria |
|---|---|---|---|---|
| PV-1 | Priority from need and severity | Must | Built | P0 if `maxPNeedsHelp ≥ 0.5` or severe share ≥ 0.5. P1 if ≥ 0.25 or ≥ 0.2. Otherwise P2 |
| PV-2 | A silent high-hazard cell cannot look safe | Must | Built | `hazard ≥ 0.5` and `silence ≥ 0.5` → at least P0 and always `needs_verification`; `reason` starts with "suspected P0" |
| PV-3 | Verification is a separate axis | Must | Built | `needs_verification` if `confidence < 0.5` or silent high hazard; a cell can be "suspected P0 · needs verification" |
| PV-4 | Silence compares signals with what was expected | Must | Built | `silence = clamp01(hazard × max(0, 1 − heard/expected) × (1 − exp(−expected)))`; baselines conditioned on coverage, tenure, limited English and being away |
| PV-5 | Every cell explains itself, including its silence | Should | Built | `hex_stats.reason` is one line from the engine, not an LLM. `silenceCause` set when `silence ≥ 0.2`: `outage` if outage ≥ 0.5, otherwise `away`, `trapped` or `unknown` |
| PV-6 | Inspect where it is both severe and uncertain | Should | Built | `inspectScore = (pSevere + pNeedsHelp + 0.8 × uncertainty + 0.5 × silence + 0.2 × needs-verification) / 3.5`; `inspection_candidate` keeps the top 3 per cell |
| PV-7 | Action tiers without promises | Must | Spec | P0: flag life-safety risk, refer to local agencies, contact first, review temporary-housing eligibility. P1: inspection (simulated 72 h target). P2: self-service claim. Needs verification: verify first, never default to P2 |

### 6.3 No-one-overlooked accounting and escalation ladder (AC)

| ID | Requirement | Pri | Status | Acceptance criteria |
|---|---|---|---|---|
| AC-1 | Silence is `unaccounted` | Must | Built | `household_estimate.accounted`; `metrics.accounted`, `unaccounted`, `accountedRate`; `accounted` never returns to false on its own |
| AC-2 | Accounted has one exact definition | Must | Built | `accountFor()`: reply or agent call, claim, field report with safety other than `unsure`, missing-member report, open referral, or documented closure |
| AC-3 | Every household has a next step | Must | Built | `household_estimate.escalation` is one of the 15 `ESCALATION` values (appendix) |
| AC-4 | High-risk is explicit | Must | Built | Vulnerable (75+, disability, no vehicle, limited English, medical device, or 65+ living alone), or `pNeedsHelp ≥ 0.3`, or a P0 cell |
| AC-5 | Tiered ladder | Must | Built | Thresholds in the table below (`LADDER_MIN`, `LOW_RISK_VISIT_MIN`, `DELIVERED_SILENT_VISIT_MIN`) |
| AC-6 | The ladder never moves backward | Must | Built | `step = max(step, index of previous escalation)`, even if risk later drops |
| AC-7 | Queue ages | Must | Built | `unaccounted_queue` top 5 per cell; `weight = (max(pNeedsHelp, 0.5 × pSevere) + 0.02) × cell factor (1.3 / 1.1 / 1) × vulnerable 1.5`; client score `weight × (1 + wait / 360)` |
| AC-8 | "Safe" expires for vulnerable households | Should | Built | Last contact older than 1,440 min → `recheck`; stays accounted; weight × 0.5; `metrics.recheckDue` |
| AC-9 | Nobody home is not contact | Must | Built | Report with `safety = 'unsure'` → `locate`; `metrics.locateDue` |
| AC-10 | Closure is documented | Must | Built; Branch (partial: no note) | `close_household(householdId, reason, note)`: `vacant`, `not_in_area`, `unreachable_after_visit`; note ≥ 3 chars; `unreachable_after_visit` needs a prior `unsure` report; `''` reopens; open assignments become `done`; `closedBy` recorded |
| AC-11 | Equity is visible | Should | Branch | `metrics.vulnerableAccountedRate` beside `accountedRate`, with a lag warning |
| AC-12 | People and property stay separate | Must | Built | `sms_reply.notHome` accounts people with `damageKnown = false`; damage 255 keeps the house unverified and in the queue |
| AC-13 | Outreach panel | Must | Branch | Unaccounted card with goal 0, longest wait, and a Not heard from list with one action button per `escalation` |

**Ladder thresholds** (minutes since the first outreach text, or since T0 with no text)

| Case | `sms_resend` | `agent_call` | `field_visit` | After a visit with nobody seen |
|---|---|---|---|---|
| High-risk | 30 min | 90 min | 4 h | `locate` |
| High-risk, text delivered, silent | 30 min | 90 min | 3 h | `locate` |
| Standard | 2 h | 6 h | 12 h | `locate` |
| Standard, P2 cell, `pNeedsHelp < 0.2` | 2 h | 6 h | 48 h | `locate` |
| Text not delivered | skipped | immediately (emergency contact) | 4 h | `locate` |
| No phone on file | none | immediately (agent or emergency contact) | by risk class, from T0 | `locate` |

### 6.4 Referrals and their states (RF)

| ID | Requirement | Pri | Status | Acceptance criteria |
|---|---|---|---|---|
| RF-1 | Life-safety signals open a referral | Must | Built | `sms_reply.lifeSafety`, `field_report.safety = 'needs_help'`, or a missing member → `escalation = 'emergency_referral'` |
| RF-2 | Referrals cannot stall | Must | Built | Not referred in 30 min (`REFER_MIN`), or not acknowledged in 60 min (`REFERRAL_ACK_MIN`) → `referral_overdue`; `metrics.overdueReferrals` |
| RF-3 | Manager moves the state | Must | Branch | `update_referral(householdId, status)` with `referred`, `acknowledged`, `resolved`; one next-step button per row |
| RF-4 | Missing members | Must | Built | `report_member_missing`, or `memberMissing = true` on a field report; a repeat report keeps the original clock |
| RF-5 | Reopening | Should | Built | A life-safety reply after `resolved` opens a new referral; a referred or acknowledged referral stays open even if a later report says safe |
| RF-6 | Copy discipline | Must | Spec | Adjuster pills use exactly four states; never "help is on the way" or anything implying rescue has left |
| RF-7 | Referrals panel | Must | Branch | Requests tab, life-safety list sorted with overdue first, overdue in red; `metrics.openReferrals`, `overdueReferrals` |

| `referralStatus` | Manager button | Adjuster pill | Escalation |
|---|---|---|---|
| `''` | "Refer to 911 / local agency" | "Referral created" | `emergency_referral`, then `referral_overdue` after 30 min |
| `referred` | "Agency acknowledged" | "Sent to 911" | `referral_pending`, then `referral_overdue` after 60 min |
| `acknowledged` | "Resolved" | "Acknowledged" | `referral_acknowledged` |
| `resolved` | none | "Resolved" | Back to the household's non-referral state |

### 6.5 Assistance and inspection queues (AQ)

| ID | Requirement | Pri | Status | Acceptance criteria |
|---|---|---|---|---|
| AQ-1 | Three kinds of help are routed separately | Must | Built | Life safety → referral. `needs_help` without `lifeSafety` → `assistance` (customer care). `needs` contains `inspection` → `inspection_request`. Counts: `metrics.assistanceRequests`, `inspectionRequests`. Harbor Bend 911 referrals fell from 55 to 7 after the split |
| AQ-2 | Inspection queue is coverage-aware | Must | Built | `inspectionEligible()`: a claim was filed, or non-renter with cover for this peril (hurricane: wind or flood policy; earthquake: endorsement). Bay Area `inspection_candidate` 1,815 → 1,283 rows at t = 0. Uncovered households still count in estimates, accounting, `hex_stats` and intervals |
| AQ-3 | Assignments | Must | Built | `assign`, `assign_hex` (1–50), `update_assignment`; a field report by the assigned adjuster, or a closure, sets `done` |
| AQ-4 | A requested inspection reaches an adjuster | Should | Branch (partial) | Requests tab lists `inspection_request` with Send adjuster. The engine does not raise `inspectScore` for these households or add them to `inspection_candidate` |
| AQ-5 | Customer-care worklist | Should | Branch | Requests tab lists `escalation = 'assistance'` with the `needs` asked for |
| AQ-6 | Coverage gap copy | Must | Spec | "Flood not covered · refer to FEMA / NFIP · don't promise payment", and the wind and quake equivalents |

### 6.6 SMS delivery receipts (DR)

| ID | Requirement | Pri | Status | Acceptance criteria |
|---|---|---|---|---|
| DR-1 | Store the carrier receipt | Must | Built | `sms_sent.delivered` (absent = delivered) |
| DR-2 | Do not resend to a dead phone | Must | Built | Undelivered → straight to `agent_call`, high-risk clock for the visit (4 h) |
| DR-3 | Delivered but silent is a warning | Must | Built | High-risk and delivered → visit at 3 h instead of 4 h (`DELIVERED_SILENT_VISIT_MIN`) |
| DR-4 | Show the split | Should | Built; UI Spec | `metrics.undeliveredUnaccounted`, `deliveredNoReply`, also per cell |
| DR-5 | Calls follow the receipt | Should | Built | Simulated calls to a household whose texts all failed use the lower answer rate (0.4 vs 0.75) |

### 6.7 Uncertainty intervals (UN)

| ID | Requirement | Pri | Status | Acceptance criteria |
|---|---|---|---|---|
| UN-1 | 90% interval per cell | Must | Built | `hex_stats.severeLo/severeHi`: exact Poisson-binomial quantiles widened by shared cell error τ² (`engine/src/interval.ts`) |
| UN-2 | Conservative tail in production | Must | Built | `cellIntervalTail = 0.05` on all three models; the narrower backtest tail is not deployed |
| UN-3 | Region range is honest | Must | Built | `metrics.severeTotalLo/Hi` are summed cell bounds, because errors correlate within an event |
| UN-4 | Live honesty check | Must | Branch | `metrics.intervalCoverageLive` and `intervalCellsLive` on the severe-damage card ("Range check", target about 90%) |
| UN-5 | Uncertainty shrinks with information | Should | Branch | `metrics.severeIntervalWidth` charted over sim time as calls, visits and inspections arrive |
| UN-6 | Show ranges on the map | Must | Branch | Cell tooltip shows `severeLo`–`severeHi` |
| UN-7 | Adjuster sees the range move | Should | Spec | "Severe: 3–11 → 5–8" on Report sent, snapshotted before the reducer call |

### 6.8 Simulated staff (SS)

| ID | Requirement | Pri | Status | Acceptance criteria |
|---|---|---|---|---|
| SS-1 | Queues are worked during the demo, reproducibly | Must | Built | `staff_sim` on by default; one step per 30 sim minutes; settings survive `reset_demo`; deterministic hash-based randomness, no `Math.random` in reducers |
| SS-2 | Capacity scales with the region | Must | Built | Per hour: calls 2% (min 20), welfare visits 0.3% (min 5), inspections 0.2% (min 3) of households |
| SS-3 | Outcomes do not come from the model | Must | Built | Results read private `sim_truth` |
| SS-4 | Referral desk | Must | Built | Refers each new life-safety report at the next step; agency acknowledges after 30 min and resolves after 6 h |
| SS-5 | Agents call | Must | Built | After the text has had 1 h; retry after 2 h; at most 3 failed tries. P(answer) = 0.75 (0.4 without a working phone) × 0.5 if truly needs help × 0.8 limited English × 0.7 destroyed home |
| SS-6 | Adjusters visit and inspect | Must | Built | After 2 failed calls, or 1 failed call and 4 h of silence. A visit always inspects the house; people are seen only if home. Separate inspections work the top of `inspection_candidate`; `staff_sim.inspectionsMade` |
| SS-7 | Locate, then close | Must | Built | Up to 3 emergency-contact tries (P = 0.6), then closure as `unreachable_after_visit` by `sim-staff` |
| SS-8 | Staff vs no staff | Must | Branch | Staff switch in the replay bar calls `set_staff_sim(enabled, callsPerHour, visitsPerHour, inspectionsPerHour)` (0 = default); `staff_sim` counters shown |

### 6.9 Field adjuster app (FA)

| ID | Requirement | Pri | Status | Acceptance criteria |
|---|---|---|---|---|
| FA-1 | Join as adjuster | Must | Branch | `join_as('adjuster', name, passcode)`; the passcode is typed, never stored or bundled |
| FA-2 | Task list | Must | Branch (partial) | `my_assignments`, plus top unassigned candidates in the branch version |
| FA-3 | Report people and home separately | Must | Branch (partial) | `submit_field_report`. Options map to `safety` / `memberMissing`: "Safe · everyone accounted for" = `safe` / false; "Needs help" = `needs_help` / false, or true if ticked; "Some seen, someone missing" = `unsure` / true; "Nobody seen · still unaccounted" = `unsure` / false. Branch has Safe, Needs help and Nobody seen, and omits `memberMissing` (R1) |
| FA-4 | Five-screen app | Must | Spec | Screens below; ordering P0 → P1 → P2, then `pNeedsHelp` |
| FA-5 | Needs help puts 911 first | Must | Spec | Red block "Anyone in danger? Call 911 now."; `Call 911 now` shows "Demo only. No call placed." in the demo build (`tel:911` in production); "Also creates a referral." |
| FA-6 | House not assessed | Must | Built; UI Spec | `damage = 255` needs a note ≥ 3 chars; no trust update; house stays queued. Reasons: "Unsafe to enter", "No access (flooded, cordon, red-tagged)", "Dark, no power" |
| FA-7 | Policy-aware form | Should | Spec | Renters: "Belongings and tonight" instead of structure. Condo: "Unit only · not the building". Welfare check: home section optional |
| FA-8 | Can't make contact | Should | Built; Branch (partial: closure only, no note) | Skip: `update_assignment(cancelled)`. Close: `close_household` with reason and note |
| FA-9 | Send state machine | Must | Spec | Table below; duplicate check by report count before any retry |
| FA-10 | Life-safety watchdog | Must | Spec | `needs_help` not Sent within 30 s → "Not delivered — call 911 directly" with `Call 911 now` |
| FA-11 | Field privacy | Must | Spec | No percentages; no age or living-alone labels; only `May need help leaving`, `Medical device`, `Speaks Spanish`; no notification content; local data cleared after Sent |
| FA-12 | Truthful status | Must | Spec | `live` / `reconnecting` / `offline` from real connection state, never hard-coded |
| FA-13 | New information on a task | Should | Spec | One-line banner when a reply, another adjuster's report or a closure arrives after assignment; Still go / Skip |
| FA-14 | Area-level navigation only | Must | Spec | "Go to area" routes in-app to the cell center; no external maps to synthetic households |

| # | Screen | Purpose | Key content |
|---|---|---|---|
| 1 | Tasks | See tasks, leave in order | Map pins, Next up card, other open tasks, done tasks with a separate people tag |
| 2 | Home | Why am I here, who, how to get in | WHY line, PEOPLE and HOME status, WHO LIVES HERE chips, Start field report, Can't make contact |
| 3 | Field report | Under 30 seconds at the door | 1 PEOPLE (4 options), 2 HOME (0–3 or Couldn't assess), note, Send report |
| 4 | Report sent | Confirm only after commit | PEOPLE / HOME / AREA rows, referral pill live |
| 5 | Can't make contact | Skip or close with a reason | Can't get there, Vacant, Not in the area, Unreachable after a visit |

| Send state | Entered when | UI copy | Next |
|---|---|---|---|
| Draft | Form open | "Send report" (disabled: "Choose people and home") | Tap saves to outbox → Sending |
| Sending | Tap, or retry | "Sending…" | Reducer resolves, or my report count > `baseCount` → Sent. SenderError → Failed. Offline or 8 s silence → Queued |
| Sent | Commit confirmed | Screen 4 | Clears outbox, draft and cached household |
| Queued | Offline or 8 s timeout | "Saved on phone · will send" | Retry on reconnect, every 20 s, or Try now; duplicate check first |
| Failed | Reducer rejected | "Failed — {server text}" | Try again or Edit; no auto-retry |

### 6.10 Policyholder reply page and Claude parser (PP)

| ID | Requirement | Pri | Status | Acceptance criteria |
|---|---|---|---|---|
| PP-1 | Reply by buttons, no login | Must | Branch | QR link `#/reply?h=<id>&code=<reply passcode>`; "I'm safe" / "I need help" and 0–3 → `submit_sms_reply`; "Someone in my household is unaccounted for" → `report_member_missing` |
| PP-2 | Reply in free text | Must | Built; UI Spec | `submit_raw_reply`: 1–500 chars, at most 5 pending per household and 500 in total; `reply_inbox.status` = `pending`. The page has a text box that is not connected yet |
| PP-3 | Worker turns raw text into fields | Must | Built | `claude-worker.ts` subscribes to pending rows, one at a time: `parseReply` → `submit_parsed_reply` (+ `report_member_missing`) → `mark_reply_parsed` |
| PP-4 | Claude sees text only and never scores | Must | Built | `buildRequest` sends the system prompt and the wrapped reply only; no household attributes; output is extraction fields |
| PP-5 | Structured output | Must | Built | `claude-sonnet-5-5`, effort `low`, `max_tokens` 2048, JSON schema output; valid JSON 800/800 |
| PP-6 | Never guess "safe"; damage only when visible | Must | Built | Unclear → `unsure`; false-safe pass bar ≤ 2%; measured 2/386. Not home → `damage = null` → 255, property stays unknown |
| PP-7 | Keyword net escalates only | Must | Built | About 60 rules in en/es/zh/vi/tl/ko force `life_safety = true`; never lowers anything; respects negation and offers of help |
| PP-8 | Failure is safe | Must | Built | Timeout (10 s), API error, refusal or schema violation → `unsure`, `life_safety = false`, `damage = null`. Submitted as needs help, so escalation is `assistance`. Keyword net still runs |
| PP-9 | Human review flags | Must | Built | `confidence < 0.6`, `unsure`, or keyword net disagreement → `reply_inbox.error = 'review: ...'` |
| PP-10 | Prompt injection resistance | Must | Built | Prompt rule: message is data; closing tags stripped before wrapping |
| PP-11 | Secret handling | Must | Built | `ANTHROPIC_API_KEY` from the environment only; never logged; never in frontend, tables or bindings. The worker logs no reply text |
| PP-12 | Degraded mode | Should | Built | `--no-claude`: every reply goes in as "needs help, a person calls back"; keyword net still escalates |
| PP-13 | Outreach in the household's language | Should | Spec | `household.primaryLanguage` is available; the simulator currently assumes English-only texts |

### 6.11 Random disasters and presets (RD)

| ID | Requirement | Pri | Status | Acceptance criteria |
|---|---|---|---|---|
| RD-1 | New event on demand | Should | Built | `scripts/new-disaster.ts --region tx/ca --db <db>`; generation about 1 s, Bay Area load about a minute. A manager request can also queue one for `scripts/disaster-worker.ts` on the demo Mac, while that map's worker runs |
| RD-2 | Plausible hurricanes | Should | Built | Category drawn 42 / 25 / 19 / 13 / 1% (Cat 1–5), landfall 27.3–28.1° N, surge by category, random local time |
| RD-3 | Plausible earthquakes | Should | Built | 7 fault traces, weights mostly from the USGS 2014–2043 forecast; magnitude within the fault's range; finite rupture, Atkinson & Wald (2007) intensity |
| RD-4 | Historical-analog presets | Should | Built | `celia-type-direct-hit`, `harvey-type-stall`, `hanna-type-cat1`, `haywired-m705`, `hayward-1868-night`, `calaveras-north-m686`; named "hypothetical, inspired by" |
| RD-5 | Out-of-sample test that never lands on a non-event | Should | Built | Calibrated model is kept, visible in `intervalCoverageLive` and holdout metrics. Fully random draws redrawn until ≥ 3% severe; `--any` keeps all, `--seed N` reproduces |

### 6.12 Manager dashboard and KPIs (MD)

| ID | Requirement | Pri | Status | Acceptance criteria |
|---|---|---|---|---|
| MD-1 | Live KPI strip and cards | Must | Branch (partial) | KPIs below; only the delivery split is missing |
| MD-2 | Panels | Must | Branch | Not heard from (`unaccounted_queue`), Requests (referrals, customer care, inspections), Feed; P0 / P1 / P2 sort on every tab |
| MD-3 | Replay controls | Must | Branch | Start, Pause, Reset, speed 1×–3× of 30 sim min/s, fast-forward +4 h and +24 h (repeated `step_replay(240)`) |
| MD-4 | Assign and log | Must | Branch | `assign_hex(hex, adjuster, 3)` and `assign`; a manager can log a contact outcome (`submit_parsed_reply`) |
| MD-5 | Region switcher, judge QR, standing synthetic label | Should | Branch | Corpus Christi, Bay Area, Harbor Bend (dev). QR passcode typed once by the manager. Header: "Synthetic exercise · real geography and census data · no real customer data" |
| MD-6 | Cost control | Must | Built | A paused replay schedules nothing; rows rewritten only when a value moves ≥ 0.0005 |

| KPI | Field | Status |
|---|---|---|
| P0 / P1 / P2 cells, cells needing verification | `metrics.p0Cells`, `p1Cells`, `p2Cells`, `needsVerificationCells` | Branch |
| Verified coverage | `metrics.verifiedCoverage` | Branch |
| Holdout error | `metrics.holdoutBrierSevere` | Branch |
| Source trust | `metrics.trustHazard`, `trustSms`, `trustClaims` | Branch |
| Unaccounted → 0 | `metrics.unaccounted`, `accountedRate` | Branch |
| High-risk unaccounted, longest wait | `metrics.highRiskUnaccounted`, `longestWaitMin` | Branch |
| Equity | `metrics.vulnerableAccountedRate` vs `accountedRate` | Branch |
| Referrals | `metrics.openReferrals`, `overdueReferrals` | Branch |
| Delivery split | `metrics.undeliveredUnaccounted`, `deliveredNoReply` | Built; UI Spec |
| Demand | `metrics.assistanceRequests`, `inspectionRequests`, `locateDue`, `recheckDue` | Branch |
| Severe total, range, width, live coverage | `metrics.expectedSevereTotal`, `severeTotalLo`, `severeTotalHi`, `severeIntervalWidth`, `intervalCoverageLive` | Branch |
| Staff work done | `staff_sim.callsMade`, `callsReached`, `visitsMade`, `visitsNobodyHome`, `inspectionsMade`, `referralsMade`, `helpFound` | Branch |

### 6.13 Next best recommendations (NB)

Location-based task suggestions for field adjusters. Open questions: Q6 and Q7.

Shift simulation (5 adjusters, 8 h, from t = 24 h, synthetic households, static task pool, straight-line distance): P0 tasks done were 143 against 80 for queue order and 102 for nearest first in Texas, and 147 against 66 and 37 in the Bay Area. Nearest first drives less and finishes more tasks in total. The list stays people first: P0 work in these runs was almost entirely welfare visits, and a visit report can also assess the house.

| ID | Requirement | Pri | Status | Acceptance criteria |
|---|---|---|---|---|
| NB-1 | Suggest tasks from where the adjuster is | Should | Built; UI Spec | `update_my_location` writes `adjuster_location` (`demo` or `gps`); `my_recommendations` returns the caller's top 10, at most 3 per cell |
| NB-2 | Candidates are visits a person still has to make | Should | Built | `unaccounted_queue` with `escalation = 'field_visit'` (welfare) plus `inspection_candidate` (inspection), minus households with an open assignment. A household in both stays welfare |
| NB-3 | Distance never beats urgency; rules, not an LLM | Must | Built | `recommend-rank.ts`, deterministic; Claude does not rank. Cell priority first: a nearer P1 never beats a P0. Within a priority: value / (drive minutes + 15 min on site), drive = straight-line km × 1.3 road factor at 35 km/h, not routing. Welfare value = 0.5 + 0.5 × min(1, weight × (1 + waitMin / 360)). Inspection value = `inspectScore` × 2 / (2 + verified households in the cell) |
| NB-4 | The list does not change under the adjuster | Should | Built | Recomputed only on location update, refresh, accept or report; never replaces a task on its own. Assignment, report or closure removes the household from every adjuster's list |
| NB-5 | One-tap self-assign | Should | Built; UI Spec | `accept_recommendation(householdId)`, adjuster role only. Task no longer needed: row removed and list refreshed, with no assignment, no notice and no error. Accepting notifies the policyholder (TN-1) |
| NB-6 | Phone card | Should | Spec | "Next best · 0.4 mi" on top of the task list, reason line ("No reply 14 h", "Inspect · first in area"), one Accept action (`docs/ADJUSTER_APP.md` section 2.7) |
| NB-7 | Demo start position | Should | Built; UI Spec | Households are synthetic, so the adjuster picks a start on the map (`source = 'demo'`); no real GPS or navigation to a synthetic address. A field report moves a `demo` adjuster to that household; `gps` stays |
| NB-8 | Adjusters on the manager map | Should | Built; UI Spec | `adjuster_location` + `member` names. The table is public for this; demo only, a real deployment restricts it to managers |

### 6.14 Task notices and chat (TN)

Tells the policyholder who accepted a task and gives the two a thread about it. `chat_message` and `imessage_outbox` are public only because this is a demo without policyholder login; production restricts them. `reset_demo` clears both.

| ID | Requirement | Pri | Status | Acceptance criteria |
|---|---|---|---|---|
| TN-1 | Tell the policyholder when an adjuster accepts a task | Should | Built; UI Spec | `accept_recommendation` adds one `chat_message` (`sender = 'system'`) and one `imessage_outbox` row (`queued`). The text names the adjuster, says what they were assigned, says "If anyone is in danger, call 911." and promises no arrival time. No notice when the task was no longer needed, and none for manager assignments (`assign`, `assign_hex`) |
| TN-2 | Adjuster messages the household | Should | Built; UI Spec | `send_chat_message(householdId, text)`: an adjuster with a non-cancelled assignment on that household, 1–500 chars. "Message" entry on the task and thread behaviour in `docs/ADJUSTER_APP.md` section 2.8 |
| TN-3 | Typed replies join the thread and still escalate | Must | Built; UI Spec | `submit_raw_reply` also appends the text to `chat_message` and still goes to the Claude parser, so a danger message in chat escalates normally. Replies through `submit_sms_reply` or `submit_parsed_reply` (buttons, parsed text) are not mirrored |
| TN-4 | Real iMessage to one demo phone, optional | Could | Built; UI Spec | `npm run imessage:bridge` on a Mac sends through Messages.app (Apple has no public API) to the one number in `IMESSAGE_DEMO_TO`; all households are synthetic and no phone number is stored. One-way: iMessage replies are not read, so the text says to reply in the app. Only notices created after it starts, at most 20 per run; `--dry-run` sends nothing. Results through `mark_imessage` (manager or owner). Without the bridge, rows stay `queued` and the UI labels them simulated |

## 7. Data

### 7.1 Real vs synthetic

| | Real (public data) | Synthetic (our simulator) |
|---|---|---|
| Geography | H3 cells over real blocks and tracts, OSM coastline, terrain | Harbor Bend (fictional town) |
| People | Census and ACS distributions per tract, LODES daytime workers, CDC SVI | Every household and policyholder, sampled from those distributions |
| Places | NCES schools, IPEDS universities, OSM hospitals, fire stations, shelters, masts | None |
| Hazard | USGS ShakeMap HayWired M7.05 MMI grid, CGS liquefaction zones | Corpus Christi hurricane (hypothetical Cat 4 track), Harbor Bend hurricane |
| After the event | None | Damage and needs (truth), whereabouts, tower outages, replies and their text, claims, field reports, staff calls and visits |
| Policies | None | Coverage flags and `phoneOnFile` are assumptions; no policy data is used |

### 7.2 Worlds

| | Harbor Bend, TX (fictional) | Corpus Christi, TX (real geography) | Bay Area, Alameda County, CA (real geography) |
|---|---|---|---|
| Live event | Hurricane, night | Hypothetical Cat 4, Saturday 02:00 | HayWired M7.05, weekday 10:40 |
| Cells / households | 331 / 3,000 | 449 / 20,000 | 611 / 30,000 |
| Events in live bundle | 4,620 | 33,249 | 35,994 |
| Facilities | 0 | 170 | 605 |
| Backtest events | 10 | 8 | 5 |
| Truth needs help (life safety / assistance) | 129 (96 / 33) | 826 (467 / 359) | 1,033 (805 / 228) |
| When it hit (home / away / displaced) | 2,391 / 0 / 609 | 17,445 / 0 / 2,555 | 8,930 / 17,353 / 3,717 |
| Replies (text / unknown damage / not home) | 1,366 (0% / 0% / 13%) | 9,944 (25% / 5% / 10%) | 7,381 (25% / 39% / 58%) |
| Life-safety / assistance / inspection replies | 7 / 48 / 237 | 56 / 355 / 2,111 | 65 / 240 / 1,289 |

### 7.3 Sources and licences

| Source | Used for | Licence or attribution |
|---|---|---|
| 2020 Census P.L. 94-171 (blocks, tracts, P5 group quarters) | Cells, household placement, college housing | Public domain |
| ACS 2020–2024 5-year (13 tables) | Age, household type, tenure, disability, vehicles, language, enrollment | Public domain |
| LEHD LODES8 2023 | Daytime workers, away-at-work probability | Public domain |
| CDC/ATSDR SVI 2022 | Scaling medical-device share | Attribution requested |
| NCES EDGE 2023–24, IPEDS 2023 | Schools, universities, enrollment | Public domain |
| OpenStreetMap (Overpass) | Hospitals, fire stations, shelters, masts, coastline | ODbL 1.0; credit wherever shown; derived data stays under ODbL |
| Terrain Tiles on AWS Open Data | Cell elevation for flood | Attribution per registry |
| USGS ShakeMap catalog (HayWired M7.05, BSSC2014); CGS liquefaction zones | `shakingMmi`, `liquefaction`, Bay Area only | USGS public domain; CA Dept. of Conservation / CGS |

Every real-geography bundle starts its source list with a SYNTHETIC notice.

### 7.4 Key assumptions (exact values)

| Assumption | Value |
|---|---|
| Damage score | wind (mph − 60) / 26; flood depth_ft / 2.7; shaking (MMI − 6.8) / 1.6. Levels at < 1.0, < 1.8, < 2.6 |
| Tower outage | 85 × sigmoid((wind − 116) / 8) or 80 × sigmoid((MMI − 9.2) / 0.25), plus a 95% blob at the worst area |
| Life safety | Needs help and (damage 3, flood > 4 ft, medical device with outage > 40%, or 75+ / disability with damage ≥ 2); otherwise 20% |
| Who gets a text | Phone on file (88%) |
| P(reply) | 0.78 × (1 − outage)^1.6, × 0.7 age 65+, × 0.85 age 75+, × 0.6 damage 3, × 0.5 needs help, × 0.55 limited English, × 0.6 away |
| SMS not delivered | min(0.9, 0.05 + 0.7 × outage + 0.4 if destroyed), for households that did not reply |
| Reported damage | Truth ± 1 at 30% (50% when away); seniors −1 at 30%; +1 at 45% in the over-reporting district |
| P(claim) by damage 0–3 | 0.03 / 0.35 / 0.75 / 0.9; × 0.15 flood without policy, × 0.2 wind not covered, × 0.08 quake without endorsement |
| Free text | About 25% of replies in the real-geography worlds; en/es/zh/vi/tl/ko templates; about 700 distinct combinations per region |
| Staff rates | Section 6.8; chosen to be plausible, not measured |

### 7.5 Data model at a glance

| Group | Tables | Notes |
|---|---|---|
| Static world (public) | `world`, `hex`, `household`, `facility` | `household` is public only because it is synthetic |
| Events (public) | `sms_sent`, `sms_reply`, `claim`, `field_report` | Written through `onEvent`; `source` = `replay`, `live` or `staff_sim` |
| Fusion output (public) | `hex_stats`, `household_estimate`, `inspection_candidate`, `metrics`, `model_state` | Rewritten only on material change |
| No one overlooked (public) | `household_followup`, `unaccounted_queue` | Referral state, closures, ranked outreach |
| Workflow and demo (public) | `replay_state`, `staff_sim`, `member`, `assignment`, `reply_inbox`, `adjuster_location`, `adjuster_recommendation`, `chat_message`, `imessage_outbox` | |
| Private | `config`, `sim_truth`, `staged_event`, `cell_agg`, `replay_tick`, `staff_contact` | Passcodes, truth, future events, aggregates, schedule, call attempts |
| Views | `my_member`, `my_assignments`, `my_recommendations` | Per caller |

## 8. Architecture

```text
 Public data (Census, ACS, LODES, SVI, NCES, IPEDS, OSM, Terrain, USGS, CGS)
      |  sim/real/fetch.ts (cached in data/raw/, gitignored)
      v
 Simulators: sim/src (Harbor Bend) + sim/real (real geography, random disasters)
      |  EventBundle JSON: live.json, backtest-N.json (shared/types.ts)
      v
 engine/scripts/calibrate.ts (leave-one-event-out) --> model.json (45 features, 2 logistic models, tau2, tail)
      |
      |  spacetimedb/scripts/seed.ts (owner only)
      v
 +--------------------- SpacetimeDB module, one database per world (Maincloud) ------------------+
 |                                                                                              |
 |  replay_tick (scheduled, 1 s) --> releases due staged_event rows --+                         |
 |  staff.ts (every 30 sim min) --> simulated calls, visits, referrals +                        |
 |  submit_sms_reply / submit_sms_text_reply (reply page) -------------+                        |
 |  submit_raw_reply --> reply_inbox ---(worker)--> submit_parsed_reply+                        |
 |  submit_field_report (adjuster only) -------------------------------+                        |
 |                                                                     v                        |
 |   onEvent(): event row --> hex_stats counters + metrics (same transaction)                   |
 |              --> recomputeCells(touched): fusion engine copy (src/fusion/engine/)            |
 |                  1 aggregate cell --> cell_agg (private)                                     |
 |                  2 world reference rates from all cell_agg rows                              |
 |                  3 estimate --> household_estimate, inspection_candidate, hex_stats          |
 |              --> accountFor(): escalation, household_followup, unaccounted_queue             |
 +----------------------------------------------------------------------------------------------+
        ^ subscriptions and reducers (WebSocket)                  ^ subscribe pending, call reducers
        |                                                         |
 Client (Vite + React + Leaflet + h3-js)              Claude worker (Node, on a laptop)
   #/          manager dashboard                        scripts/claude-worker.ts + parser.ts
   #/adjuster  adjuster phone                           --> Anthropic API (claude-sonnet-5-5)
   #/reply     policyholder SMS page
```

| Component | Path | Runs | Role |
|---|---|---|---|
| Contract and simulators | `shared/types.ts`, `sim/src`, `sim/real` | Offline, Node | Shared types; worlds, events, truth, random disasters |
| Engine and calibration | `engine/src`, `engine/scripts/calibrate.ts` | Offline; copied into the module by `npm run sync-engine` | Features, inference, intervals, active inspection, learning; leave-one-event-out training and evaluation |
| Module | `spacetimedb/src` (SDK 2.14) | Maincloud | 31 tables, 3 views, 43 reducers |
| Owner scripts | `spacetimedb/scripts` | Node | `seed`, `smoke`, `parity`, `bench`, `new-disaster`, `disaster-worker`, `sync-engine` |
| Claude worker | `spacetimedb/scripts/claude-worker.ts` | Node beside the demo | The one required runtime outside the database. It needs outbound HTTP, which reducers cannot make |
| iMessage bridge (optional) | `spacetimedb/scripts/imessage-bridge.ts` | Node on a Mac beside the demo | Sends task notices through Messages.app to one demo phone (TN-4); one-way |
| Client | `client/` on `origin/frontend/app` | Static web | Three screens; subscribes per screen to stay small on 20–30k households |

| Reducer group | Reducers | Caller |
|---|---|---|
| Seeding | `seed_world`, `seed_hexes`, `seed_facilities`, `seed_households`, `seed_truth`, `seed_staged_events`, `load_model`, `wipe_world`, `set_passcodes` | Owner |
| Replay and maintenance | `start_replay`, `pause_replay`, `step_replay`, `jump_to`, `set_speed`, `set_recompute_cadence`, `reset_demo`, `recompute_all`, `refresh_metrics`, `set_staff_sim`; `replay_tick` is scheduled by the database | Manager or owner |
| Membership | `join_as`, `leave`, `remove_member` | Passcode for staff roles; manager or owner to remove |
| Policyholder | `submit_sms_reply`, `submit_sms_text_reply`, `submit_raw_reply`, `report_member_missing` | `policyholder_demo`, manager, owner, or reply passcode |
| Parser | `submit_parsed_reply`, `mark_reply_parsed` | Worker, joined as manager |
| Notices | `mark_imessage` | Manager or owner; the iMessage bridge joins as manager |
| Field | `submit_field_report`, `update_my_location`, `refresh_recommendations`, `accept_recommendation`, `send_chat_message` | `adjuster` members only; `send_chat_message` also needs a non-cancelled assignment on the household |
| Work | `assign`, `assign_hex`, `update_assignment`, `update_referral`, `close_household` | Manager or owner; `update_assignment` also the assigned adjuster; `close_household` also adjusters |

| Maincloud database | World | Households / cells | Use |
|---|---|---|---|
| `triage-loop-nateeexu-dev` | Harbor Bend, TX | 3,000 / 331 | Development |
| `triage-loop-nateeexu-tx` | Corpus Christi hurricane | 20,000 / 449 | Demo |
| `triage-loop-nateeexu-ca` | Alameda County, Hayward Fault | 30,000 / 611 | Demo |

Host: `wss://maincloud.spacetimedb.com`. Full-recompute cadence on Maincloud: 120 sim minutes (module default 60). Touched cells recompute on every tick; pause, jump and end recompute everything. The local server is the offline fallback.

## 9. Metrics and evaluation

All numbers come from `docs/DATA.md`, `docs/SPACETIME_API.md`, `docs/CLAUDE_PARSER.md` and `model.json`. Everything except the bench and parser results is measured on simulated events.

### 9.1 Model calibration (leave-one-event-out, 95% cell-cluster bootstrap CI)

| Severe-damage model | Brier [CI] (range across events) | AUC [CI] | ECE | Brier skill vs no-live-signals baseline (range) |
|---|---|---|---|---|
| Harbor Bend (10 events) | 0.058 [0.055, 0.062] (0.013–0.084) | 0.954 [0.949, 0.957] | 0.017 | 0.25 (0.20–0.30) |
| Corpus Christi (8) | 0.042 [0.040, 0.043] (0.005–0.123) | 0.931 [0.925, 0.935] | 0.004 | 0.21 (0.15–0.27) |
| Bay Area (5) | 0.102 [0.099, 0.105] (0.036–0.160) | 0.882 [0.877, 0.886] | 0.018 | 0.18 (0.09–0.24) |

| Needs-help model (`model.json`) | Brier | ECE | AUC |
|---|---|---|---|
| Harbor Bend | 0.026 | 0.006 | 0.834 |
| Corpus Christi | 0.029 | 0.003 | 0.865 |
| Bay Area | 0.026 | 0.003 | 0.869 |

The baseline uses the hazard and static feature groups, without SMS or claims. The bootstrap CIs are narrow because they measure sampling noise within simulated events; the range across events is the real spread. Neither says anything about real-world accuracy.

### 9.2 Interval coverage

| Region (held-out coverage / mean width in households) | Normal approximation (old) | Exact, deployed (90%) | Backtest-calibrated tail (not deployed) |
|---|---|---|---|
| Harbor Bend | 99.1% / 2.38 | 96.8% / 1.64 | 90.4% / 0.97 |
| Corpus Christi | 98.9% / 3.11 | 97.6% / 2.44 | 90.2% / 1.32 |
| Bay Area | 97.3% / 5.65 | 95.4% / 4.87 | 90.8% / 3.84 |

The calibrated tail reached 90% on history but was overconfident on the harder live event (Bay Area live coverage 67% at t = 0), so production uses the conservative interval.

| Live check, staff on (`intervalCoverageLive`) | t = 0 | 24 h | 72 h | Summed width change over 72 h |
|---|---|---|---|---|
| Harbor Bend | 96% | | 98% | −69% |
| Bay Area | 73% | 79% | 85% | −53% |

Early in a harder-than-history event the model is biased (Bay Area under-predicted by about 12% before any field report). Coverage recovers as reports correct it.

### 9.3 Staff vs no staff (72 h replays, v3 data)

| Measure | No staff | Staff on |
|---|---|---|
| Harbor Bend accounted at 24 h / 48 h (of 3,000) | 1,590 / 1,693 | 2,264 / 3,000 |
| Harbor Bend high-risk unaccounted at 24 h | 760 | 107 |
| Harbor Bend overdue 911 referrals | 7 | 0 |
| Bay Area accounted at 24 h / 72 h (of 30,000) | 8,138 / 8,981 | 15,326 / 27,598 |
| Bay Area overdue 911 referrals | 65 | 0 |

In the Bay Area weekday quake, 65% of staff visits find nobody home (4,021 of 6,210 over 72 h): the visited homes are the badly damaged ones and their people have left, so the next step is `locate`. Staff rates are assumptions, so this is a simulation result, not a forecast. Measured on the local server after SMS delivery receipts and the coverage-aware inspection queue (default capacity, `jump_to` in 24 h steps).

### 9.4 Random disasters (out-of-sample, staff on)

| Event | t = 0 severe [range] | 24 h | 72 h | True | Cell coverage | Reached by 72 h |
|---|---|---|---|---|---|---|
| Random Cat-1 hurricane, weekend 15:00 (TX seed 42) | 322 [37, 872] | 236 [193, 418] | 247 [241, 266] | 245 | 99–100% | 20,000 / 20,000 |
| Hayward M7.0, weekday 03:00 (CA seed 8) | 12,138 [8,916, 15,417] | 12,790 [10,883, 14,791] | 12,598 [11,171, 14,139] | 12,296 | 88–92% | 30,000 / 30,000 |

### 9.5 Reply parser evaluation

Model `claude-sonnet-5-5`, low effort, prompt v1, 2026-11-08. 800 cases: 40 adversarial, 600 hand-written (100 each in en, es, zh, vi, tl, ko), 160 stratified simulator replies. 95% Wilson intervals.

| Metric | Result | Pass bar |
|---|---|---|
| Life-safety recall | 222/224 = 99.1% [96.8–99.8%] | 100%: not met |
| By language | en 55/57, es 38/38, zh 34/34, vi 30/30, tl 32/32, ko 33/33 | |
| False-safe rate | 2/386 = 0.5% [0.1–1.9%]; both are "the dog ran away, everyone is fine", a label question | ≤ 2%: met |
| Extra referrals | 23 of 576 non-life-safety cases | |
| Safety exact | 88% overall; 95.6% on unambiguous hand-written cases | |
| Damage within 1 when a number is given | 414/414 | Bar (≥ 95%) is defined over all labeled cases; the large run reports numeric answers only |
| Damage unknown correct | 357/360 | ≥ 90%: met |
| Valid JSON | 800/800 | 100%: met |
| Keyword net | Caught 12 cases on top of Claude | |
| Latency | Mean 1.4 s, p95 1.7 s | |

| Follow-up | Result |
|---|---|
| The two misses and prompt v2 | A child out of a caregiver's reach and "can someone check on us, my husband is bedbound". Both fixed in prompt v2 plus a keyword rule. v2 is deployed (`PROMPT_VERSION = 'v2'`), but only those two cases and one inspection counter-example were checked; the full set was not re-run (cost decision) |
| Blind second annotation (640 hand-written and adversarial texts) | life_safety 99.8% (kappa 1.00), safety 97.5% (kappa 0.96), not_home 100%, missing_people 99.8%, damage exact 97.7% |
| On the 623 cases where both annotators agree | Life-safety recall 193/194; false-safe 1/327 |
| Caveat | Both annotators are Claude models following the same written rules, so this measures rule consistency, not agreement with human emergency dispatchers |
| Earlier 80-case run | Life-safety recall 25/25; false-safe 0/37; valid JSON 100%. Damage within 1 was 90%, below the 95% bar; all 5 misses were Claude answering unknown for a vague text. Latency mean 1.5 s, p95 2.7 s |
| Offline checks | `npm run parser:test` 49/49. Keyword net alone: recall 15/15 adversarial and 10/10 real, 0 false-safe |

### 9.6 Latency and cost (local server, MacBook, `scripts/bench.ts`)

| | Harbor Bend | Corpus Christi | Bay Area |
|---|---|---|---|
| `submit_field_report` | 4 ms | 5 ms | 5 ms |
| `pause_replay` (full recompute + holdout) | 14 ms | 66 ms | 79 ms |
| `jump_to(4320)` from t = 0 | 83 ms | 355 ms | 535 ms |
| Tick at speed 30, no full recompute: median / p95 / max | 5 / 16 / 25 ms | 12 / 67 / 99 ms | 9 / 87 / 162 ms |
| Tick with full recompute (cadence 60): median / p95 / max | 22 / 29 / 43 ms | 96 / 138 / 168 ms | 116 / 185 / 253 ms |

On Maincloud: `step_replay(240)` about 1 s; Bay Area `jump_to(1440)` about 4 s. No end-to-end client-to-screen latency on Maincloud is recorded in the repo; "manager map updates within a second" remains a target.

## 10. Privacy, safety, fairness and compliance

| Area | Rule | Enforcement | Status |
|---|---|---|---|
| Who is contacted | Existing customers only, through the phone on the policy. Consent and applicable rules must be checked before any real send | Product design; demo texts are simulated, and the optional iMessage bridge sends to one demo phone only | Built (demo) |
| Location | No tracking of strangers' phones. WEA is run through FEMA's IPAWS and needs authorized senders | Non-goal | n/a |
| Data sent to the LLM | Reply text only. No age, disability, medical, coverage, address or identity fields | `buildRequest` in `scripts/parser.ts` | Built |
| Sensitive attributes in the model | Race, ethnicity and income are not features; income is at most a post-hoc fairness audit | `FEATURE_NAMES` | Built |
| Medical information | Used only when the customer volunteers it and consents | Product rule; synthetic in the demo | Design |
| Referral data sharing | Passing policyholder details to a public agency needs consent or a legal basis | Product rule | Open (Q1) |
| Synthetic households | Coordinates fall inside real blocks and may coincide with a real home. No addresses exist. No external navigation to a household; route to the cell center only | `docs/ADJUSTER_APP.md` | Spec |
| Field minimization | No ages or living-alone labels; no percentages; no notification content; local cache cleared after Sent | `docs/ADJUSTER_APP.md` | Spec |
| Secrets | Public repo; `.env` gitignored; `ANTHROPIC_API_KEY` never in frontend or tables; staff passcode typed, never bundled | `.gitignore`, worker, client join dialog | Built |
| Passcodes | Staff and reply passcodes in the private `config` table. Default values work on local only. Maincloud uses private values. Reply passcode may travel in the QR link because it only allows replies | `seed.ts`, reducers | Built |
| Abuse limits | At most 5 pending replies per household and 500 total | `submit_raw_reply` | Built |
| Demo auth and public `household` table | Roles are self-assigned with shared passcodes; anyone with the staff passcode can become a manager. `household` is public only because it is synthetic | Production needs OIDC and per-role views | Limitation |
| Public `chat_message` and `imessage_outbox` | Public only because this demo has no policyholder login. Neither table stores a phone number | Production restricts both tables | Limitation |
| Licences | OSM credited wherever data is shown; OSM-derived data stays ODbL; Esri attribution kept | Map and docs | Branch |
| Fairness | `vulnerableAccountedRate` compared with `accountedRate`; vulnerable is defined by functional need, not identity | `metrics`, Accounting card | Branch |

**Insurer-specific liability lines (keep verbatim)**

| Situation | Line |
|---|---|
| Needs-help report filed | "Referral created" and "Call 911 now if anyone is in danger." |
| Life-safety report not sent | "Not delivered — call 911 directly" |
| Peril not covered | "Flood not covered · refer to FEMA / NFIP · don't promise payment" (and wind, quake variants) |
| Task accepted, notice to the policyholder | One template (`spacetimedb/src/notice-template.ts`): "Adjuster {name} has been assigned to {task}.", damage levels 1 minor or none, 2 moderate, 3 severe, 4 not sure, then "If anyone is in danger, call 911." |
| Never | "help is on the way", promised arrival times, "predicts who is trapped", "guarantees" |
| Prompt rule | "Never promise help, arrival times or coverage." |
| Eligibility wording | Temporary housing is reviewed for eligibility; it depends on the loss being covered and on the policy |

## 11. Risks, limitations and open questions

### 11.1 Risks

| ID | Risk | Impact | Mitigation or state |
|---|---|---|---|
| R1 | The client (last commit Nov 7 23:44) predates the parser and field-report change (Nov 8 00:41) and delivery receipts (Nov 8 01:11). Its bindings omit `memberMissing` on `submit_field_report` and `note` on `close_household`; the free-text box is not connected; the delivery split is not shown | High: those two calls will not match the current module until the client is updated | Merge, regenerate bindings, pass the two arguments, wire `submit_raw_reply` |
| R2 | The worker is one Node process on a laptop | High for free text: if it stops, `reply_inbox` rows stay `pending`, including possible life-safety text | `--no-claude` degraded mode exists; no alert for a stale inbox yet |
| R3 | Maincloud unavailable, weak conference network, or a running replay burning energy | Demo failure or budget | Local server on a hotspot; backup video; adjuster outbox (Spec); pause when not demoing |
| R4 | Prompt v3 is not fully re-evaluated | Published numbers are for v1 | `npm run parser:eval -- --set all --real-n 160` |
| R5 | Parser failures count as heard from (`assistance`, accounted) | A failed parse leaves the outreach queue | Review flag and customer-care route; see Q3 |
| R6 | Judges read simulated results as real accuracy | Credibility | Section 0 and the data card state it first |

### 11.2 Limitations

| Limitation | Detail |
|---|---|
| Circular validation | Trained on backtests and tested on the live event from the same simulator. Shows internal consistency, not real-world accuracy |
| Policyholders only | People without a State Farm policy are not in the data |
| Household, not person | "Member missing" is a flag, not a headcount |
| Bay Area is harder | Weekday-daytime quake: most replies come from people not at home, so damage is often unknown. Severe Brier 0.102, up from 0.071 before the v3 data |
| Template texts and English-only outreach | About 700 template combinations per region; real messages are messier. The simulator assumes English-only texts (limited English × 0.55), though `primaryLanguage` is available |
| Invented staff rates | Answer rates, capacities and agency timings are assumptions |
| Random disaster physics | Straight rupture, one intensity equation, no site amplification beyond liquefaction, parametric wind and surge. Atkinson & Wald likely overpredicts near the fault above M6 |
| Trust learning | Display-only; it does not change inference |
| Known counter defect | `recompute_all` mid-replay counts calls as SMS replies and zeroes `callContacts`; `reset_demo` is not affected |
| LLM scope | Only reply parsing is built. Outreach generation, manager explanations and field-note structuring from `docs/FEATURES.md` are not |

### 11.3 Open questions

| ID | Question |
|---|---|
| Q1 | What consent or legal basis lets State Farm share policyholder details with an agency, and what SMS consent rules apply to a mass check-in? |
| Q2 | What are real answer rates and agency acknowledgment times? |
| Q3 | Should a parser failure stay unaccounted until a person reads it? |
| Q4 | Should `inspection_request` raise a household in the adjuster queue directly (AQ-4)? |
| Q5 | What does end-to-end latency look like on Maincloud with judges' phones? |
| Q6 | The Next best list recomputes only on location update, refresh, accept or report, so it can go stale between refreshes as priorities, waits and the queue move. Should the card show its age or prompt a refresh? |
| Q7 | Nearby adjusters can see the same household until one accepts it. Should lists avoid overlap? |

## 12. Mapping to the judging criteria

The repository has no verbatim rubric. The criteria below are the team's reading in `docs/research/sponsor-research.md` and `docs/BACKGROUND.md`.

### State Farm: "The Worst Day, at Scale"

| What the track asks (per our research) | Saviu's answer | Evidence |
|---|---|---|
| Identify those with the most urgent need | P0 / P1 / P2 per cell; P(needs help) per household; CMIST-based features | FE-2, PV-1, section 9.1 |
| Coordinate aid | Referrals with timers, assistance to customer care, inspection queue, adjuster assignment, FEMA pointers for uncovered losses | RF-1–7, AQ-1–6 |
| Make sure no one is overlooked; find those who did not speak up | Silence is unaccounted; ladder ends at a door; aging queue; delivery receipts; silence causes | AC-1–12, DR-1–5, section 9.3 |
| Insurer realism, not a rescue fantasy | Refers, never rescues; coverage-aware queue; no service promises; "don't promise payment" | Sections 4, 10 |
| Hardest part: backtesting | 23 backtest events across three worlds, leave-one-event-out, intervals, live coverage | Sections 9.1–9.2 |

### Spacetime: "Build with Spacetime"

| Requirement or interest | Saviu's answer | Evidence |
|---|---|---|
| Public GitHub repository | `NateeeXu/UTD_ZERODAY`, no secrets committed | `.gitignore`, section 10 |
| Most of the backend on Spacetime | Event ingest, permissions, fusion, accounting, simulated staff, replay clock and metrics all run in reducers. Only the LLM call and the optional iMessage bridge sit outside | Section 8 |
| Not just a message channel | `onEvent` → fusion in the same transaction; `parity.ts` matches the offline engine | FE-4, FE-5 |
| Real-time, multi-user | Manager, adjuster and policyholder screens subscribe to the same tables; three databases, one module | Section 8, MD-1 |
| Scale | 30,000 households, 611 cells; tick median 9 ms and field report 5 ms locally | Section 9.6 |

### What separates this from common hackathon entries (sponsor research)

| Common pattern | Saviu |
|---|---|
| Disaster map plus LLM summary | LLM only extracts; a deterministic, calibrated engine decides |
| Numbers without provenance or evaluation | Each cell states its reason; thresholds in one config object; labeled sets, confidence intervals, published misses |
| Overconfidence | Intervals, live coverage, conservative tail, stated limits |
| Demo judges only watch | QR reply page lets judges act on the live map |

## 13. Roadmap after the hackathon

Items marked (repo) are named in the docs as future work. The others are proposals that follow from the limits above.

| Horizon | Item | Source |
|---|---|---|
| Immediately | Merge the client, regenerate bindings, pass `memberMissing` and `note`, show the delivery split (R1) | Proposal |
| Immediately | Five-screen adjuster app and send state machine; free-text reply page wired to `submit_raw_reply` | (repo) `docs/ADJUSTER_APP.md`, `docs/SPACETIME_API.md` |
| Immediately | Re-run parser eval on prompt v3 | (repo) `docs/CLAUDE_PARSER.md` |
| Immediately | Backend for the adjuster app: `household.address`, `accessNote`, contact attempts, server-side `opId` dedupe, note on `update_assignment`, structured renter fields | (repo) `docs/ADJUSTER_APP.md` |
| Production integrations | Real SMS provider with carrier receipts and consent; policy and claims systems; referral handoff with consent or legal basis | (repo) `docs/BACKGROUND.md`, sponsor research |
| Production integrations | OIDC (SpacetimeAuth, Auth0, Clerk), owner-managed members, per-role views over `household` | (repo) `docs/SPACETIME_API.md` |
| Real data | OpenFEMA NFIP claims to learn "expected claims at this intensity", FCC DIRS outages, OSM road isolation; measured staff and agency rates | (repo) sponsor research; Proposal |
| Human evaluation | Label parser sets with human emergency dispatchers; red-team messy real messages; pilot with CAT managers and adjusters | Proposal |
| Product | Outreach in the household's language; Claude explanations for managers and structured field notes, still never scoring; move the worker into a Spacetime procedure | (repo) `docs/FEATURES.md` |
| Product | Offline mode for field work (map tiles, photo upload) | Excluded now in `docs/ADJUSTER_APP.md`; Proposal |
| Model and fairness | Person-level accounting; trust applied to inference once validated; site amplification in random quakes; post-hoc fairness audit | Proposal; (repo) `docs/FEATURES.md` |

## Appendix: glossary

| Term | Meaning |
|---|---|
| P0 / P1 / P2 | Action priority of a cell: how fast to act. P0: `maxPNeedsHelp ≥ 0.5` or severe share ≥ 0.5, or a silent high-hazard cell ("suspected P0"). P1: ≥ 0.25 or ≥ 0.2. P2: otherwise |
| Verified / needs verification | Information status of a cell, separate from priority. `needs_verification` if confidence < 0.5 or silent high hazard |
| Severe | Damage ≥ 2 on the 0–3 scale (none, minor, severe, uninhabitable). 255 = house not assessed or unknown |
| Accounted | The people of a household have been heard from or seen, or the household was closed with a documented reason. Otherwise unaccounted, never "fine" |
| Vulnerable, high-risk | Vulnerable: 75+, disability, no vehicle, limited English, medical device, or 65+ living alone. High-risk: vulnerable, `pNeedsHelp ≥ 0.3`, or in a P0 cell |
| Silence | Expected signal that is missing, weighted by hazard, 0–1 |
| Holdout | 15% of households never used for training or trust learning; scored only against simulated truth |
| Referral | A handoff to 911 or a local agency. A referral, not a dispatch |
| CMIST | Communication, Maintaining health, Independence, Support and safety, Transportation: the FEMA and HHS functional-needs framework |
| H3 | Uber's hexagonal grid. Resolution 8 for cells, resolution 7 for districts |
| LOEO | Leave-one-event-out: train on all backtest events but one, test on the one left out |
| Brier score, Brier skill | Mean squared error of a probability (lower is better); skill is 1 − Brier / baseline Brier (higher is better) |
| ECE | Expected calibration error: average gap between predicted and observed rates across bins. Lower is better |
| AUC | Probability that a true positive is ranked above a true negative |
| Kappa | Cohen's kappa: agreement between two annotators beyond chance. 1 is perfect |
| τ² (tau2) | Cell-level shared error used to widen intervals. HB 0.012, TX 0.001, CA 0.008 |

**Escalation values** (`ESCALATION` in `spacetimedb/src/fusion/index.ts`)

| Value | Accounted | Meaning |
|---|---|---|
| `sms_sent` | No | Waiting on the outreach text |
| `sms_resend` | No | Resend the text |
| `agent_call` | No | Agent or emergency contact calls |
| `field_visit` | No | A person goes to the door |
| `locate` | No | House inspected, nobody seen: emergency contact, shelter lists |
| `recheck` | Yes | Vulnerable, last contact older than 24 h: daily welfare check |
| `emergency_referral` | Yes | Life-safety report waiting to be referred |
| `referral_pending` | Yes | Referred, waiting for agency acknowledgment |
| `referral_overdue` | Yes | A referral timer ran out |
| `referral_acknowledged` | Yes | Agency acknowledged |
| `assistance` | Yes | Needs help that is not life safety: customer care |
| `inspection_request` | Yes | Asked for someone to look at the house |
| `accounted` | Yes | Heard from, no danger |
| `verified` | Yes | An adjuster saw the occupants |
| `closed` | Yes | Documented closure reason |

**Referral states** (`household_followup.referralStatus`): `''` none yet, `referred`, `acknowledged`, `resolved`. Timers: 30 min to refer, 60 min to acknowledge.

**Closure reasons** (`household_followup.closureReason`): `vacant`, `not_in_area`, `unreachable_after_visit`.
