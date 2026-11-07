// Write a small fixture data set under engine/fixtures/ (same layout as data/).
//   node scripts/fixture.ts [outDir] [--households=300] [--radius=3]

import { join } from 'node:path';
import { ENGINE_DIR, parseArgs, writeJson } from './io.ts';
import { fixtureSet } from './fixturegen.ts';

const args = parseArgs(process.argv.slice(2));
const outDir = args.positional[0] ?? join(ENGINE_DIR, 'fixtures');
const households = Number(args.flags.get('households') ?? 300);
const radius = Number(args.flags.get('radius') ?? 3);

const { backtests, live } = fixtureSet(households, radius);
for (const b of backtests) writeJson(join(outDir, 'backtest', `${b.world.eventId}.json`), b);
writeJson(join(outDir, 'live.json'), live);

for (const b of [...backtests, live]) {
  const sev = b.truth.filter((r) => r.damage >= 2).length;
  const help = b.truth.filter((r) => r.safety === 'needs_help').length;
  const kinds: Record<string, number> = {};
  for (const e of b.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  console.log(
    `${b.world.eventId}: ${b.world.hexes.length} cells, ${b.world.households.length} households, severe ${sev}, needs_help ${help}, events ${JSON.stringify(kinds)}`,
  );
}
console.log(`fixtures written to ${outDir}`);
