// Copy the pure fusion engine (engine/src/*.ts) into the module (src/fusion/engine/).
// The module bundle must be self-contained, so we copy instead of importing across directories.
// The only rewrite: `../../shared/types.ts` -> `../contract.ts` (type-only re-export of the contract).
//
//   node scripts/sync-engine.ts        (then: npm run typecheck && npm run publish:local)
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = resolve(here, '../../engine/src');
const to = resolve(here, '../src/fusion/engine');

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
const files = readdirSync(from).filter(f => f.endsWith('.ts'));
for (const f of files) {
  const src = readFileSync(join(from, f), 'utf8');
  const out = src.replace(/(['"])\.\.\/\.\.\/shared\/types(\.ts)?\1/g, "'../contract.ts'");
  const header = `// COPIED from engine/src/${f} by spacetimedb/scripts/sync-engine.ts. Do not edit here; edit engine/src and re-sync.\n`;
  writeFileSync(join(to, f), header + out);
}
console.log(`copied ${files.length} files: ${files.join(', ')} -> ${to}`);
