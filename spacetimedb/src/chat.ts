// Adjuster and policyholder conversation, and the notices sent when an adjuster accepts a task.
import type { Ctx } from './schema';

export type ChatSender = 'adjuster' | 'policyholder' | 'system';

export function addChat(ctx: Ctx, householdId: string, sender: ChatSender, senderName: string, text: string) {
  ctx.db.chatMessage.insert({ id: 0n, householdId, sender, senderName, text, createdAt: ctx.timestamp });
}

/** In-app message plus a queued iMessage. Says who was assigned and nothing about when they will arrive. */
export function notifyTaskAccepted(ctx: Ctx, householdId: string, kind: string, adjusterName: string) {
  const task = kind === 'inspection' ? 'inspect your home' : 'check on your household';
  const assigned = `Adjuster ${adjusterName} has been assigned to ${task}.`;
  const danger = 'If anyone is in danger, call 911.';
  addChat(ctx, householdId, 'system', 'Automated assistant', `${assigned} Reply here with any update. ${danger}`);
  ctx.db.imessageOutbox.insert({
    id: 0n,
    householdId,
    text: `${assigned} Reply in the app with any update. ${danger}`,
    status: 'queued',
    error: '',
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
}
