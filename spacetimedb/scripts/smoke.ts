// End-to-end smoke test against a seeded database (run scripts/seed.ts first).
//
//   node scripts/smoke.ts [--hex 8848906cadfffff] [--keep]
//
// 1. owner resets the demo
// 2. three anonymous identities: manager, adjuster, outsider (fresh identities minted by the server)
// 3. outsider field report -> rejected; wrong reply passcode -> rejected
// 4. manager starts the replay at high speed, then jumps to t = 24 h
// 5. manager assigns a household in a silent cell; adjuster reports it -> cell updates
// 6. prints hex_stats / household_estimate / metrics before and after
// 7. a not-assessed report (damage 255) needs a note, accounts the people and leaves the property unverified;
//    memberMissing on a field report opens a referral; unreachable_after_visit needs an 'unsure' visit and a note,
//    and closing marks open assignments done (reopening does not)
// 8. raw reply inbox: submit_raw_reply (reply passcode, 1..500 chars) and mark_reply_parsed (manager)
// 9. Accepting a task posts an in-app notice and queues an iMessage; chat permissions; mark_imessage
// 10. Next best: location validation, list caps and order, accept_recommendation, field report moving a demo location
// --keep leaves the replay state as is at the end (default: pause).
import { connect, errText, ownerToken, REPLY_PASSCODE, sleep, STAFF_PASSCODE, subscribe } from './lib.ts';

const args = process.argv.slice(2);
const hexArg = args.includes('--hex') ? args[args.indexOf('--hex') + 1] : undefined;

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function expectReject(label: string, p: Promise<unknown>) {
  try {
    await p;
    check(label, false, 'reducer succeeded but should have been rejected');
  } catch (e) {
    check(label, true, `rejected: ${errText(e)}`);
  }
}

const pick = <T extends object>(row: T | undefined, keys: (keyof T)[]) =>
  row ? Object.fromEntries(keys.map(k => [k, typeof row[k] === 'number' ? +(row[k] as number).toFixed(3) : row[k]])) : row;

async function main() {
  const owner = await connect(ownerToken());
  const manager = await connect();
  const adjuster = await connect();
  const outsider = await connect();
  console.log('identities:', {
    owner: owner.identity.toHexString().slice(0, 16),
    manager: manager.identity.toHexString().slice(0, 16),
    adjuster: adjuster.identity.toHexString().slice(0, 16),
    outsider: outsider.identity.toHexString().slice(0, 16),
  });

  // Exact counter checks below: simulated staff (which files its own reports) stays off during the smoke test.
  await owner.conn.reducers.setStaffSim({ enabled: false, callsPerHour: 0, visitsPerHour: 0, inspectionsPerHour: 0 });
  await owner.conn.reducers.resetDemo({});
  check('owner reset_demo', true);

  await expectReject(
    'join_as manager with wrong passcode',
    outsider.conn.reducers.joinAs({ role: 'manager', name: 'Mallory', passcode: 'nope' })
  );
  await manager.conn.reducers.joinAs({ role: 'manager', name: 'Smoke Manager', passcode: STAFF_PASSCODE });
  await adjuster.conn.reducers.joinAs({ role: 'adjuster', name: 'Smoke Adjuster', passcode: STAFF_PASSCODE });
  check('manager + adjuster joined', true);

  await expectReject(
    'outsider (no role) start_replay',
    outsider.conn.reducers.startReplay({ speed: 60 })
  );

  // Watch everything we print from the manager's connection.
  await subscribe(manager.conn, [
    'SELECT * FROM metrics',
    'SELECT * FROM replay_state',
    'SELECT * FROM hex_stats',
    'SELECT * FROM household_estimate',
    'SELECT * FROM household',
    'SELECT * FROM assignment',
    'SELECT * FROM member',
    'SELECT * FROM field_report',
    'SELECT * FROM household_followup',
    'SELECT * FROM reply_inbox',
  ]);
  const db = manager.conn.db;
  const metrics = () => [...db.metrics.iter()][0];
  const replay = () => [...db.replayState.iter()][0];
  const stats = (hex: string) => [...db.hexStats.iter()].find(s => s.hex === hex);
  const est = (id: string) => [...db.householdEstimate.iter()].find(e => e.householdId === id);

  const m0 = metrics();
  console.log('t=0 metrics:', pick(m0, ['p0Cells', 'p1Cells', 'p2Cells', 'needsVerificationCells', 'smsSent', 'engine']));

  // Replay at 12 sim-hours per second for ~3 s, then jump to 24 h.
  await manager.conn.reducers.startReplay({ speed: 720 });
  await sleep(3200);
  const r1 = replay();
  const m1 = metrics();
  check('replay advances while running', !!r1 && r1.simMinutes > 0 && r1.nextSeq > 0, `t=${r1?.simMinutes.toFixed(0)} min, released ${r1?.nextSeq}/${r1?.totalStaged}`);
  check('hex_stats / metrics counters grow', !!m1 && m1.smsSent > 0, `smsSent ${m1?.smsSent}, replies ${m1?.smsReplies}, claims ${m1?.claims}`);
  await manager.conn.reducers.pauseReplay({});
  await manager.conn.reducers.jumpTo({ minutes: 1440 });
  await sleep(300);
  const m2 = metrics();
  console.log(
    't=24h metrics:',
    pick(m2, ['smsSent', 'smsReplies', 'helpReplies', 'claims', 'p0Cells', 'p1Cells', 'p2Cells', 'needsVerificationCells', 'holdoutN', 'holdoutBrierSevere', 'holdoutBrierHelp', 'holdoutSevereRecall'])
  );

  // Target: a silent P0 cell (default: the README's silent-severe cell, else the top P0 cell).
  const all = [...db.hexStats.iter()];
  const target =
    (hexArg && stats(hexArg)) ||
    stats('8848906cadfffff') ||
    all.filter(s => s.priority === 'P0').sort((a, b) => b.silence - a.silence)[0];
  if (!target) throw new Error('no target cell');
  const hh = [...db.household.iter()].filter(h => h.hex === target.hex && !h.holdout).sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  if (!hh) throw new Error(`no non-holdout household in ${target.hex}`);
  const cols: (keyof typeof target)[] = ['priority', 'verification', 'households', 'smsSent', 'smsReplies', 'replyRate', 'fieldReports', 'verifiedHouseholds', 'severity', 'confidence', 'silence', 'expectedSevere', 'maxPNeedsHelp', 'reason'];
  console.log(`\ntarget cell ${target.hex}, household ${hh.id}`);
  console.log('  before:', pick(stats(target.hex), cols));
  console.log('  household before:', pick(est(hh.id), ['pSevere', 'pNeedsHelp', 'uncertainty', 'verified', 'inspectScore']));

  await expectReject(
    'outsider field report',
    outsider.conn.reducers.submitFieldReport({ householdId: hh.id, safety: 'needs_help', damage: 3, note: 'should fail', memberMissing: false })
  );
  await expectReject(
    'manager field report (not an adjuster)',
    manager.conn.reducers.submitFieldReport({ householdId: hh.id, safety: 'safe', damage: 0, note: 'should fail', memberMissing: false })
  );
  await expectReject(
    'adjuster field report with damage 7',
    adjuster.conn.reducers.submitFieldReport({ householdId: hh.id, safety: 'safe', damage: 7, note: '', memberMissing: false })
  );
  await expectReject(
    'sms reply with wrong passcode',
    outsider.conn.reducers.submitSmsReply({ householdId: hh.id, safety: 'safe', damage: 0, passcode: 'nope' })
  );

  await manager.conn.reducers.assign({ householdId: hh.id, adjusterIdentityHex: adjuster.identity.toHexString() });
  await sleep(200);
  const a0 = [...db.assignment.iter()].find(a => a.householdId === hh.id);
  check('manager assign', a0?.status === 'assigned');

  // Per-user views from the adjuster's phone: only its own member row and assignments.
  await subscribe(adjuster.conn, ['SELECT * FROM my_member', 'SELECT * FROM my_assignments']);
  const myMember = [...adjuster.conn.db.myMember.iter()];
  const myAssignments = [...adjuster.conn.db.myAssignments.iter()];
  check(
    'views my_member / my_assignments',
    myMember.length === 1 && myMember[0].role === 'adjuster' && myAssignments.some(a => a.householdId === hh.id),
    `my_member=${myMember.map(m => `${m.name}/${m.role}`).join(',')}, my_assignments=${myAssignments.length}`
  );

  const fr0 = metrics()?.fieldReports ?? 0;
  await adjuster.conn.reducers.submitFieldReport({
    householdId: hh.id,
    safety: 'needs_help',
    damage: 3,
    note: 'smoke test: roof gone, elderly resident needs evacuation',
    memberMissing: false,
  });
  await sleep(300);
  const after = stats(target.hex);
  console.log('  after: ', pick(after, cols));
  console.log('  household after: ', pick(est(hh.id), ['pSevere', 'pNeedsHelp', 'uncertainty', 'verified', 'inspectScore']));
  check('adjuster field report accepted', (metrics()?.fieldReports ?? 0) === fr0 + 1);
  check('cell counters updated', after?.fieldReports === (target.fieldReports ?? 0) + 1 && after?.verifiedHouseholds === (target.verifiedHouseholds ?? 0) + 1);
  check('household now verified', est(hh.id)?.verified === true);
  check('cell is P0 after a needs_help report', after?.priority === 'P0');
  const a1 = [...db.assignment.iter()].find(a => a.householdId === hh.id);
  check('assignment marked done', a1?.status === 'done');

  // Policyholder reply page path (passcode, no role).
  const other = [...db.household.iter()].find(h => h.hex !== target.hex && !h.holdout && h.phoneOnFile);
  if (other) {
    const help0 = stats(other.hex)?.helpReplies ?? 0;
    const metricsHelp0 = metrics()?.helpReplies ?? 0;
    await outsider.conn.reducers.submitSmsReply({ householdId: other.id, safety: 'needs_help', damage: 2, passcode: REPLY_PASSCODE });
    await sleep(300);
    const s = stats(other.hex);
    check(
      'sms reply with reply passcode accepted',
      s?.helpReplies === help0 + 1 && metrics()?.helpReplies === metricsHelp0 + 1,
      `household ${other.id}, cell ${other.hex} -> ${s?.priority}, helpReplies ${help0} -> ${s?.helpReplies}`
    );
  }

  // A reply that only asks for a call-back (coverage question, parser unsure) must not move the estimates.
  const callback = [...db.household.iter()].find(h => h.hex !== target.hex && h.hex !== other?.hex && !h.holdout && h.phoneOnFile && stats(h.hex)?.priority !== 'P0');
  if (callback) {
    const cell0 = stats(callback.hex);
    const help0 = est(callback.id)?.pNeedsHelp ?? 0;
    await outsider.conn.reducers.submitParsedReply({ householdId: callback.id, safety: 'needs_help', damage: 255, lifeSafety: false, needs: '', notHome: false, text: 'does my policy cover a hotel?', language: 'en', passcode: REPLY_PASSCODE });
    await sleep(300);
    const cell1 = stats(callback.hex);
    const e1 = est(callback.id);
    check('call-back-only reply leaves the cell alone', cell1?.priority === cell0?.priority && cell1?.helpReplies === cell0?.helpReplies, `${cell0?.priority} -> ${cell1?.priority}, helpReplies ${cell0?.helpReplies} -> ${cell1?.helpReplies}`);
    check('call-back-only reply goes to customer care without raising pNeedsHelp', e1?.escalation === 'assistance' && (e1?.pNeedsHelp ?? 1) <= help0 + 0.05, `${e1?.escalation}, pNeedsHelp ${help0.toFixed(3)} -> ${e1?.pNeedsHelp.toFixed(3)}`);
  }

  const unused = [...db.household.iter()].filter(h => h.hex !== target.hex && h.hex !== other?.hex && h.hex !== callback?.hex && !h.holdout && h.phoneOnFile);
  const parsed = (householdId: string, a: { safety: string; damage: number; lifeSafety: boolean; text: string }) =>
    outsider.conn.reducers.submitParsedReply({ householdId, needs: '', notHome: false, language: 'en', passcode: REPLY_PASSCODE, ...a });
  const [danger, roof] = unused;
  if (danger && roof) {
    await parsed(danger.id, { safety: 'needs_help', damage: 255, lifeSafety: true, text: 'my husband is trapped' });
    await sleep(300);
    await parsed(danger.id, { safety: 'needs_help', damage: 255, lifeSafety: false, text: 'does my policy cover this?' });
    await sleep(300);
    check('a later coverage question keeps the emergency referral', est(danger.id)?.escalation === 'emergency_referral', est(danger.id)?.escalation);
    const severe0 = est(roof.id)?.pSevere ?? 1;
    await parsed(roof.id, { safety: 'needs_help', damage: 2, lifeSafety: false, text: 'roof half gone, does my policy cover it?' });
    await sleep(300);
    check('a call-back-only reply still counts its damage', (est(roof.id)?.pSevere ?? 0) > severe0, `pSevere ${severe0.toFixed(3)} -> ${est(roof.id)?.pSevere.toFixed(3)}`);
  }

  // ----- field reports: house not assessed, missing member, documented closure -----
  const reported = new Set([...db.fieldReport.iter()].map(r => r.householdId));
  const spare = [...db.household.iter()]
    .filter(h => !h.holdout && h.id !== hh.id && h.id !== other?.id && !reported.has(h.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const [hNa, hMiss, hGone] = [spare[0], spare[1], spare[2]];
  const follow = (id: string) => [...db.householdFollowup.iter()].find(f => f.householdId === id);

  await expectReject(
    'not-assessed report (damage 255) without a note',
    adjuster.conn.reducers.submitFieldReport({ householdId: hNa.id, safety: 'safe', damage: 255, note: '  ', memberMissing: false })
  );
  const naStats0 = stats(hNa.hex);
  await adjuster.conn.reducers.submitFieldReport({ householdId: hNa.id, safety: 'safe', damage: 255, note: 'unsafe to enter', memberMissing: false });
  await sleep(300);
  const naRow = [...db.fieldReport.iter()].find(r => r.householdId === hNa.id);
  const naEst = est(hNa.id);
  const naStats1 = stats(hNa.hex);
  check('not-assessed report stored with damageKnown = false', !!naRow && naRow.damageKnown === false && naRow.damage === 0, `damage ${naRow?.damage}, damageKnown ${naRow?.damageKnown}`);
  check(
    "not-assessed report: people accounted ('safe'), property unverified",
    naEst?.accounted === true && naEst?.verified === false && naEst?.escalation === 'verified',
    `accounted ${naEst?.accounted}, verified ${naEst?.verified}, escalation ${naEst?.escalation}`
  );
  check(
    'not-assessed report counts as a field report but not a verified household',
    naStats1?.fieldReports === (naStats0?.fieldReports ?? 0) + 1 && naStats1?.verifiedHouseholds === naStats0?.verifiedHouseholds
  );

  await adjuster.conn.reducers.submitFieldReport({ householdId: hMiss.id, safety: 'safe', damage: 1, note: 'son not here, neighbors have not seen him', memberMissing: true });
  await sleep(300);
  const fMiss = follow(hMiss.id);
  const eMiss = est(hMiss.id);
  check(
    'memberMissing on a field report opens a referral',
    fMiss?.memberMissing === true && (eMiss?.escalation === 'emergency_referral' || eMiss?.escalation === 'referral_overdue'),
    `memberMissing ${fMiss?.memberMissing}, escalation ${eMiss?.escalation}`
  );

  await expectReject(
    "unreachable_after_visit without a prior 'unsure' field report",
    manager.conn.reducers.closeHousehold({ householdId: hGone.id, reason: 'unreachable_after_visit', note: 'called 3 times, no answer' })
  );
  await adjuster.conn.reducers.submitFieldReport({ householdId: hGone.id, safety: 'unsure', damage: 2, note: 'nobody answered the door', memberMissing: false });
  // An open assignment that the closure must clear (the 'unsure' report above completed nothing: assigned after it).
  await manager.conn.reducers.assign({ householdId: hGone.id, adjusterIdentityHex: adjuster.identity.toHexString() });
  await sleep(200);
  check('assignment open before the closure', [...db.assignment.iter()].some(a => a.householdId === hGone.id && a.status === 'assigned'));
  await expectReject(
    'unreachable_after_visit without a note',
    manager.conn.reducers.closeHousehold({ householdId: hGone.id, reason: 'unreachable_after_visit', note: ' ' })
  );
  await manager.conn.reducers.closeHousehold({ householdId: hGone.id, reason: 'unreachable_after_visit', note: 'visited, nobody home; emergency contact did not answer' });
  await sleep(300);
  const fGone = follow(hGone.id);
  check(
    'unreachable_after_visit accepted after an unsure visit, with the note',
    fGone?.closureReason === 'unreachable_after_visit' && fGone.closureNote.startsWith('visited, nobody home') && est(hGone.id)?.escalation === 'closed',
    `reason ${fGone?.closureReason}, note "${fGone?.closureNote}", escalation ${est(hGone.id)?.escalation}`
  );
  const goneAssignments = [...db.assignment.iter()].filter(a => a.householdId === hGone.id);
  check('closure marks open assignments done', goneAssignments.length > 0 && goneAssignments.every(a => a.status === 'done'), goneAssignments.map(a => a.status).join(','));
  await manager.conn.reducers.closeHousehold({ householdId: hGone.id, reason: '', note: '' });
  await manager.conn.reducers.assign({ householdId: hGone.id, adjusterIdentityHex: adjuster.identity.toHexString() });
  await manager.conn.reducers.closeHousehold({ householdId: hGone.id, reason: '', note: '' });
  await sleep(300);
  const reopened = follow(hGone.id);
  check(
    'reopen clears the closure and leaves assignments alone',
    reopened?.closureReason === '' && reopened.closureNote === '' && [...db.assignment.iter()].some(a => a.householdId === hGone.id && a.status === 'assigned'),
    `reason "${reopened?.closureReason}", escalation ${est(hGone.id)?.escalation}`
  );

  // ----- raw reply inbox (Claude parser worker input) -----
  await expectReject(
    'raw reply with wrong passcode',
    outsider.conn.reducers.submitRawReply({ householdId: hNa.id, text: 'we are ok', passcode: 'nope' })
  );
  await expectReject(
    'raw reply longer than 500 characters',
    outsider.conn.reducers.submitRawReply({ householdId: hNa.id, text: 'x'.repeat(501), passcode: REPLY_PASSCODE })
  );
  await outsider.conn.reducers.submitRawReply({ householdId: hNa.id, text: '  estamos bien pero huele a gas  ', passcode: REPLY_PASSCODE });
  await sleep(200);
  const inbox = [...db.replyInbox.iter()].find(r => r.householdId === hNa.id);
  check('raw reply stored as pending (trimmed)', inbox?.status === 'pending' && inbox.text === 'estamos bien pero huele a gas', `status ${inbox?.status}`);
  if (inbox) {
    await expectReject('outsider mark_reply_parsed', outsider.conn.reducers.markReplyParsed({ id: inbox.id, status: 'parsed', error: '' }));
    await manager.conn.reducers.markReplyParsed({ id: inbox.id, status: 'failed', error: 'smoke' });
    await sleep(200);
    const done = [...db.replyInbox.iter()].find(r => r.id === inbox.id);
    check('manager mark_reply_parsed', done?.status === 'failed' && done.error === 'smoke' && done.parsedAt !== undefined);
  }

  // ----- Next best: location-based task recommendations -----
  await subscribe(manager.conn, ['SELECT * FROM adjuster_location']);
  await subscribe(adjuster.conn, ['SELECT * FROM my_recommendations']);
  const recs = () => [...adjuster.conn.db.myRecommendations.iter()].sort((a, b) => a.rank - b.rank);
  const myLoc = () => [...db.adjusterLocation.iter()].find(l => l.identity.isEqual(adjuster.identity));
  const tier = (p: string) => (p === 'P0' ? 0 : p === 'P1' ? 1 : p === 'P2' ? 2 : 3);

  // Comes first: this adjuster has no location yet (reset_demo cleared the table, earlier reports must not create one).
  await expectReject('refresh_recommendations before any location', adjuster.conn.reducers.refreshRecommendations({}));
  await expectReject('outsider update_my_location', outsider.conn.reducers.updateMyLocation({ lat: hh.lat, lng: hh.lng, source: 'demo' }));
  await expectReject('update_my_location with lat 91', adjuster.conn.reducers.updateMyLocation({ lat: 91, lng: hh.lng, source: 'demo' }));
  await expectReject('update_my_location with NaN lat', adjuster.conn.reducers.updateMyLocation({ lat: Number.NaN, lng: hh.lng, source: 'demo' }));
  await expectReject('update_my_location with an unknown source', adjuster.conn.reducers.updateMyLocation({ lat: hh.lat, lng: hh.lng, source: 'satellite' }));

  await adjuster.conn.reducers.updateMyLocation({ lat: hh.lat, lng: hh.lng, source: 'demo' });
  await sleep(300);
  const list0 = recs();
  check('update_my_location at a household yields recommendations', list0.length > 0, `${list0.length} rows`);
  const perHex = new Map<string, number>();
  for (const r of list0) perHex.set(r.hex, (perHex.get(r.hex) ?? 0) + 1);
  check('at most 10 rows and 3 per cell', list0.length <= 10 && [...perHex.values()].every(n => n <= 3), `${list0.length} rows, per cell ${[...perHex.values()].join(',')}`);
  check('cell tier never improves down the list', list0.every((r, i) => i === 0 || tier(list0[i - 1].priority) <= tier(r.priority)), list0.map(r => r.priority).join(','));
  const openIds = new Set([...db.assignment.iter()].filter(a => a.status === 'assigned').map(a => a.householdId));
  check('no listed household has an open assignment', list0.every(r => !openIds.has(r.householdId)), `${openIds.size} open assignment(s)`);

  // Picked from the live list: the earlier steps already reported, assigned or closed some households.
  const listed = new Set(list0.map(r => r.householdId));
  const unlisted = [...db.household.iter()].find(h => !listed.has(h.id));
  const top = list0[0];
  const topHousehold = top && [...db.household.iter()].find(h => h.id === top.householdId);
  if (unlisted && top && topHousehold) {
    await expectReject('accept_recommendation for a household not in the list', adjuster.conn.reducers.acceptRecommendation({ householdId: unlisted.id }));

    await adjuster.conn.reducers.acceptRecommendation({ householdId: top.householdId });
    await sleep(300);
    const taken = [...db.assignment.iter()].filter(a => a.householdId === top.householdId && a.status === 'assigned');
    check("accept_recommendation creates an 'assigned' assignment for the adjuster", taken.length === 1 && taken[0].adjuster.isEqual(adjuster.identity), `household ${top.householdId}, ${top.kind}, ${taken.length} open`);
    const list1 = recs();
    check('accepted household leaves the list and ranks are renumbered', !list1.some(r => r.householdId === top.householdId) && list1.every((r, i) => r.rank === i + 1), `${list1.length} rows`);

    // Accepting tells the policyholder in the app and by iMessage; the adjuster can then chat.
    await subscribe(manager.conn, ['SELECT * FROM chat_message', 'SELECT * FROM imessage_outbox']);
    const chat = () => [...db.chatMessage.iter()].filter(c => c.householdId === top.householdId);
    const notices = () => [...db.imessageOutbox.iter()].filter(m => m.householdId === top.householdId);
    const notice = notices()[0];
    check('accept posts one in-app notice and queues one iMessage', chat().filter(c => c.sender === 'system').length === 1 && notices().length === 1 && notice.status === 'queued', `${chat().length} chat, ${notices().length} iMessage`);
    check('notices name the adjuster, say call 911 and promise no arrival', [...chat(), ...notices()].every(m => m.text.includes('has been assigned') && m.text.includes('call 911') && !/on the way|arriv|minutes|soon/i.test(m.text)), notice?.text ?? '');
    await adjuster.conn.reducers.sendChatMessage({ householdId: top.householdId, text: '  Checking in, is everyone OK?  ' });
    await sleep(300);
    check('assigned adjuster can chat (trimmed)', chat().some(c => c.sender === 'adjuster' && c.text === 'Checking in, is everyone OK?'));
    await expectReject('outsider send_chat_message', outsider.conn.reducers.sendChatMessage({ householdId: top.householdId, text: 'hi' }));
    await expectReject('send_chat_message for a household not assigned to this adjuster', adjuster.conn.reducers.sendChatMessage({ householdId: unlisted.id, text: 'hi' }));
    await expectReject('send_chat_message with empty text', adjuster.conn.reducers.sendChatMessage({ householdId: top.householdId, text: '   ' }));
    await outsider.conn.reducers.submitRawReply({ householdId: top.householdId, text: 'we are OK, thanks', passcode: REPLY_PASSCODE });
    await sleep(300);
    check('typed policyholder reply appears in the chat', chat().some(c => c.sender === 'policyholder' && c.text === 'we are OK, thanks'));
    if (notice) {
      await expectReject('outsider mark_imessage', outsider.conn.reducers.markImessage({ id: notice.id, status: 'sent', error: '' }));
      await manager.conn.reducers.markImessage({ id: notice.id, status: 'sent', error: '' });
      await sleep(300);
      check('manager mark_imessage', notices()[0]?.status === 'sent');
    }

    const locBefore = myLoc();
    await adjuster.conn.reducers.submitFieldReport({ householdId: top.householdId, safety: 'safe', damage: 1, note: 'smoke test: next best visit', memberMissing: false });
    await sleep(300);
    const locAfter = myLoc();
    check(
      'field report moves a demo location to the household',
      locAfter?.source === 'demo' && locAfter.lat === topHousehold.lat && locAfter.lng === topHousehold.lng,
      `${locBefore?.lat.toFixed(5)},${locBefore?.lng.toFixed(5)} -> ${locAfter?.lat.toFixed(5)},${locAfter?.lng.toFixed(5)}, source ${locAfter?.source}`
    );
    check('reported household is not back on the recomputed list', !recs().some(r => r.householdId === top.householdId), `${recs().length} rows`);

    const next = recs()[0];
    if (next) {
      await adjuster.conn.reducers.acceptRecommendation({ householdId: next.householdId });
      await sleep(300);
      await adjuster.conn.reducers.submitFieldReport({ householdId: next.householdId, safety: 'safe', damage: 255, note: 'smoke test: no access', memberMissing: false });
      await sleep(300);
      check('a visited house stays off the list even when it could not be assessed', !recs().some(r => r.householdId === next.householdId), `${recs().length} rows`);
    }
  }

  // "New random disaster" button: the reducers only queue; scripts/disaster-worker.ts does the work.
  await subscribe(manager.conn, ['SELECT * FROM disaster_request']);
  const disasterRows = () => [...manager.conn.db.disasterRequest.iter()];
  await expectReject('disaster request by adjuster', adjuster.conn.reducers.requestNewDisaster({ region: 'ca' }));
  await expectReject('disaster request by outsider', outsider.conn.reducers.requestNewDisaster({ region: 'ca' }));
  await expectReject('disaster request with unknown region', manager.conn.reducers.requestNewDisaster({ region: 'mars' }));
  await manager.conn.reducers.requestNewDisaster({ region: 'ca' });
  let dr = disasterRows();
  check('disaster request queued', dr.length === 1 && dr[0].status === 'queued' && dr[0].requestedBy === 'Smoke Manager', JSON.stringify(dr.map(r => r.status)));
  await expectReject('second disaster request while one is open', manager.conn.reducers.requestNewDisaster({ region: 'tx' }));
  await expectReject('disaster status from a manager', manager.conn.reducers.updateDisasterRequest({ id: dr[0].id, status: 'running', error: '' }));
  await expectReject('disaster queued straight to done', owner.conn.reducers.updateDisasterRequest({ id: dr[0].id, status: 'done', error: '' }));
  await manager.conn.reducers.cancelDisasterRequest({});
  check('queued disaster request cancelled', disasterRows().length === 0);
  await manager.conn.reducers.requestNewDisaster({ region: 'tx' });
  const running = disasterRows()[0];
  await owner.conn.reducers.updateDisasterRequest({ id: running.id, status: 'running', error: '' });
  await expectReject('cancel while the disaster is loading', manager.conn.reducers.cancelDisasterRequest({}));
  await expectReject('disaster request while one is loading', manager.conn.reducers.requestNewDisaster({ region: 'ca' }));
  await owner.conn.reducers.resetDemo({});
  await sleep(300);
  check('disaster request survives reset_demo', disasterRows()[0]?.status === 'running');
  await owner.conn.reducers.updateDisasterRequest({ id: running.id, status: 'done', error: '' });
  await expectReject('cancelled or finished request cannot restart', owner.conn.reducers.updateDisasterRequest({ id: running.id, status: 'running', error: '' }));
  await manager.conn.reducers.requestNewDisaster({ region: 'ca' });
  dr = disasterRows();
  check('new request replaces the finished one', dr.length === 1 && dr[0].status === 'queued' && dr[0].id !== running.id);
  await manager.conn.reducers.cancelDisasterRequest({});

  const mEnd = metrics();
  console.log('\nfinal metrics:', pick(mEnd, ['fieldReports', 'verifiedHouseholds', 'verifiedCoverage', 'p0Cells', 'p1Cells', 'p2Cells', 'needsVerificationCells', 'trustHazard', 'trustSms', 'trustClaims', 'trustUpdates', 'engine']));

  if (!args.includes('--keep')) await manager.conn.reducers.pauseReplay({});
  // Remove the throwaway smoke-test members so the demo member list stays clean.
  await manager.conn.reducers.leave({});
  await adjuster.conn.reducers.leave({});
  await owner.conn.reducers.setStaffSim({ enabled: true, callsPerHour: 0, visitsPerHour: 0, inspectionsPerHour: 0 });
  await owner.conn.reducers.resetDemo({});
  for (const c of [owner, manager, adjuster, outsider]) c.conn.disconnect();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
}

main().then(
  () => process.exit(failures ? 1 : 0),
  e => {
    console.error(errText(e));
    process.exit(1);
  }
);
