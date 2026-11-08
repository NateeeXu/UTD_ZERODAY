# client/: Triage Loop frontend

```bash
cd client
npm install
npm run dev        # also served on the LAN (--host), so phones on the same Wi-Fi can open it
```

## Screens (live, SpacetimeDB)
| Route | Screen |
|---|---|
| `#/` | Manager dashboard: map (approved style A + C), metrics strip, action / verification queues, live feed, replay controls, judge QR |
| `#/adjuster` | Adjuster phone: join, assigned homes (+ engine's top unassigned candidates), two-part field report |
| `#/reply?h=<householdId>&code=<reply passcode>` | Policyholder SMS page (QR target, no login) |

- **Joining:** managers and adjusters join with the staff passcode, typed in the join dialog. It is never stored or bundled; the connection token (one per screen and database, in `localStorage`) keeps the role across reloads.
- **QR code:** the manager types the reply passcode once into the QR card. It may travel in the QR link, because it only allows SMS replies.
- **Energy:** always **Pause** the replay when you're not demoing; a running replay uses Maincloud energy.

## Configuration (`.env.local`, never commit secrets)
Defaults already point at the team's Maincloud databases; override only if they move:
```
VITE_SPACETIME_HOST=https://maincloud.spacetimedb.com
VITE_SPACETIME_DB_TX=triage-loop-nateeexu-tx    # Corpus Christi, hurricane (20k households)
VITE_SPACETIME_DB_CA=triage-loop-nateeexu-ca    # Bay Area / Alameda County, Hayward Fault quake (30k households)
VITE_SPACETIME_DB=triage-loop-nateeexu-dev      # Harbor Bend, dev testing
```
- `?region=tx|ca|harbor` in the URL (before the `#`) picks a region; the choice is remembered. The phone screens use the same region.
- No Spacetime account is needed: the client connects with its own anonymous identity, reads public tables, and writes through reducers after `join_as` with the passcode.
- Setting a region's env var to an empty string falls back to the read-only preview snapshot (`docs/preview/preview-data.js`).
- **Subscriptions stay small on purpose.** The full `household` table is 20–30k rows and takes about 25 s to load. Screens subscribe to:
  - `household_estimate WHERE p_needs_help > 0.1`;
  - the households currently on screen, by id;
  - one cell for the QR target.

  See `src/live/hooks.ts`.

## Bindings (`src/module_bindings/`)
- Copied from `spacetimedb/bindings/`.
- The dev database already runs the v2 schema, so seven files were hand-synced to it: `hex`, `hex_stats`, `household`, `world` and `replay_state` changed, `sms_reply` gained `text`/`language`, and `facility` and `inspection_candidate` are new. The source was the live schema (`GET https://maincloud.spacetimedb.com/v1/database/<db>/schema?version=9`).
- **Replace the folder** with `spacetime generate --lang typescript --out-dir client/src/module_bindings --module-path spacetimedb` once the v2 module is pushed.
- Use `src/live/rows.ts` for row types: `module_bindings/types.ts` still has v1 shapes for the changed tables.

## Code map
- `src/live/`: live screens (`ManagerLive`, `AdjusterLive`, `ReplyLive`), `LiveMap` + `mapModel` (port of `docs/preview/map-preview.html`), `config` (hosts, regions, token keys), `labels` (district names).
- `src/views/`, `src/state/`, `src/engine/`: the older local-mode prototype (browser-only replay of `data/live.json`), at `#/local`, `#/local/adjuster` and `#/local/sms`.
- `src/regions/` (`#/regions`) and `#/lab`: design explorations, not used by the live screens.
