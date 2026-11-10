# Saviu

**HackUTD 2026 Zero Day** · Tracks: State Farm "The Worst Day, at Scale" + Spacetime "Build with Spacetime"

When a disaster hits, Saviu fuses three imperfect signals into a live P0–P2 map of which State Farm customers need help first and who we haven't heard from yet. Every field report makes the next decision more accurate.

## What is real and what is simulated
| Real public data | Simulated |
|---|---|
| Geography: H3 cells over real census blocks and tracts, coastline, terrain | Harbor Bend, TX: a fictional town and its storms |
| Census / ACS demographics, LODES commuting, CDC SVI | Every household and policyholder (sampled from those shares) |
| Schools, universities, hospitals, fire stations, shelters, masts | Coverage flags and phones on file |
| Hazard scenarios: USGS earthquake ShakeMaps, California liquefaction zones | Disaster events (the hurricanes are hypothetical; the earthquakes are planning scenarios, not real events), tower outages, SMS replies, claims, field reports, staff calls and visits, truth |

No real customer data is used. The model is calibrated on simulated events, so results show the pipeline is internally consistent, not that it is accurate in a real disaster.

Three worlds: Harbor Bend, TX (fictional), Corpus Christi, TX (hypothetical Cat 4 hurricane) and Alameda County, CA (USGS HayWired M7.05 scenario).

## Three signals
1. **Mapped impact zones**: hazard intensity plus human-annotated disaster areas.
2. **SMS check-ins**: simulated texts to existing policyholders at insured addresses ("Are you safe? How bad is the damage?").
3. **State Farm data**: policy locations, coverage, and claims compared to the expected volume.

The signals are fused per H3 hexagon into an **action priority** (P0 / P1 / P2) and a **verification status** (verified / needs verification). High-hazard areas with no replies are never treated as safe. Field adjusters' reports update the estimate locally right away, and adjust source trust gradually as reports accumulate. A rules-based "Next best" list suggests each adjuster's next task by cell priority, then value per minute from their location.

## How to run
Needs Node 22.18+ and the SpacetimeDB 2.x CLI.

```bash
spacetime start                # terminal 1: local server, keep running

cd spacetimedb                 # terminal 2
npm install
npm run publish:local:all      # one database per world: triage-loop, triage-loop-tx, triage-loop-ca
npm run seed:hb && npm run seed:tx && npm run seed:ca
```

Always pass `-s local` to the `spacetime` CLI (its default server is Maincloud), for example `spacetime call -s local triage-loop-ca start_replay 30`, and run it outside `spacetimedb/` for any database other than `triage-loop`.

- **Web client**: `cd client && npm install && npm run dev`, then open `#/` (manager), `#/adjuster` or `#/reply`. It defaults to the team's Maincloud databases; `client/README.md` explains the settings.
- **Passcodes** for staff and reply screens are set at seed time; see `docs/SPACETIME_API.md` section 3.
- **Free-text replies** need the Claude worker and your own Anthropic API key; see `docs/CLAUDE_PARSER.md`.

## Repository layout
| Path | Contents |
|---|---|
| `shared/types.ts` | Data contract shared by every module |
| `sim/` | Simulators: Harbor Bend, the real-geography worlds, random disasters |
| `engine/` | Fusion engine, backtest calibration, learning loop |
| `spacetimedb/` | Spacetime module (tables, reducers, simulated staff) and scripts, including the Claude reply-parser worker |
| `data/` | Generated event bundles and calibrated models ([`data/README.md`](data/README.md), [`data/real/README.md`](data/real/README.md)) |
| `docs/` | Requirements, data card, API reference, design notes |
| `client/` | Manager dashboard, adjuster phone view, policyholder reply page |

## Docs
- [Product requirements](docs/PRD.md)
- [Data card: real vs simulated, assumptions, limitations](docs/DATA.md)
- [SpacetimeDB API](docs/SPACETIME_API.md)
- [Claude reply parser](docs/CLAUDE_PARSER.md)
- [Project background](docs/BACKGROUND.md)
- [Two-person plan](docs/PLAN.md)
- [Sponsor research notes](docs/research/sponsor-research.md)

## Data licenses
OpenStreetMap-derived data in `data/real/` (hospitals, fire stations, shelters, masts, coastline) is © OpenStreetMap contributors and stays under the [Open Database License (ODbL) 1.0](https://www.openstreetmap.org/copyright); credit it wherever the map or data is shown. Other sources and their terms are listed in [`docs/DATA.md`](docs/DATA.md).
