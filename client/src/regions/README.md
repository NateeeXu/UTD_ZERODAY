# regions/: irregular disaster boundaries on real coastlines

Frontend-only demo (open `#/regions`). Not wired into the dashboard or `shared/types.ts` yet.

## How a region is built (`buildRegion.ts`)
1. **Hazard field** (`scenarios.ts`, seeded, synthetic):
   - *San Francisco Peninsula:* an earthquake on a random stretch of the San Andreas trace. Shaking (MMI) falls off with distance from the rupture, plus a bay-margin amplification band and smooth random noise.
   - *Corpus Christi, TX:* a hurricane making landfall near Mustang Island. Winds have a Gaussian across-track profile, are stronger right of track and decay inland, plus two scales of smooth noise.
2. **Footprint** = contour of the field at the threshold (MMI 7.5 / 96 mph), traced with `d3-contour` on a 260-column grid.
3. **Region** = footprint ∩ land. Land pieces under 0.3 km² (spoil islands, piers) are dropped.
4. **Cells** (H3 res 8):
   - Hexes fully inside the region stay whole.
   - Hexes crossing the boundary are clipped to it (`polygon-clipping`). A hex that spans two land pieces keeps each part.
   - Clipped bits under 4% of a hex are merged into the neighbouring cell they touch, so the cells cover the region exactly with nothing unclickable. For the seeds we checked, the summed cell area equals the region area.

## Land data (`land/*.json`)
US Census Bureau cartographic boundary file `cb_2023_us_county_500k` (public domain), which is already clipped to the shoreline. Counties are dissolved into one land shape per region:

```bash
# from a folder holding the unzipped shapefile
npx mapshaper cb_2023_us_county_500k.shp \
  -filter 'STATEFP=="06" && ["075","081","085"].indexOf(COUNTYFP) > -1' \
  -clip bbox=-122.56,37.25,-121.95,37.84 -dissolve \
  -o sf-peninsula.json format=geojson precision=0.00001
npx mapshaper cb_2023_us_county_500k.shp -filter 'STATEFP=="48"' \
  -clip bbox=-97.85,27.30,-96.75,28.30 -dissolve \
  -o corpus-christi.json format=geojson precision=0.00001
```

- The Peninsula uses only San Francisco, San Mateo and Santa Clara counties, so the East Bay is never part of that scenario.
- At 1:500k scale the shoreline can be off from the basemap by up to roughly 100 m in places. More detail would need TIGER/Line `AREAWATER`.
