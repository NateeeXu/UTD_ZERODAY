# Triage Loop

**HackUTD 2026 Zero Day** · Tracks: State Farm "The Worst Day, at Scale" + Spacetime "Build with Spacetime"

When a disaster hits, Triage Loop fuses three imperfect signals into a live P0–P2 map of which State Farm customers need help first and who we haven't heard from yet. Every field report makes the next decision more accurate.

> All data in this project is synthetic. Harbor Bend, TX and the hurricane are fictional. No real customer data is used.

## Three signals
1. **Mapped impact zones**: hazard intensity plus human-annotated disaster areas.
2. **SMS check-ins**: simulated texts to existing policyholders at insured addresses ("Are you safe? How bad is the damage?").
3. **State Farm data**: policy locations, coverage, and claims compared to the expected volume.

The signals are fused per H3 hexagon into an **action priority** (P0 / P1 / P2) and a **verification status** (verified / needs verification). High-hazard areas with no replies are never treated as safe. Field adjusters' reports update the estimate locally right away, and adjust source trust gradually as reports accumulate.

## Repository layout
| Path | Owner | Contents |
|---|---|---|
| `shared/types.ts` | both | Data contract shared by every module |
| `sim/` | A | Synthetic data generator (live event + backtest events) |
| `engine/` | A | Fusion engine, backtest calibration, learning loop |
| `spacetimedb/` | A | Spacetime module: tables, reducers, real-time stats |
| `client/` | B | Manager dashboard, adjuster mobile view, policyholder SMS page |
| `docs/` | B | Background, plan, Devpost draft, pitch |

## Docs
- [Project background](docs/BACKGROUND.md)
- [Two-person plan](docs/PLAN.md)
- [Sponsor research notes](docs/research/sponsor-research.md)
