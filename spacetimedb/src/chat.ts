// Adjuster and policyholder conversation, and the notices sent when an adjuster accepts a task.
import type { Ctx } from './schema';
import { acceptNotice } from './notice-template';

export type ChatSender = 'adjuster' | 'policyholder' | 'system';

export function addChat(ctx: Ctx, householdId: string, sender: ChatSender, senderName: string, text: string) {
  ctx.db.chatMessage.insert({ id: 0n, householdId, sender, senderName, text, createdAt: ctx.timestamp });
}

/** In-app message plus a queued iMessage, from the one template in notice-template.ts. */
export function notifyTaskAccepted(ctx: Ctx, householdId: string, kind: string, adjusterName: string) {
  addChat(ctx, householdId, 'system', 'Automated assistant', acceptNotice(adjusterName, kind, 'app'));
  ctx.db.imessageOutbox.insert({
    id: 0n,
    householdId,
    text: acceptNotice(adjusterName, kind, 'imessage'),
    status: 'queued',
    error: '',
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
}
