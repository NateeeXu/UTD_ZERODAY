// Demo roles, live submissions (SMS reply page, adjuster field report) and assignments.
// DEMO AUTH: roles are self-assigned with a shared passcode stored in the private `config` table.
// A real deployment would replace this with OIDC (SpacetimeAuth / Auth0 / Clerk) and an
// owner-managed member table.
import { SenderError, t } from 'spacetimedb/server';
import { Identity } from 'spacetimedb';
import spacetimedb, { type Ctx } from '../schema';
import { isOwner, memberOf, requireAdjuster, requireManager, ROLES, SINGLETON, simNow, type Role } from '../state';
import { NEEDS, onEvent, parseNeeds } from '../ingest';
import { recomputeHex } from '../fusion';
import type { Damage, Safety } from '../fusion/contract';
import { addChat, notifyTaskAccepted, wasNotified } from '../chat';
import { replyLevel } from '../notice-template';
import { afterFieldReport, dropFromAllLists, forgetAdjuster, recomputeRecommendations, setAdjusterLocation, stillNeeded } from '../recommend';

function checkDamage(damage: number) {
  if (!Number.isInteger(damage) || damage < 0 || damage > 3) throw new SenderError('damage must be an integer 0..3');
}

function cleanName(name: string): string {
  const n = name.trim();
  if (n.length < 1 || n.length > 40) throw new SenderError('name must be 1..40 characters');
  return n;
}

function passcodes(ctx: Ctx) {
  const cfg = ctx.db.config.id.find(SINGLETON);
  if (!cfg || !cfg.staffPasscode || !cfg.replyPasscode)
    throw new SenderError('demo passcodes are not configured (owner: run scripts/seed.ts or set_passcodes)');
  return cfg;
}

function parseIdentity(hex: string): Identity {
  const h = hex.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(h)) throw new SenderError('adjuster identity must be 64 hex characters');
  return Identity.fromString(h);
}

// ----- roles -------------------------------------------------------------------

export const joinAs = spacetimedb.reducer(
  { name: 'join_as' },
  { role: t.string(), name: t.string(), passcode: t.string() },
  (ctx, { role, name, passcode }) => {
    if (!ROLES.includes(role as Role)) throw new SenderError(`role must be one of ${ROLES.join(', ')}`);
    const cfg = passcodes(ctx);
    const ok =
      role === 'policyholder_demo'
        ? passcode === cfg.replyPasscode || passcode === cfg.staffPasscode
        : passcode === cfg.staffPasscode;
    if (!ok && !isOwner(ctx)) throw new SenderError('wrong passcode');
    const row = { identity: ctx.sender, role, name: cleanName(name), joinedAt: ctx.timestamp };
    if (ctx.db.member.identity.find(ctx.sender)) ctx.db.member.identity.update(row);
    else ctx.db.member.insert(row);
    if (role !== 'adjuster') forgetAdjuster(ctx, ctx.sender);
  }
);

export const leave = spacetimedb.reducer({ name: 'leave' }, ctx => {
  ctx.db.member.identity.delete(ctx.sender);
  forgetAdjuster(ctx, ctx.sender);
});

/** Manager/owner housekeeping: remove a member (their open assignments stay; reassign them). */
export const removeMember = spacetimedb.reducer(
  { name: 'remove_member' },
  { identityHex: t.string() },
  (ctx, { identityHex }) => {
    requireManager(ctx);
    const target = parseIdentity(identityHex);
    if (!ctx.db.member.identity.delete(target)) throw new SenderError('not a member');
    forgetAdjuster(ctx, target);
  }
);

// ----- live submissions ----------------------------------------------------------

function smsReply(
  ctx: Ctx,
  a: {
    householdId: string;
    safety: string;
    damage: number; // 0..3, or DAMAGE_UNKNOWN
    passcode: string;
    text?: string;
    language?: string;
    lifeSafety: boolean;
    needs: string[];
    notHome: boolean;
  }
) {
  const role = memberOf(ctx)?.role;
  const allowedByRole = role === 'policyholder_demo' || role === 'manager' || isOwner(ctx);
  if (!allowedByRole) {
    const cfg = passcodes(ctx);
    if (a.passcode !== cfg.replyPasscode && a.passcode !== cfg.staffPasscode)
      throw new SenderError('join as policyholder_demo or provide the reply passcode');
  }
  if (a.safety !== 'safe' && a.safety !== 'needs_help') throw new SenderError("safety must be 'safe' or 'needs_help'");
  if (a.damage !== DAMAGE_UNKNOWN) checkDamage(a.damage);
  if (a.text !== undefined && a.text.length > 1000) throw new SenderError('text must be at most 1000 characters');
  if (a.language !== undefined && a.language.length > 16) throw new SenderError('language code too long');
  for (const n of a.needs)
    if (!(NEEDS as readonly string[]).includes(n)) throw new SenderError(`unknown need '${n}' (allowed: ${NEEDS.join(', ')})`);
  onEvent(
    ctx,
    {
      kind: 'sms_reply',
      t: simNow(ctx),
      householdId: a.householdId,
      safety: a.safety,
      damage: a.damage === DAMAGE_UNKNOWN ? null : (a.damage as Damage),
      text: a.text,
      language: a.language,
      lifeSafety: a.lifeSafety,
      needs: [...new Set(a.needs)],
      notHome: a.notHome,
      channel: 'sms',
    },
    'live'
  );
}

/** damage value meaning "the reply does not describe the home" in submit_parsed_reply. */
const DAMAGE_UNKNOWN = 255;

/**
 * Policyholder SMS reply page (buttons). Allowed for policyholder_demo / manager members, or with the
 * reply passcode. The "I need help" button is a generic plea, so it counts as life safety (911 referral).
 */
export const submitSmsReply = spacetimedb.reducer(
  { name: 'submit_sms_reply' },
  { householdId: t.string(), safety: t.string(), damage: t.u8(), passcode: t.string() },
  (ctx, args) => smsReply(ctx, { ...args, lifeSafety: args.safety === 'needs_help', needs: [], notHome: false })
);

/**
 * Same as submit_sms_reply, but also stores the original free-text reply and its language.
 * Prefer submit_parsed_reply, which carries the full parse (life safety vs. needs, unknown damage, not home).
 */
export const submitSmsTextReply = spacetimedb.reducer(
  { name: 'submit_sms_text_reply' },
  { householdId: t.string(), safety: t.string(), damage: t.u8(), text: t.string(), language: t.string(), passcode: t.string() },
  (ctx, args) =>
    smsReply(ctx, {
      ...args,
      text: args.text || undefined,
      language: args.language || undefined,
      lifeSafety: args.safety === 'needs_help',
      needs: [],
      notHome: false,
    })
);

/**
 * A free-text reply parsed by Claude (or another parser): the full structured result.
 * damage: 0..3, or 255 when the reply does not describe the home (e.g. the sender is not there).
 * lifeSafety: danger now -> 911 / local agency referral. needs: comma-separated subset of
 * medical,power_for_device,shelter,water_food,transport,inspection,other ('' for none).
 * Same access rule as submit_sms_text_reply.
 */
export const submitParsedReply = spacetimedb.reducer(
  { name: 'submit_parsed_reply' },
  {
    householdId: t.string(),
    safety: t.string(),
    damage: t.u8(),
    lifeSafety: t.bool(),
    needs: t.string(),
    notHome: t.bool(),
    text: t.string(),
    language: t.string(),
    passcode: t.string(),
  },
  (ctx, args) =>
    smsReply(ctx, {
      ...args,
      text: args.text || undefined,
      language: args.language || undefined,
      needs: parseNeeds(args.needs.replace(/\s+/g, '')),
    })
);

// ----- raw reply inbox (Claude parser worker) ----------------------------------------

/** Spam guard for the public reply passcode: pending rows per household and in total. */
const MAX_PENDING_PER_HOUSEHOLD = 5;
const MAX_PENDING_TOTAL = 500;
const INBOX_STATUSES = ['pending', 'parsed', 'failed'];

/**
 * Reply page: store a raw free-text reply for the Claude parser worker (scripts/claude-worker.ts), which
 * parses it and calls submit_parsed_reply. Same access rule as submit_sms_text_reply. text: 1..500 characters.
 */
export const submitRawReply = spacetimedb.reducer(
  { name: 'submit_raw_reply' },
  { householdId: t.string(), text: t.string(), passcode: t.string() },
  (ctx, { householdId, text, passcode }) => {
    checkReplyAccess(ctx, passcode);
    const hh = ctx.db.household.id.find(householdId);
    if (!hh) throw new SenderError(`unknown household ${householdId}`);
    const body = text.trim();
    const len = [...body].length;
    if (len < 1 || len > 500) throw new SenderError('text must be 1..500 characters');
    const level = replyLevel(body);
    if (level?.only) {
      // Just the number from the notice: nothing for Claude to read. It rates the home and says nothing
      // about people, so it goes in as call-back-only (isCallbackOnly) and marks nobody safe or in danger.
      smsReply(ctx, { householdId, safety: 'needs_help', damage: level.damage, passcode, text: body, lifeSafety: false, needs: [], notHome: false });
      addChat(ctx, householdId, 'policyholder', '', body);
      return;
    }
    let mine = 0;
    for (const r of ctx.db.replyInbox.householdId.filter(householdId)) if (r.status === 'pending') mine++;
    if (mine >= MAX_PENDING_PER_HOUSEHOLD) throw new SenderError('too many replies waiting for this household, try again shortly');
    let total = 0;
    for (const _ of ctx.db.replyInbox.status.filter('pending')) if (++total >= MAX_PENDING_TOTAL) throw new SenderError('reply inbox is full, try again shortly');
    ctx.db.replyInbox.insert({
      id: 0n,
      householdId,
      text: body,
      language: hh.primaryLanguage ?? '',
      status: 'pending',
      receivedAt: ctx.timestamp,
      parsedAt: undefined,
      error: '',
    });
    addChat(ctx, householdId, 'policyholder', '', body);
  }
);

/**
 * Parser worker (manager) or owner: set an inbox row's status. 'parsed' / 'failed' stamp parsedAt;
 * 'pending' puts the row back in the queue (re-parse). error is truncated to 500 characters.
 */
export const markReplyParsed = spacetimedb.reducer(
  { name: 'mark_reply_parsed' },
  { id: t.u64(), status: t.string(), error: t.string() },
  (ctx, { id, status, error }) => {
    requireManager(ctx);
    if (!INBOX_STATUSES.includes(status)) throw new SenderError("status must be 'pending', 'parsed' or 'failed'");
    const row = ctx.db.replyInbox.id.find(id);
    if (!row) throw new SenderError('unknown reply');
    ctx.db.replyInbox.id.update({
      ...row,
      status,
      error: error.slice(0, 500),
      parsedAt: status === 'pending' ? undefined : ctx.timestamp,
    });
  }
);

/** submit_field_report damage value: the adjuster checked the people but did not assess the house. */
const DAMAGE_NOT_ASSESSED = 255;

/**
 * Adjuster field report. Caller must be an `adjuster` member. Completes their open assignment for the household.
 * safety: 'safe' / 'needs_help' = the occupants were seen; 'unsure' = nobody was seen (the people stay
 * unaccounted and move to 'locate'). damage: the property finding 0..3, or 255 = not assessed (unsafe to
 * enter, no access, dark): the note must then say why (>= 3 characters) and the property stays unverified
 * and in the inspection queue. memberMissing: someone in the household is unaccounted for (opens a
 * referral, same as report_member_missing).
 */
export const submitFieldReport = spacetimedb.reducer(
  { name: 'submit_field_report' },
  { householdId: t.string(), safety: t.string(), damage: t.u8(), note: t.string(), memberMissing: t.bool() },
  (ctx, { householdId, safety, damage, note, memberMissing }) => {
    const me = requireAdjuster(ctx);
    if (safety !== 'safe' && safety !== 'needs_help' && safety !== 'unsure')
      throw new SenderError("safety must be 'safe', 'needs_help' or 'unsure'");
    const assessed = damage !== DAMAGE_NOT_ASSESSED;
    if (assessed) checkDamage(damage);
    if (note.length > 500) throw new SenderError('note must be at most 500 characters');
    if (!assessed && note.trim().length < 3)
      throw new SenderError('damage 255 (house not assessed) needs a note saying why, e.g. "unsafe to enter" or "no access: flooded"');
    // Written before onEvent so its recompute sees the missing member (one recompute for both).
    if (memberMissing) markMemberMissing(ctx, householdId, false);
    onEvent(
      ctx,
      {
        kind: 'field_report',
        t: simNow(ctx),
        householdId,
        adjusterId: me.name,
        safety: safety as Safety,
        damage: assessed ? (damage as Damage) : null,
        note,
      },
      'live'
    );
    for (const a of ctx.db.assignment.householdId.filter(householdId)) {
      if (a.status === 'assigned' && a.adjuster.equals(ctx.sender))
        ctx.db.assignment.id.update({ ...a, status: 'done', updatedAt: ctx.timestamp });
    }
    afterFieldReport(ctx, ctx.sender, householdId);
  }
);

// ----- adjuster "Next best" ----------------------------------------------------------

/** Set the caller's position and rebuild their list. Phones send this on a demo pick or at most about once a minute. */
export const updateMyLocation = spacetimedb.reducer(
  { name: 'update_my_location' },
  { lat: t.f64(), lng: t.f64(), source: t.string() },
  (ctx, { lat, lng, source }) => {
    requireAdjuster(ctx);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180)
      throw new SenderError('lat must be -90..90 and lng -180..180');
    if (source !== 'demo' && source !== 'gps') throw new SenderError("source must be 'demo' or 'gps'");
    setAdjusterLocation(ctx, ctx.sender, lat, lng, source);
    recomputeRecommendations(ctx, ctx.sender);
  }
);

export const refreshRecommendations = spacetimedb.reducer({ name: 'refresh_recommendations' }, ctx => {
  requireAdjuster(ctx);
  if (!ctx.db.adjusterLocation.identity.find(ctx.sender)) throw new SenderError('set your location first');
  recomputeRecommendations(ctx, ctx.sender);
});

/**
 * Take a task from the caller's own list. If it no longer needs doing the row disappears and the list
 * refreshes, with no assignment and no error (throwing would roll that refresh back).
 */
export const acceptRecommendation = spacetimedb.reducer(
  { name: 'accept_recommendation' },
  { householdId: t.string() },
  (ctx, { householdId }) => {
    const me = requireAdjuster(ctx);
    const row = [...ctx.db.adjusterRecommendation.adjuster.filter(ctx.sender)].find(r => r.householdId === householdId);
    if (!row) throw new SenderError('not in your Next best list');
    if (stillNeeded(ctx, householdId, row.kind)) {
      assignOne(ctx, householdId, ctx.sender);
      notifyTaskAccepted(ctx, householdId, row.kind, me.name);
    } else dropFromAllLists(ctx, householdId);
    recomputeRecommendations(ctx, ctx.sender);
  }
);

// ----- chat ---------------------------------------------------------------------------

/** An adjuster messages a household they accepted or were assigned (also after the visit). */
export const sendChatMessage = spacetimedb.reducer(
  { name: 'send_chat_message' },
  { householdId: t.string(), text: t.string() },
  (ctx, { householdId, text }) => {
    const me = requireAdjuster(ctx);
    if (![...ctx.db.assignment.householdId.filter(householdId)].some(a => a.status !== 'cancelled' && a.adjuster.equals(ctx.sender)))
      throw new SenderError('only the assigned adjuster can message this household');
    const body = text.trim();
    const len = [...body].length;
    if (len < 1 || len > 500) throw new SenderError('text must be 1..500 characters');
    addChat(ctx, householdId, 'adjuster', me.name, body);
  }
);

/** Delivery result from scripts/imessage-bridge.ts. */
export const markImessage = spacetimedb.reducer(
  { name: 'mark_imessage' },
  { id: t.u64(), status: t.string(), error: t.string() },
  (ctx, { id, status, error }) => {
    requireManager(ctx);
    if (status !== 'sent' && status !== 'failed') throw new SenderError("status must be 'sent' or 'failed'");
    const row = ctx.db.imessageOutbox.id.find(id);
    if (!row) throw new SenderError('unknown message');
    ctx.db.imessageOutbox.id.update({ ...row, status, error: error.slice(0, 200), updatedAt: ctx.timestamp });
  }
);

// ----- assignments ------------------------------------------------------------------

function assignOne(ctx: Ctx, householdId: string, adjuster: Identity) {
  const hh = ctx.db.household.id.find(householdId);
  if (!hh) throw new SenderError(`unknown household ${householdId}`);
  for (const a of ctx.db.assignment.householdId.filter(householdId)) {
    if (a.status !== 'assigned') continue;
    if (a.adjuster.equals(adjuster)) return; // already assigned to this adjuster
    ctx.db.assignment.id.update({ ...a, status: 'cancelled', updatedAt: ctx.timestamp });
  }
  ctx.db.assignment.insert({
    id: 0n,
    householdId,
    hex: hh.hex,
    adjuster,
    assignedBy: ctx.sender,
    status: 'assigned',
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
  dropFromAllLists(ctx, householdId);
}

/**
 * The adjuster opened a task a manager sent them: tell the policyholder, as accepting from Next best does.
 * Once per adjuster and household, so opening it again (or an accepted task) sends nothing.
 */
export const notifyAssignedTask = spacetimedb.reducer(
  { name: 'notify_assigned_task' },
  { householdId: t.string() },
  (ctx, { householdId }) => {
    const me = requireAdjuster(ctx);
    const mine = [...ctx.db.assignment.householdId.filter(householdId)].some(a => a.adjuster.equals(ctx.sender) && a.status === 'assigned');
    if (!mine || wasNotified(ctx, householdId, me.name)) return;
    const estimate = ctx.db.householdEstimate.householdId.find(householdId);
    notifyTaskAccepted(ctx, householdId, estimate?.accounted ? 'inspection' : 'welfare', me.name);
  }
);

function requireAdjusterMember(ctx: Ctx, identityHex: string): Identity {
  const adjuster = parseIdentity(identityHex);
  const m = ctx.db.member.identity.find(adjuster);
  if (!m || m.role !== 'adjuster') throw new SenderError('target identity is not an adjuster member');
  return adjuster;
}

/** Assign one household to an adjuster (manager). Cancels another adjuster's open assignment for it. */
export const assign = spacetimedb.reducer(
  { name: 'assign' },
  { householdId: t.string(), adjusterIdentityHex: t.string() },
  (ctx, { householdId, adjusterIdentityHex }) => {
    requireManager(ctx);
    assignOne(ctx, householdId, requireAdjusterMember(ctx, adjusterIdentityHex));
  }
);

/**
 * Active inspection (manager): assign the `count` unverified households of a cell with the highest
 * inspectScore (likely severe x uncertain) to an adjuster.
 */
export const assignHex = spacetimedb.reducer(
  { name: 'assign_hex' },
  { hex: t.string(), adjusterIdentityHex: t.string(), count: t.u32() },
  (ctx, { hex, adjusterIdentityHex, count }) => {
    requireManager(ctx);
    const adjuster = requireAdjusterMember(ctx, adjusterIdentityHex);
    if (!ctx.db.hex.hex.find(hex)) throw new SenderError(`unknown hex ${hex}`);
    const n = Math.max(1, Math.min(50, count));
    const open = new Set(
      [...ctx.db.assignment.iter()].filter(a => a.status === 'assigned').map(a => a.householdId)
    );
    const picks = [...ctx.db.householdEstimate.hex.filter(hex)]
      .filter(e => !e.verified && !open.has(e.householdId))
      .sort((a, b) => b.inspectScore - a.inspectScore || (a.householdId < b.householdId ? -1 : 1))
      .slice(0, n);
    for (const e of picks) assignOne(ctx, e.householdId, adjuster);
  }
);

/** Manager cancels an assignment, or the assigned adjuster marks it done/cancelled. */
export const updateAssignment = spacetimedb.reducer(
  { name: 'update_assignment' },
  { id: t.u64(), status: t.string() },
  (ctx, { id, status }) => {
    if (status !== 'done' && status !== 'cancelled' && status !== 'assigned')
      throw new SenderError("status must be 'assigned', 'done' or 'cancelled'");
    const a = ctx.db.assignment.id.find(id);
    if (!a) throw new SenderError('unknown assignment');
    const mine = a.adjuster.equals(ctx.sender);
    if (!mine) requireManager(ctx);
    if (status === 'assigned' && [...ctx.db.assignment.householdId.filter(a.householdId)].some(o => o.id !== a.id && o.status === 'assigned'))
      throw new SenderError('this household already has an open assignment');
    ctx.db.assignment.id.update({ ...a, status, updatedAt: ctx.timestamp });
  }
);

// ----- "No one overlooked": follow-ups ---------------------------------------

function checkReplyAccess(ctx: Ctx, passcode: string) {
  const role = memberOf(ctx)?.role;
  if (role === 'policyholder_demo' || role === 'manager' || isOwner(ctx)) return;
  const cfg = passcodes(ctx);
  if (passcode !== cfg.replyPasscode && passcode !== cfg.staffPasscode)
    throw new SenderError('join as policyholder_demo or provide the reply passcode');
}

type FollowupPatch = Partial<{ memberMissing: boolean; reportedSimMinutes: number; referralStatus: string; referralSimMinutes: number; closureReason: string; closureNote: string; closedBy: string }>;

function upsertFollowup(ctx: Ctx, householdId: string, patch: FollowupPatch, recompute = true) {
  const hh = ctx.db.household.id.find(householdId);
  if (!hh) throw new SenderError(`unknown household ${householdId}`);
  const prev = ctx.db.householdFollowup.householdId.find(householdId);
  const row = {
    householdId,
    hex: hh.hex,
    memberMissing: prev?.memberMissing ?? false,
    reportedSimMinutes: prev?.reportedSimMinutes ?? 0,
    referralStatus: prev?.referralStatus ?? '',
    referralSimMinutes: prev?.referralSimMinutes ?? 0,
    closureReason: prev?.closureReason ?? '',
    closureNote: prev?.closureNote ?? '',
    closedBy: prev?.closedBy ?? '',
    ...patch,
    updatedAt: ctx.timestamp,
  };
  if (prev) ctx.db.householdFollowup.householdId.update(row);
  else ctx.db.householdFollowup.insert(row);
  if (recompute) recomputeHex(ctx, hh.hex);
}

/**
 * Someone in the household is unaccounted for (reply page or field report). A repeat report keeps the
 * original clock; a report after a resolved referral opens a new one; an open referral is kept.
 */
function markMemberMissing(ctx: Ctx, householdId: string, recompute: boolean) {
  const prev = ctx.db.householdFollowup.householdId.find(householdId);
  if (prev?.memberMissing && prev.referralStatus !== 'resolved') return;
  const now = simNow(ctx);
  // Keep a referral already open for this household (e.g. from a needs-help reply).
  const open = prev && (prev.referralStatus === 'referred' || prev.referralStatus === 'acknowledged');
  upsertFollowup(
    ctx,
    householdId,
    open ? { memberMissing: true, reportedSimMinutes: now } : { memberMissing: true, reportedSimMinutes: now, referralStatus: '', referralSimMinutes: 0 },
    recompute
  );
}

/** Policyholder page: "Someone in my household is unaccounted for". Opens a referral. */
export const reportMemberMissing = spacetimedb.reducer(
  { name: 'report_member_missing' },
  { householdId: t.string(), passcode: t.string() },
  (ctx, { householdId, passcode }) => {
    checkReplyAccess(ctx, passcode);
    if (!ctx.db.household.id.find(householdId)) throw new SenderError(`unknown household ${householdId}`);
    const prev = ctx.db.householdFollowup.householdId.find(householdId);
    // A repeat report keeps the original clock (nothing to write).
    if (prev?.memberMissing && prev.referralStatus !== 'resolved') return;
    markMemberMissing(ctx, householdId, true);
  }
);

/** Referral lifecycle for people who need help: referred -> acknowledged -> resolved (manager). */
export const updateReferral = spacetimedb.reducer(
  { name: 'update_referral' },
  { householdId: t.string(), status: t.string() },
  (ctx, { householdId, status }) => {
    requireManager(ctx);
    if (status !== 'referred' && status !== 'acknowledged' && status !== 'resolved')
      throw new SenderError("status must be 'referred', 'acknowledged' or 'resolved'");
    // referralSimMinutes = when it was referred (overdue clock), or when it was resolved (a later
    // needs-help reply opens a new referral).
    upsertFollowup(ctx, householdId, status === 'acknowledged' ? { referralStatus: status } : { referralStatus: status, referralSimMinutes: simNow(ctx) });
  }
);

/**
 * No silent closure: a household leaves "unaccounted" only with evidence or a documented reason.
 * reason: 'vacant' | 'not_in_area' | 'unreachable_after_visit' (needs a field report with safety 'unsure',
 * i.e. a visit that found nobody) | '' to reopen. note: required with a reason (>= 3 characters), stored in
 * household_followup.closureNote; ignored on reopen (the note is cleared). Closing marks the household's
 * open ('assigned') assignments 'done'; reopening does not touch assignments.
 */
export const closeHousehold = spacetimedb.reducer(
  { name: 'close_household' },
  { householdId: t.string(), reason: t.string(), note: t.string() },
  (ctx, { householdId, reason, note }) => {
    const me = memberOf(ctx);
    if (!(me && (me.role === 'manager' || me.role === 'adjuster')) && !isOwner(ctx))
      throw new SenderError('only managers or adjusters can close a household');
    if (!['vacant', 'not_in_area', 'unreachable_after_visit', ''].includes(reason))
      throw new SenderError("reason must be 'vacant', 'not_in_area', 'unreachable_after_visit' or '' (reopen)");
    const why = note.trim();
    if (reason && why.length < 3) throw new SenderError('closing a household needs a note (at least 3 characters) saying what was tried');
    if (why.length > 500) throw new SenderError('note must be at most 500 characters');
    if (reason === 'unreachable_after_visit' && ![...ctx.db.fieldReport.householdId.filter(householdId)].some(r => r.safety === 'unsure'))
      throw new SenderError("unreachable_after_visit needs a field report for this household with safety 'unsure' (visited, nobody seen) first");
    upsertFollowup(ctx, householdId, {
      closureReason: reason,
      closureNote: reason ? why : '',
      closedBy: reason ? (me?.name ?? 'owner') : '',
    });
    // Closing clears the adjusters' task lists; reopening leaves assignments alone.
    if (reason) {
      for (const a of [...ctx.db.assignment.householdId.filter(householdId)])
        if (a.status === 'assigned') ctx.db.assignment.id.update({ ...a, status: 'done', updatedAt: ctx.timestamp });
      dropFromAllLists(ctx, householdId);
    }
  }
);
