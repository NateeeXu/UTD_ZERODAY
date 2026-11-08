# Prompt for the frontend teammate

Paste everything below the line into Claude Code (or another coding agent) running in your clone of the repo.

---

You are building the frontend for **Triage Loop**, our HackUTD 2026 project (tracks: State Farm "The Worst Day, at Scale" + Spacetime "Build with Spacetime"). Final submission is Sunday 12:00 (submit by 11:30), the Devpost draft is due Saturday 23:00, code freeze Sunday 08:00. Work fast; ship the main loop first.

## Setup
- Repo: https://github.com/NateeeXu/UTD_ZERODAY (public). Base branch: `setup/project-docs`. Create your own branch from it, e.g. `frontend/app`, and commit often with clear messages. Pull `setup/project-docs` regularly; the backend owner (Nate) keeps pushing there.
- Work only in `client/` (and `docs/` for Devpost/pitch text). Do NOT edit `shared/`, `engine/`, `sim/`, `spacetimedb/` or `data/`; if you need a backend change, write it down and tell Nate.
- Stack: Vite + React + TypeScript, Leaflet (react-leaflet is fine), `h3-js`, the SpacetimeDB TypeScript client `spacetimedb` (React helpers in `spacetimedb/react`). Node 22+.
- Never commit secrets. The repo is public.

## Read first (in this order)
1. `docs/BACKGROUND.md` — the product (Chinese) and `README.md` (English).
2. `docs/SPACETIME_API.md` — every table, reducer, role, passcode flow and the subscriptions per screen. Section 0 is the shared dev database.
3. `shared/types.ts` — data contract (HexEstimate, Household, Facility, World).
4. `docs/preview/map-preview.html` — **the approved map style. Copy its look and logic.** Open it in a browser (it reads `docs/preview/preview-data.js`).

## Backend connection
- Host `wss://maincloud.spacetimedb.com`, database `triage-loop-nateeexu-dev` (Harbor Bend demo data for now). Two more databases are coming for the real demo: Corpus Christi (hurricane) and the Bay Area (Hayward Fault earthquake). Make the database name configurable (`VITE_SPACETIME_DB`) and add a region switcher that maps region → database name.
- Generate client bindings into `client/src/module_bindings`: `spacetime generate --lang typescript --out-dir client/src/module_bindings --module-path spacetimedb` (install the CLI with `curl -sSf https://install.spacetimedb.com | sh`), or copy `spacetimedb/bindings/`. Regenerate whenever Nate says the schema changed (an engine v2 sync is in progress: `hex_stats` gains `hazard`, `reason`, `silence_cause`, and a `facility` table is being added).
- Passcodes: Nate sends them to you privately. **Do not put the staff passcode in env vars or the bundle** (the built JS is public). Users type it in a join screen that calls `join_as(role, name, passcode)`. The reply passcode may travel in the QR link (`/reply?h=<householdId>&code=<reply passcode>`); it only allows SMS replies.
- Maincloud energy: a running replay ticks every second. Always provide a Pause button and pause when you are not testing.

## Three screens
1. **Manager dashboard** (laptop, the main demo screen)
   - Map (spec below) + right panel with two queues: **Action queue** (P0 first, then households by `pNeedsHelp`) and **Verification queue** (cells with `needs_verification` by severity, or households by `inspectScore`, max ~3 per cell).
   - Replay controls: start (speed 30), pause, jump to 2 h / 6 h / 24 h, reset (`start_replay`, `pause_replay`, `jump_to`, `reset_demo`). Show the sim clock from `replay_state`.
   - Live event feed (new `sms_reply`, `claim`, `field_report` rows, newest first).
   - Metrics strip from `metrics`: P0/P1/P2 counts, verified coverage, holdout error, source trust (hazard / SMS / claims).
   - Assign inspections: pick an adjuster from `member`, call `assign_hex(hex, adjusterHex, 3)`.
2. **Adjuster phone** (mobile web): join as adjuster; list from `my_assignments`; each card shows address area, coverage flags (wind / flood policy / earthquake endorsement / renter), vulnerability flags, contact history; the form has **two separate parts: life safety (safe / needs help / unsure) and home damage (none / minor / severe / uninhabitable)** → `submit_field_report`. The manager map must update within a second.
3. **Policyholder SMS page** (judge scans a QR code): a fake SMS thread from State Farm ("Are you safe? Reply SAFE or HELP. How bad is the damage, 0–3?"), buttons call `submit_sms_reply`. Mobile-first, works without login.

## Map spec (match docs/preview/map-preview.html)
- Basemap: Esri World Light Gray Base + World Light Gray Reference labels in their own pane (zIndex 450, pointer-events none). **Do not use CARTO tiles: they now require an API key.** Keep the Esri attribution.
- H3 cells from `hex`, results from `hex_stats`. Color by priority: P0 `#d93a35`, P1 `#ee7d2b`, P2 `#e8b931`.
- **A — confidence as opacity**: `fillOpacity = 0.12 + 0.73 × confidence`; stroke opacity `0.35 + 0.5 × confidence`. No hatching.
- **C — pulse ring** only on the 10 most urgent silent cells: `priority = P0 AND verification = needs_verification AND silence ≥ 0.5 AND hazard ≥ 0.5`, ranked by `silence × hazard × households`. CSS: `transform-box: fill-box; transform-origin: center;` scale 1 → 1.6 with fading stroke, 1.8 s loop.
- No question-mark badges on the main map (D is off). A "to verify" list in the side panel is fine.
- Level of detail: below zoom 12, merge res-8 cells into res-7 districts with `h3.cellToParent(hex, 7)`; district priority = highest child priority, confidence = household-weighted mean, outline = `h3.cellsToMultiPolygon(children)`; a district pulses if it contains a pulsing child. Zoom ≥ 12 shows res-8 cells.
- One region full width by default, with a toggle for side-by-side (the opening "one engine, two disasters" moment). After showing a hidden map: `invalidateSize()`, `fitBounds(..., { animate: false })`, then `redraw()` the tile layers (otherwise labels double).
- Tooltip per cell: priority + verification, confidence %, households, likely severe, SMS replies/sent, claims, silence % and cause (`outage` → cell towers down, `away` → residents likely away at work, `trapped` → many vulnerable residents), and the engine's `reason` sentence.
- Toggle layer for schools / universities / hospitals (from the `facility` table once it exists; until then from `World.facilities` in `data/real/*/live.json`).
- Header label: "Synthetic exercise · real geography and census data · no real customer data".

## Demo flow to support (3 minutes)
1. Silent map → press Start: SMS replies and claims stream in, cells color and gain confidence.
2. Point at a pulsing cell: high hazard, towers down, zero replies → "suspected P0, needs verification".
3. A judge scans the QR code and replies HELP / 3 → their cell turns red on every screen.
4. The adjuster submits a field report → the cell and its neighbors update; verified coverage rises.
5. Close on metrics and the Spacetime real-time sync.

## Order of work
1. By 21:30: Vite app, bindings, connection, map with A + C from `hex_stats` on the dev database.
2. By 23:00: replay controls, adjuster form → map update (the main loop). Help Nate submit the Devpost draft.
3. Overnight: queues, live feed, metrics, SMS page + QR, level of detail, region switcher, schools layer.
4. Deploy the static build (Vercel or GitHub Pages) so phones can open it; 08:00 freeze; record a backup demo video.

When unsure about backend behavior, read `docs/SPACETIME_API.md` first, then ask Nate. Report progress after each step with what works and what does not.
