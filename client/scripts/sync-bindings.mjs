#!/usr/bin/env node
// Re-sync table row definitions in src/module_bindings with the *deployed* databases.
//
// Why: when a Maincloud database is republished with new columns before regenerated
// bindings are pushed, the client can no longer decode those tables (blank map). This
// reads each database's live schema (public HTTP endpoint) and rewrites the
// `export default __t.row({...})` block of every existing *_table.ts that differs.
// It never touches reducers or index.ts; new tables are only reported.
//
// Usage: npm run sync-bindings [-- db1 db2 ...]
// Prefer `cp -R ../spacetimedb/bindings src/module_bindings` when the backend has pushed them.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env.VITE_SPACETIME_HOST ?? 'https://maincloud.spacetimedb.com';
const DBS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['triage-loop-nateeexu-tx', 'triage-loop-nateeexu-ca', 'triage-loop-nateeexu-dev'];
const DIR = join(dirname(fileURLToPath(import.meta.url)), '../src/module_bindings');
const NOTE =
  '// NOTE (frontend): row definition synced from the live schema by scripts/sync-bindings.mjs\n' +
  '// because the database was republished before regenerated bindings were pushed.\n';

const camel = (s) => s.split('_').map((p, i) => (i ? p.charAt(0).toUpperCase() + p.slice(1) : p)).join('');
const SIMPLE = { String: 'string', Bool: 'bool', U8: 'u8', U16: 'u16', U32: 'u32', U64: 'u64', I8: 'i8', I16: 'i16', I32: 'i32', I64: 'i64', F32: 'f32', F64: 'f64' };

function builder(t) {
  const [k, v] = Object.entries(t)[0];
  if (SIMPLE[k]) return `__t.${SIMPLE[k]}()`;
  if (k === 'Product') {
    const names = v.elements.map((e) => e.name?.some);
    if (names.join() === '__timestamp_micros_since_unix_epoch__') return '__t.timestamp()';
    if (names.join() === '__identity__') return '__t.identity()';
    if (names.join() === '__connection_id__') return '__t.connectionId()';
    if (names.join() === '__time_duration_micros__') return '__t.timeDuration()';
  }
  if (k === 'Sum') {
    const vs = v.variants.map((x) => x.name?.some);
    if (vs.join() === 'some,none') return `__t.option(${builder(v.variants[0].algebraic_type)})`;
  }
  throw new Error(`unsupported column type ${JSON.stringify(t).slice(0, 120)}`);
}

function rowBlock(schema, table) {
  const els = schema.typespace.types[table.product_type_ref].Product.elements;
  const pk = new Set(table.primary_key ?? []);
  const lines = els.map((e, i) => {
    const n = e.name.some;
    const c = camel(n);
    let b = builder(e.algebraic_type);
    if (pk.has(i)) b += '.primaryKey()';
    if (c !== n) b += `.name("${n}")`;
    return `  ${c}: ${b},`;
  });
  return { cols: els.map((e) => camel(e.name.some)), text: `export default __t.row({\n${lines.join('\n')}\n});\n` };
}

const schemas = [];
for (const db of DBS) {
  const res = await fetch(`${HOST}/v1/database/${db}/schema?version=9`);
  if (!res.ok) { console.warn(`! ${db}: HTTP ${res.status}, skipped`); continue; }
  schemas.push({ db, schema: await res.json() });
}
if (!schemas.length) process.exit(1);

const base = schemas[0];
let changed = 0;
for (const table of base.schema.tables) {
  if (table.table_access?.Public === undefined) continue;
  const file = join(DIR, `${table.name}_table.ts`);
  const { cols, text } = rowBlock(base.schema, table);
  for (const other of schemas.slice(1)) {
    const t2 = other.schema.tables.find((t) => t.name === table.name);
    if (!t2 || rowBlock(other.schema, t2).text !== text) console.warn(`! ${table.name}: ${other.db} differs from ${base.db}`);
  }
  if (!existsSync(file)) { console.log(`  ${table.name}: new table, no binding file (not used by the client)`); continue; }
  const src = readFileSync(file, 'utf8');
  const at = src.indexOf('export default __t.row({');
  if (at < 0) continue;
  const have = [...src.slice(at).matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
  if (have.join() === cols.join() && src.slice(at) === text) continue;
  let head = src.slice(0, at);
  if (!head.includes('NOTE (frontend)')) head = head.replace('/* eslint-disable */', `${NOTE}\n/* eslint-disable */`);
  writeFileSync(file, head + text);
  const added = cols.filter((c) => !have.includes(c));
  const removed = have.filter((c) => !cols.includes(c));
  console.log(`✓ ${table.name}: ${added.length ? `+${added.join(', +')}` : ''}${removed.length ? ` -${removed.join(', -')}` : ''}${!added.length && !removed.length ? 'types/order updated' : ''}`);
  changed++;
}
console.log(changed ? `${changed} binding file(s) updated from ${base.db}. Run npm run typecheck.` : 'Bindings already match the live schema.');
