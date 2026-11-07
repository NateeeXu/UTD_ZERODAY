# client/: Triage Loop frontend (owner: B)

```bash
cd client
npm install
npm run dev        # also served on the LAN (--host), so phones on the same Wi-Fi can open it
```

| Route | Screen |
|---|---|
| `#/` | Manager dashboard: map with layer toggle, Next up, area detail, timeline, QR |
| `#/adjuster` | Adjuster phone view: task list (assigned areas first), household card, field-report form |
| `#/sms?h=live-h00042` | Policyholder SMS check-in (QR target). Without `?h=` it picks a random household |

Demo deep links (query string goes before the `#`):
- `?t=800` opens the replay at minute 800 (T+13h 20m).
- `?area=Seawall%20Point` opens that area's panel.
- e.g. `http://<laptop-ip>:5173/?t=800&area=Seawall%20Point#/`

## Data
- Loads `../data/live.json` (and `../data/model.json` once the engine writes it). Falls back to an in-browser mock (`src/data/mockBundle.ts`) only if `live.json` is missing. **Restart `npm run dev` after new data files land.**
- Replay runs 0–72 h (`T_END` in `src/state/TriageStore.tsx`), matching the simulator horizon.
- Basemap: Esri World Light Gray Canvas (no API key). Attribution is shown bottom-right.

## Areas
Hexes are grouped into named areas by their H3 resolution-7 parent (`src/areas.ts`, 57 areas for `live.json`). Names are made up and deterministic. Area priority = worst hex priority; an area is "unverified" when most households in its driving hexes are unverified.

## Placeholder engine
`src/engine/placeholderEstimate.ts` stands in for A's engine and emits `HexEstimate` plus UI-only extras (`HexView`):

| Extra field | Used for |
|---|---|
| `hazard` (0–1) | Hazard layer, Why-P0 hazard bar |
| `helpReplies` | Next up reasons, Why-P0 check-ins line |
| `expectedClaims`, `claimsGap` | Claims gap layer, "N filed vs M expected by now" |
| `replyRate` | Why-P0 check-ins bar |

**For A:** if the real engine / `hex_stats` can provide these (or equivalents), the UI can switch over without changes beyond the store.

## Local mode vs Spacetime
- Field reports, SMS replies and adjuster assignments are kept in the browser and synced between tabs of the same browser (BroadcastChannel + localStorage). Reset on the manager screen clears them.
- Phones on other devices do **not** sync in local mode. That comes with Spacetime (Maincloud).
- To switch: write a provider with the same `TriageState` shape backed by subscriptions (`hex`, `hex_stats`, `metrics`, event tables, `assignment`), call reducers in `inject` / `assign`, and swap it in `src/main.tsx`. Views only use `useTriage()`.
