// Eval for the Claude reply parser (docs/CLAUDE_PARSER.md, "Eval and pass criteria").
//
//   node --env-file=.env scripts/parser-eval.ts                 # adversarial (40) + 40 sampled real replies
//   ... --set adversarial|real|all   --limit N   --concurrency 4   --seed 7   --out results.json
//   ... --no-claude                  # offline baseline: fallback + keyword net only (no API calls)
//
// Sets: data/eval/sms_parse_adversarial.jsonl and free-text replies sampled (stratified, seeded) from
// data/real/ca-bay-area/live.json and data/real/tx-corpus-christi/live.json with their simulator labels
// (damage null = unknown). Simulator labels that contradict the spec are relabeled by rule and marked:
// an inspection request alone is 'safe' (prompt rule 2), not 'needs_help'.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disabledCreate, MODEL, parseReply, PROMPT_VERSION, type Need, type ParsedReply, type Safety } from './parser.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, '..', '..', 'data');

const argv = process.argv.slice(2);
const argOf = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const SET = argOf('--set') ?? 'all';
const LIMIT = Number(argOf('--limit') ?? 0);
const CONCURRENCY = Math.max(1, Number(argOf('--concurrency') ?? 4));
const SEED = Number(argOf('--seed') ?? 7);
const OUT = argOf('--out');
const NO_CLAUDE = argv.includes('--no-claude');
const REAL_PER_REGION = 20;

interface Expected {
  life_safety: boolean;
  safety: Safety;
  damage: number | null;
  needs: Need[];
  not_home: boolean;
  missing_people?: boolean; // adversarial set only
}
interface Case {
  id: string;
  set: 'adversarial' | 'real';
  language: string;
  text: string;
  expected: Expected;
  note?: string;
}
interface Result {
  c: Case;
  p: ParsedReply;
}

// ----- data -------------------------------------------------------------------

function adversarial(): Case[] {
  return readFileSync(join(DATA, 'eval', 'sms_parse_adversarial.jsonl'), 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l))
    .map(r => ({ id: r.id, set: 'adversarial' as const, language: r.language, text: r.text, expected: r.expected, note: r.why }));
}

/** FNV-1a, for a seeded, stable order. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface Reply {
  householdId: string;
  text: string;
  language: string;
  safety: 'safe' | 'needs_help';
  damage: number | null;
  lifeSafety: boolean;
  needs: Need[];
  notHome: boolean;
}

/** Pick n replies, round-robin over languages so non-English replies are represented. */
function pickDiverse(rows: Reply[], n: number, seen: Set<string>): Reply[] {
  const byLang = new Map<string, Reply[]>();
  for (const r of [...rows].sort((a, b) => hash(`${SEED}:${a.text}`) - hash(`${SEED}:${b.text}`))) {
    const k = r.text.trim().toLowerCase();
    if (seen.has(k)) continue;
    if (!byLang.has(r.language)) byLang.set(r.language, []);
    byLang.get(r.language)!.push(r);
  }
  const langs = [...byLang.keys()].sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a < b ? -1 : 1));
  const out: Reply[] = [];
  while (out.length < n && langs.some(l => byLang.get(l)!.length > 0)) {
    for (const l of langs) {
      const next = byLang.get(l)!.find(r => !seen.has(r.text.trim().toLowerCase()));
      if (!next || out.length >= n) continue;
      byLang.set(l, byLang.get(l)!.filter(r => r !== next));
      seen.add(next.text.trim().toLowerCase());
      out.push(next);
    }
  }
  return out;
}

function real(): Case[] {
  const seen = new Set<string>();
  const cases: Case[] = [];
  for (const region of ['ca-bay-area', 'tx-corpus-christi']) {
    const bundle = JSON.parse(readFileSync(join(DATA, 'real', region, 'live.json'), 'utf8'));
    const replies: Reply[] = bundle.events.filter((e: { kind: string; text?: string }) => e.kind === 'sms_reply' && e.text);
    // Strata: life safety, other needs-help, not home, safe at home.
    const ls = replies.filter(r => r.lifeSafety);
    const help = replies.filter(r => !r.lifeSafety && r.safety === 'needs_help');
    const away = replies.filter(r => r.safety === 'safe' && r.notHome);
    const home = replies.filter(r => r.safety === 'safe' && !r.notHome);
    const picked = [...pickDiverse(ls, 5, seen), ...pickDiverse(help, 5, seen), ...pickDiverse(away, 4, seen)];
    picked.push(...pickDiverse(home, REAL_PER_REGION - picked.length, seen));
    for (const r of picked) {
      const inspectionOnly = r.safety === 'needs_help' && !r.lifeSafety && r.needs.length > 0 && r.needs.every(n => n === 'inspection');
      cases.push({
        id: `${region === 'ca-bay-area' ? 'ca' : 'tx'}-${r.householdId.split('-').pop()}`,
        set: 'real',
        language: r.language,
        text: r.text,
        expected: {
          life_safety: r.lifeSafety,
          safety: inspectionOnly ? 'safe' : r.safety,
          damage: r.damage,
          needs: r.needs,
          not_home: r.notHome,
        },
        note: inspectionOnly ? 'relabeled: inspection request alone -> safe' : undefined,
      });
    }
  }
  return cases;
}

// ----- run ----------------------------------------------------------------------

async function runAll(cases: Case[]): Promise<Result[]> {
  const out: Result[] = new Array(cases.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < cases.length) {
      const i = next++;
      out[i] = { c: cases[i], p: await parseReply(cases[i].text, NO_CLAUDE ? { create: disabledCreate } : {}) };
      done++;
      if (done % 10 === 0 || done === cases.length) process.stderr.write(`  ${done}/${cases.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cases.length) }, worker));
  return out;
}

// ----- metrics ------------------------------------------------------------------

const pct = (a: number, b: number) => (b === 0 ? '  n/a' : `${((100 * a) / b).toFixed(1).padStart(5)}%`);
const frac = (a: number, b: number) => `${a}/${b}`.padStart(7);

function metrics(rs: Result[]) {
  const m = {
    n: rs.length,
    valid: rs.filter(r => r.p.error === null).length,
    lsPos: 0,
    lsTp: 0,
    lsFp: 0,
    notSafe: 0,
    falseSafe: 0,
    safetyExact: 0,
    dmgKnown: 0,
    dmgExact: 0,
    dmgWithin1: 0,
    dmgNull: 0,
    dmgNullOk: 0,
    needTp: 0,
    needFp: 0,
    needFn: 0,
    notHomeOk: 0,
    missPos: 0,
    missTp: 0,
    netHits: rs.filter(r => r.p.keyword_hits.length > 0).length,
    netEscalations: rs.filter(r => r.p.review.some(x => x.startsWith('keyword_net'))).length,
    latencies: rs.map(r => r.p.latency_ms).sort((a, b) => a - b),
    errors: new Map<string, number>(),
  };
  for (const { c, p } of rs) {
    const e = c.expected;
    if (e.life_safety) {
      m.lsPos++;
      if (p.life_safety) m.lsTp++;
    } else if (p.life_safety) m.lsFp++;
    if (e.safety !== 'safe') {
      m.notSafe++;
      if (p.safety === 'safe') m.falseSafe++;
    }
    if (p.safety === e.safety) m.safetyExact++;
    if (e.damage !== null) {
      m.dmgKnown++;
      if (p.damage === e.damage) m.dmgExact++;
      if (p.damage !== null && Math.abs(p.damage - e.damage) <= 1) m.dmgWithin1++;
    } else {
      m.dmgNull++;
      if (p.damage === null) m.dmgNullOk++;
    }
    for (const n of p.needs) (e.needs.includes(n) ? m.needTp++ : m.needFp++);
    for (const n of e.needs) if (!p.needs.includes(n)) m.needFn++;
    if (p.not_home === e.not_home) m.notHomeOk++;
    if (e.missing_people) {
      m.missPos++;
      if (p.missing_people) m.missTp++;
    }
    if (p.error) {
      const k = p.error.split(':')[0];
      m.errors.set(k, (m.errors.get(k) ?? 0) + 1);
    }
  }
  return m;
}

function report(label: string, rs: Result[], strict: boolean): boolean {
  const m = metrics(rs);
  const f1Den = 2 * m.needTp + m.needFp + m.needFn;
  const f1 = f1Den === 0 ? 1 : (2 * m.needTp) / f1Den;
  const q = (p: number) => m.latencies[Math.min(m.latencies.length - 1, Math.floor(p * m.latencies.length))] ?? 0;
  const mean = m.latencies.reduce((s, x) => s + x, 0) / Math.max(1, m.latencies.length);
  const lsRecall = m.lsPos === 0 ? 1 : m.lsTp / m.lsPos;
  const fsRate = m.notSafe === 0 ? 0 : m.falseSafe / m.notSafe;
  const checks: [string, boolean][] = [
    ['life-safety recall = 100%', lsRecall === 1],
    ['false-safe <= 2%', fsRate <= 0.02],
    ['damage exact >= 70%', m.dmgKnown === 0 || m.dmgExact / m.dmgKnown >= 0.7],
    ['damage within 1 >= 95%', m.dmgKnown === 0 || m.dmgWithin1 / m.dmgKnown >= 0.95],
    ['damage null >= 90%', m.dmgNull === 0 || m.dmgNullOk / m.dmgNull >= 0.9],
    ['valid JSON = 100%', m.valid === m.n],
  ];
  console.log(`\n== ${label} (n=${m.n}) ==`);
  console.log(`  life-safety recall     ${frac(m.lsTp, m.lsPos)}  ${pct(m.lsTp, m.lsPos)}   (extra referrals: ${m.lsFp})`);
  console.log(`  false-safe rate        ${frac(m.falseSafe, m.notSafe)}  ${pct(m.falseSafe, m.notSafe)}   (said safe, expected needs_help/unsure)`);
  console.log(`  safety exact           ${frac(m.safetyExact, m.n)}  ${pct(m.safetyExact, m.n)}`);
  console.log(`  damage exact           ${frac(m.dmgExact, m.dmgKnown)}  ${pct(m.dmgExact, m.dmgKnown)}`);
  console.log(`  damage within 1        ${frac(m.dmgWithin1, m.dmgKnown)}  ${pct(m.dmgWithin1, m.dmgKnown)}`);
  console.log(`  damage null correct    ${frac(m.dmgNullOk, m.dmgNull)}  ${pct(m.dmgNullOk, m.dmgNull)}`);
  console.log(`  needs F1 (micro)       ${f1.toFixed(3).padStart(7)}   (tp ${m.needTp}, fp ${m.needFp}, fn ${m.needFn})`);
  console.log(`  not_home correct       ${frac(m.notHomeOk, m.n)}  ${pct(m.notHomeOk, m.n)}`);
  if (m.missPos > 0) console.log(`  missing_people recall  ${frac(m.missTp, m.missPos)}  ${pct(m.missTp, m.missPos)}`);
  console.log(`  valid JSON             ${frac(m.valid, m.n)}  ${pct(m.valid, m.n)}${m.errors.size ? `   errors: ${[...m.errors].map(([k, v]) => `${k} x${v}`).join(', ')}` : ''}`);
  console.log(`  keyword net            hits ${m.netHits}, escalations over Claude/fallback ${m.netEscalations}`);
  console.log(`  latency                mean ${mean.toFixed(0)} ms, p50 ${q(0.5)} ms, p95 ${q(0.95)} ms`);
  if (strict) for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  return lsRecall === 1;
}

function failures(rs: Result[]) {
  console.log('\n== per-case failures ==');
  let n = 0;
  for (const { c, p } of rs) {
    const e = c.expected;
    const diffs: string[] = [];
    if (e.life_safety !== p.life_safety) diffs.push(`${e.life_safety ? 'MISSED LIFE SAFETY' : 'extra life_safety'}`);
    if (e.safety !== p.safety) diffs.push(`safety ${e.safety}->${p.safety}`);
    if (e.damage !== p.damage) diffs.push(`damage ${e.damage ?? 'null'}->${p.damage ?? 'null'}`);
    const en = [...e.needs].sort().join('+');
    const pn = [...p.needs].sort().join('+');
    if (en !== pn) diffs.push(`needs [${en}]->[${pn}]`);
    if (e.not_home !== p.not_home) diffs.push(`not_home ${e.not_home}->${p.not_home}`);
    if (e.missing_people !== undefined && e.missing_people !== p.missing_people) diffs.push(`missing ${e.missing_people}->${p.missing_people}`);
    if (diffs.length === 0) continue;
    n++;
    const extra = [p.error ? `error ${p.error}` : '', p.keyword_hits.length ? `net ${p.keyword_hits.join('+')}` : '', c.note && c.set === 'real' ? c.note : '']
      .filter(Boolean)
      .join('; ');
    console.log(`  ${c.id} [${c.language}] ${JSON.stringify(c.text)}\n      ${diffs.join('; ')}${extra ? `   (${extra})` : ''}`);
  }
  if (n === 0) console.log('  none');
}

async function main() {
  if (!NO_CLAUDE && !process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set (spacetimedb/.env, gitignored). Run with --no-claude for the offline keyword-net baseline.');
    process.exit(2);
  }
  let cases: Case[] = [];
  if (SET === 'adversarial' || SET === 'all') cases.push(...adversarial());
  if (SET === 'real' || SET === 'all') cases.push(...real());
  if (LIMIT > 0) cases = cases.slice(0, LIMIT);
  const relabeled = cases.filter(c => c.note?.startsWith('relabeled')).length;
  console.log(
    `parser eval: model ${NO_CLAUDE ? 'none (--no-claude: fallback + keyword net only)' : MODEL}, prompt ${PROMPT_VERSION}, ` +
      `${cases.length} cases (seed ${SEED}, concurrency ${CONCURRENCY})${relabeled ? `, ${relabeled} real labels relabeled` : ''}`
  );
  const results = await runAll(cases);
  const adv = results.filter(r => r.c.set === 'adversarial');
  const rl = results.filter(r => r.c.set === 'real');
  let ok = true;
  if (adv.length) ok = report('adversarial', adv, true) && ok;
  if (rl.length) ok = report('real (sampled)', rl, true) && ok;
  if (adv.length && rl.length) report('all', results, false);
  failures(results);
  if (OUT) {
    writeFileSync(
      OUT,
      JSON.stringify(
        { model: NO_CLAUDE ? null : MODEL, promptVersion: PROMPT_VERSION, seed: SEED, results: results.map(r => ({ ...r.c, got: r.p })) },
        null,
        1
      )
    );
    console.log(`\nwrote ${OUT}`);
  }
  process.exit(ok ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(2);
});
