// The one message a policyholder gets when an adjuster accepts their task, and how its 1-4 answer is read.
// No imports, so scripts can run it under plain Node.

export type NoticeChannel = 'app' | 'imessage';

/** Says who was assigned and asks for everything the reply fields hold. Promises no arrival time, help or coverage. */
export function acceptNotice(adjusterName: string, kind: string, channel: NoticeChannel): string {
  const task = kind === 'inspection' ? 'inspect your home' : 'check on your household';
  // iMessage replies are not read, so that channel sends people to the app.
  const replyWhere = channel === 'imessage' ? 'Open the Saviu app and reply' : 'Reply here';
  return [
    `Adjuster ${adjusterName} has been assigned to ${task}.`,
    '',
    `${replyWhere} with the number that fits your home:`,
    '1 - Minor or no damage (broken glass, shingles, fence)',
    "2 - Moderate (water inside, roof partly gone, doors won't close)",
    '3 - Severe (collapsed or not safe to live in)',
    '4 - Not sure',
    '',
    'You can also tell us in your own words:',
    '- Is everyone safe and accounted for?',
    '- Are you at home right now?',
    '- Do you need medical care, shelter, water or food, transport, or power for a device?',
    '',
    'If anyone is in danger, call 911.',
  ].join('\n');
}

/** Level in the notice -> damage value (0..3, 255 = unknown). The examples above match the parser's damage scale. */
const LEVEL_DAMAGE: Record<string, number> = { '1': 1, '2': 2, '3': 3, '4': 255 };

// A level is a digit on its own or followed by punctuation: "3", "3.", "3, roof gone", "3 - need water".
// Not a count or a measure: "3 people trapped", "1.5 feet of water", "3-4 of us".
const LEVEL_AT_START = /^#?([1-4])(?:\s*[.,;:!)]+(?!\d)\s*|\s+[-–—]+\s*|\s*$)/;

/** The damage level a reply starts with, if any. `only` = the reply is nothing but the level. */
export function replyLevel(text: string): { damage: number; only: boolean } | null {
  const body = text.trim();
  const m = body.match(LEVEL_AT_START);
  return m ? { damage: LEVEL_DAMAGE[m[1]], only: m[0].length === body.length } : null;
}
