// Offline tests for scripts/parser.ts with a stubbed Anthropic call (no API key, no network):
// keyword net, schema validation, fallback paths (timeout, API error, refusal, bad JSON) and the
// reducer mapping.
//
//   node scripts/parser-test.ts
import Anthropic from '@anthropic-ai/sdk';
import { DAMAGE_UNKNOWN, keywordNet, parseReply, toReducerArgs, type ClaudeFields, type CreateFn } from './parser.ts';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const base: ClaudeFields = {
  life_safety: false,
  safety: 'safe',
  damage: 1,
  needs: [],
  not_home: false,
  missing_people: false,
  language: 'en',
  evidence: { life_safety: [], safety: ['we are ok'], damage: ['fence down'], needs: [] },
  confidence: 0.9,
};

/** A stub that answers with this text block (and stop reason). */
const answer =
  (text: string, stop: Anthropic.Beta.Messages.BetaStopReason = 'end_turn', category: string | null = null): CreateFn =>
  async () =>
    ({
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text, citations: null }],
      stop_reason: stop,
      stop_details: stop === 'refusal' ? { type: 'refusal', category, explanation: null } : null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }) as unknown as Anthropic.Beta.Messages.BetaMessage;
const json = (over: Partial<ClaudeFields>) => answer(JSON.stringify({ ...base, ...over }));

async function main() {
  // ----- keyword net ------------------------------------------------------------
  const danger: [string, string][] = [
    ["we're fine but grandma can't breathe", 'cant_breathe'],
    ['power out 6 hrs, my CPAP battery is almost dead', 'medical_device'],
    ['cant find my brother, he was home when it hit', 'missing'],
    ['🆘🆘', 'sos_emoji'],
    ['estamos bien pero huele a gas en la cocina', 'gas_es'],
    ['manden a alguien por favor', 'manden'],
    ['mi mamá usa oxígeno y no hay luz desde anoche', 'aparato_medico'],
    ['救命！房子塌了，爸爸被压住了', 'jiuming'],
    ['家里没人受伤，但是我女儿联系不上', 'shilian'],
    ['cứu với, nước dâng vào nhà', 'cuu'],
    ['amoy gas dito, tulong', 'tulong'],
    ['갇혔어요 도와주세요', 'dowa'],
    ['아버지 투석 받아야 하는데 차가 없어요', 'uiryo_gigi'],
    ['we are safe. my neighbor is trapped next door, please send help', 'trapped'],
    ['we have no power and smell gas', 'gas'],
    ['nobody hurt, need help', 'help'],
    ['HELP', 'help'],
  ];
  for (const [text, id] of danger) {
    const hits = keywordNet(text);
    check(`net hits ${id}: ${text}`, hits.includes(id), hits.join('+') || 'no hits');
  }
  const calm = [
    'no one is hurt, roof is mostly gone and water is coming in',
    'all good here, we can help the neighbors if anyone needs it',
    "we don't need help, thanks",
    'todo bien, nadie herido, solo se cayeron unos platos',
    'no necesitamos ayuda, gracias',
    'no gas smell, no fire, all ok',
    'need a place to stay tonight, cant stay in the house, nobody hurt',
    'nhà bị nứt lớn, cửa không đóng được, mọi người ổn',
    'ayos lang kami, walang sira',
    '저희는 괜찮아요, 담장만 넘어졌어요',
    '我们没事，就是窗户碎了',
    'running low on my blood pressure meds, otherwise fine, no damage',
    'car is out of gas but we are ok',
  ];
  for (const text of calm) {
    const hits = keywordNet(text);
    check(`net quiet: ${text}`, hits.length === 0, hits.join('+'));
  }

  // ----- Claude answer used as is ---------------------------------------------------
  let p = await parseReply('house ok just the fence down, everyone fine', { create: json({}) });
  check('valid answer is used', p.error === null && p.safety === 'safe' && p.damage === 1 && !p.escalated, JSON.stringify({ e: p.error, s: p.safety }));

  // ----- escalate only ---------------------------------------------------------------
  p = await parseReply('we are fine but grandma cant breathe', { create: json({ life_safety: false, safety: 'safe' }) });
  check('net escalates a missed danger', p.life_safety && p.safety === 'needs_help' && p.escalated && p.review.some(r => r.startsWith('keyword_net')));
  p = await parseReply('the stairs are blocked and the baby is crying', { create: json({ life_safety: true, safety: 'needs_help', damage: 2 }) });
  check('net never downgrades Claude', p.life_safety && p.safety === 'needs_help' && !p.escalated && p.keyword_hits.length === 0);
  p = await parseReply('my son has not come home', { create: json({ missing_people: true, life_safety: false, safety: 'unsure', damage: null }) });
  check('missing person implies life safety', p.life_safety && p.safety === 'needs_help' && p.escalated);
  p = await parseReply('ok', { create: json({ confidence: 0.4 }) });
  check('low confidence flagged for review', p.review.includes('low_confidence'));

  // ----- fallbacks ---------------------------------------------------------------------
  const isFallback = (x: typeof p) => x.safety === 'unsure' && !x.life_safety && x.damage === null && x.error !== null;
  p = await parseReply('we are ok', { create: () => new Promise(() => {}), timeoutMs: 200 });
  check('timeout -> unsure fallback', isFallback(p) && p.error === 'timeout' && p.latency_ms < 1000, `${p.error} ${p.latency_ms}ms`);
  p = await parseReply('we are ok', { create: answer('not json') });
  check('invalid JSON -> fallback', isFallback(p) && p.error === 'invalid_json', p.error ?? '');
  p = await parseReply('we are ok', { create: json({ damage: 7 as never }) });
  check('damage 7 -> schema fallback', isFallback(p) && p.error === 'schema: damage', p.error ?? '');
  p = await parseReply('we are ok', { create: json({ confidence: 1.5 }) });
  check('confidence 1.5 -> schema fallback', isFallback(p) && p.error === 'schema: confidence', p.error ?? '');
  p = await parseReply('we are ok', { create: answer(JSON.stringify({ ...base, extra: 1 })) });
  check('unexpected key -> schema fallback', isFallback(p) && p.error?.startsWith('schema: unexpected key') === true, p.error ?? '');
  p = await parseReply('we are ok', { create: json({ needs: ['pizza' as never] }) });
  check('unknown need -> schema fallback', isFallback(p) && p.error === 'schema: needs', p.error ?? '');
  p = await parseReply('we are ok', { create: answer('{}', 'refusal', 'general_harms') });
  check('refusal -> fallback', isFallback(p) && p.error === 'refusal: general_harms', p.error ?? '');
  p = await parseReply('we are ok', { create: answer('{"life_safety": tr', 'max_tokens') });
  check('max_tokens -> fallback', isFallback(p) && p.error === 'max_tokens', p.error ?? '');
  p = await parseReply('we are ok', {
    create: async () => {
      throw new Anthropic.APIConnectionError({ message: 'socket hang up' });
    },
  });
  check('network error -> fallback', isFallback(p) && p.error === 'network', p.error ?? '');
  p = await parseReply('help, trapped in the attic', { create: () => new Promise(() => {}), timeoutMs: 100 });
  check('fallback still escalates danger words', p.error === 'timeout' && p.life_safety && p.safety === 'needs_help' && p.damage === null);
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  p = await parseReply('we are ok');
  check('no ANTHROPIC_API_KEY -> fallback, no call', isFallback(p) && p.error === 'no_api_key', p.error ?? '');
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;

  // ----- mapping ------------------------------------------------------------------------
  p = await parseReply('we are ok', { create: answer('nope') });
  let a = toReducerArgs(p, 'we are ok', 'es');
  check('unsure -> needs_help, lifeSafety false, damage 255', a.safety === 'needs_help' && !a.lifeSafety && a.damage === DAMAGE_UNKNOWN && a.language === 'es');
  p = await parseReply('x', { create: json({ needs: ['shelter', 'transport'], damage: 3, not_home: true, missing_people: true, language: 'tl' }) });
  a = toReducerArgs(p, 'x');
  check(
    'needs joined, damage kept, missing -> report_member_missing',
    a.needs === 'shelter,transport' && a.damage === 3 && a.notHome && a.reportMissing && a.lifeSafety && a.language === 'tl',
    JSON.stringify(a)
  );
  p = await parseReply('ok', { create: json({ damage: null, safety: 'safe' }) });
  a = toReducerArgs(p, 'ok');
  check('safe + damage null -> safe, 255', a.safety === 'safe' && a.damage === DAMAGE_UNKNOWN && !a.lifeSafety && a.needs === '');

  console.log(failures === 0 ? '\nall parser checks passed' : `\n${failures} parser check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
