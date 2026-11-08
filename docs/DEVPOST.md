## Inspiration



## What it does

Saviu is a command center for an insurer's catastrophe team in the first 72 hours after a hurricane or earthquake. It answers two questions live: which policyholders need attention first, and who haven't we heard from yet.

After a disaster, claims and texts pour in and staff is limited. Sorting by what comes in first ranks the loudest neighborhoods first. Where cell towers and roads are down, the hardest-hit households often go quiet. Saviu's rule is that **silence is not safety**.

For every H3 hexagon on the map, Saviu fuses three imperfect signals:

1. **Hazard**: wind, surge or shaking intensity, plus zones marked by analysts.
2. **SMS check-ins**: a short text to policyholders at affected addresses ("Are you safe? How bad is the damage?").
3. **Claims**: the claims that have arrived compared with the number we'd expect at that intensity.

Each cell gets two separate labels: an **action priority** (P0 / P1 / P2) and a **verification status** (verified / needs verification). A high-hazard cell with no replies can never default to safe.

There are three screens:

- **Manager dashboard**: a live priority map with a 90% range on each cell's estimate. It also has outreach and referral panels and a timeline you can replay, jump or pause. A "decision trace" shows how one text message became a priority.
- **Adjuster phone app**: a task list sorted by a "next best" ranking, a map, chat with the policyholder, and a two-step field report. Reports are queued while the phone is offline and sent when it reconnects. Each report updates the estimate for that area within milliseconds.
- **Policyholder reply page**: opens from a QR code with no login. People can answer in their own words and their own language. Claude reads the text, and a person who needs help gets a Call 911 button.

Every household is tracked until someone reaches it. A silent household is "unaccounted" until it is reached or a person closes it with a reason. Each one moves through an escalation ladder of text, then call, then a visit at the door. Life-safety cases are referred to 911 and local agencies on a timer, with overdue referrals flagged. Saviu doesn't dispatch rescue itself.

We run it on three worlds: Harbor Bend, TX (a fictional town), a hypothetical Category 4 hurricane over Corpus Christi (20,000 households), and the USGS HayWired M7.05 Hayward Fault scenario in Alameda County (30,000 households). A button starts a new random hurricane or earthquake to show the model on an event it hasn't seen.

## How we built it

- **SpacetimeDB is the backend, and nearly the whole app runs inside it.** The tables, permissions, fusion engine, household tracking and replay clock all run in the database, with 28 tables and 38 reducers. A scheduled tick replays the event every second. Whenever an event arrives (a text, a claim or a field report), the touched cells are recalculated in the same transaction, and every connected screen updates over its subscription. Each world is its own database on Maincloud.
- **Fusion engine (TypeScript)**: two logistic models, one for severe damage and one for needs help, using 45 features grouped into hazard, home, household needs, SMS and claims. We calibrated them with leave-one-event-out backtests on past simulated storms. Each cell gets a 90% interval. Field reports correct the estimate in that area right away and adjust trust in each source as reports pile up. Race, ethnicity and income aren't features.
- **Simulators** build each world from real public data and sample synthetic households from it: Census and ACS demographics, LEHD commuting (who is home during the day), CDC SVI, NCES schools, OpenStreetMap facilities and towers, AWS terrain tiles, and USGS ShakeMap and California liquefaction zones. The disasters, households, texts, claims and field reports are all simulated. No real customer data is used.
- **Claude** (Sonnet 5.5, through the Anthropic SDK) does one job: it reads free-text replies and returns structured JSON (safety, damage, needs, whether anyone is missing). It gets only the message text, never age, address or coverage, and it never scores or ranks. A keyword safety net runs after it to catch life-safety words it might miss. It runs as a small Node worker because reducers can't make outbound HTTP calls.
- **Client**: React 19, Vite and TypeScript, with Leaflet and h3-js for the hex map, d3-contour for the hazard bands, and HERE and Esri basemaps. To keep 20–30k households fast, each screen subscribes only to the rows it needs. It's deployed on Vercel.
- An **iMessage bridge** sends real "adjuster assigned" notices to a demo phone from a Mac.

## Challenges we ran into

- **Telling silence apart from danger.** A quiet household might be trapped, or at work across town. In the Bay Area weekday quake, most people aren't home when it hits, so their replies can't describe the house. We used commuting data to model where people are during the day and kept "not home" separate from "needs help".
- **Being honest about uncertainty.** An interval calibrated on past events reached 90% on the backtests but was overconfident on the harder live event (67% coverage at the start in the Bay Area). We shipped the more conservative interval and added a live check of how often the intervals contain the simulated truth.
- **Scale inside a database.** Recalculating 30,000 households on every tick was too slow, so we recalculate only the cells an event touches and do a full pass on a slower cadence. A field report takes 4–5 ms round trip on a local server.
- **Keeping the frontend in step with the backend.** The schema kept changing, and stale generated bindings left the map blank. We wrote a script that syncs bindings from the live schema.
- **Building for a phone.** Getting the adjuster app to work with one hand: an offline outbox that can't double-send, the iOS keyboard covering the chat, and a task sheet you swipe down to a one-line peek.

## Accomplishments that we're proud of

- In simulation, the same staff with Saviu's ranked queue reached all 3,000 Harbor Bend households within 48 hours, compared with 1,693 with no follow-up, and 27,598 of 30,000 in the Bay Area by 72 hours, compared with 8,981. Overdue 911 referrals dropped from 65 to 0. (These are simulation results with assumed staff rates, not forecasts.)
- The reply parser caught 222 of 224 life-safety messages (99.1%) across 800 test messages in six languages (English, Spanish, Chinese, Vietnamese, Tagalog and Korean), marked only 2 of 386 people safe who weren't, and returned valid JSON every time. We fixed both missed cases in the next prompt version.
- On held-out simulated events, the severe-damage model scores an AUC of 0.88–0.95.
- We wrote down plainly what is real and what is simulated, and what we don't claim.

## What we learned

- The hard part was deciding what to do with uncertainty, not the model. Keeping "how urgent" and "how sure are we" as two separate labels made the map much easier to act on.
- A language model is most useful when it does one narrow job (turning a messy text into a structured reply) and the rules make the decisions.
- When the database runs the logic, the app logic gets simpler: every screen shows the same state without us writing any sync code.
- Testing only against our own simulator proves the pipeline holds together, not that it's accurate in a real disaster. We tried to say that clearly.

## What's next for Saviu

- Outreach texts in each household's language.
- A real SMS provider with delivery receipts and consent, and connections to real policy and claims systems.
- Learning expected claim volumes from OpenFEMA flood-insurance claims, and tower outages from FCC outage reports.
- Having human emergency dispatchers label the parser's test set, and piloting with real catastrophe managers and adjusters.
- Proper sign-in (OIDC) in place of the shared demo passcodes.
- Moving the Claude worker into a SpacetimeDB procedure so nothing runs outside the database.
- Offline map tiles and photo upload for field work.
