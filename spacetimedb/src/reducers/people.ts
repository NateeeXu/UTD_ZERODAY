// Demo roles, live submissions (SMS reply page, adjuster field report) and assignments.
// DEMO AUTH: roles are self-assigned with a shared passcode stored in the private `config` table.
// A real deployment would replace this with OIDC (SpacetimeAuth / Auth0 / Clerk) and an
// owner-managed member table.
import { SenderError, t } from 'spacetimedb/server';
import { Identity } from 'spacetimedb';
import spacetimedb, { type Ctx } from '../schema';
import { isOwner, memberOf, requireAdjuster, requireManager, ROLES, SINGLETON, simNow, type Role } from '../state';
import { onEvent } from '../ingest';
import type { Damage, Safety } from '../fusion/contract';

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
  }
);

export const leave = spacetimedb.reducer({ name: 'leave' }, ctx => {
  ctx.db.member.identity.delete(ctx.sender);
});

/** Manager/owner housekeeping: remove a member (their open assignments stay; reassign them). */
export const removeMember = spacetimedb.reducer(
  { name: 'remove_member' },
  { identityHex: t.string() },
  (ctx, { identityHex }) => {
    requireManager(ctx);
    if (!ctx.db.member.identity.delete(parseIdentity(identityHex))) throw new SenderError('not a member');
  }
);

// ----- live submissions ----------------------------------------------------------

function smsReply(
  ctx: Ctx,
  a: { householdId: string; safety: string; damage: number; passcode: string; text?: string; language?: string }
) {
  const role = memberOf(ctx)?.role;
  const allowedByRole = role === 'policyholder_demo' || role === 'manager' || isOwner(ctx);
  if (!allowedByRole) {
    const cfg = passcodes(ctx);
    if (a.passcode !== cfg.replyPasscode && a.passcode !== cfg.staffPasscode)
      throw new SenderError('join as policyholder_demo or provide the reply passcode');
  }
  if (a.safety !== 'safe' && a.safety !== 'needs_help') throw new SenderError("safety must be 'safe' or 'needs_help'");
  checkDamage(a.damage);
  if (a.text !== undefined && a.text.length > 1000) throw new SenderError('text must be at most 1000 characters');
  if (a.language !== undefined && a.language.length > 16) throw new SenderError('language code too long');
  onEvent(
    ctx,
    {
      kind: 'sms_reply',
      t: simNow(ctx),
      householdId: a.householdId,
      safety: a.safety,
      damage: a.damage as Damage,
      text: a.text,
      language: a.language,
    },
    'live'
  );
}

/** Policyholder SMS reply page. Allowed for policyholder_demo / manager members, or with the reply passcode. */
export const submitSmsReply = spacetimedb.reducer(
  { name: 'submit_sms_reply' },
  { householdId: t.string(), safety: t.string(), damage: t.u8(), passcode: t.string() },
  (ctx, args) => smsReply(ctx, args)
);

/**
 * Same as submit_sms_reply, but also stores the original free-text reply and its language
 * (safety/damage are the values parsed from it, e.g. by Claude on the reply page).
 */
export const submitSmsTextReply = spacetimedb.reducer(
  { name: 'submit_sms_text_reply' },
  { householdId: t.string(), safety: t.string(), damage: t.u8(), text: t.string(), language: t.string(), passcode: t.string() },
  (ctx, args) => smsReply(ctx, { ...args, text: args.text || undefined, language: args.language || undefined })
);

/** Adjuster field report. Caller must be an `adjuster` member. Completes their open assignment for the household. */
export const submitFieldReport = spacetimedb.reducer(
  { name: 'submit_field_report' },
  { householdId: t.string(), safety: t.string(), damage: t.u8(), note: t.string() },
  (ctx, { householdId, safety, damage, note }) => {
    const me = requireAdjuster(ctx);
    if (safety !== 'safe' && safety !== 'needs_help' && safety !== 'unsure')
      throw new SenderError("safety must be 'safe', 'needs_help' or 'unsure'");
    checkDamage(damage);
    if (note.length > 500) throw new SenderError('note must be at most 500 characters');
    onEvent(
      ctx,
      {
        kind: 'field_report',
        t: simNow(ctx),
        householdId,
        adjusterId: me.name,
        safety: safety as Safety,
        damage: damage as Damage,
        note,
      },
      'live'
    );
    for (const a of ctx.db.assignment.householdId.filter(householdId)) {
      if (a.status === 'assigned' && a.adjuster.equals(ctx.sender))
        ctx.db.assignment.id.update({ ...a, status: 'done', updatedAt: ctx.timestamp });
    }
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
}

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
    ctx.db.assignment.id.update({ ...a, status, updatedAt: ctx.timestamp });
  }
);
