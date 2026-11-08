// Field-report outbox (docs/ADJUSTER_APP.md section 3).
// A report is saved here before it is sent and removed once the server has it. "Sent" means the reducer
// resolved, or my report count for that household went above the count taken before the first try
// (counts, not times, so a skewed phone clock cannot fool it). Not connected, or no answer in 8 s ->
// Queued; queued reports retry on reconnect, every 20 s, or on "Try now", always checking for a
// duplicate first. A rejected report (SenderError) is Failed and is not retried automatically.
// Only the report itself is stored, never household details.
import { useCallback, useEffect, useRef, useState } from 'react';

export type Safety = 'safe' | 'needs_help' | 'unsure';
export type ReportMode = 'new' | 'update' | 'correction';
export type PeoplePick = 'safe' | 'needs_help' | 'missing' | 'nobody';

export interface Draft {
  householdId: string;
  hex: string;
  assignmentId: string | null;
  safety: Safety;
  damage: number;
  note: string;
  memberMissing: boolean;
  rangeBefore: [number, number] | null;
  mode: ReportMode;
  // What the form showed, so "Add update" / "Send correction" can prefill it.
  form: { pick: PeoplePick; alsoMissing: boolean; damageChoice: string | null; reason: string | null; userNote: string };
}
export type OutboxState = 'sending' | 'queued' | 'failed';
export interface OutboxItem extends Draft {
  opId: string;
  baseCount: number;
  createdAt: number;
  tries: number;
  lastTry: number;
  state: OutboxState;
  error?: string;
}
export interface SentRecord extends Draft { opId: string; sentAt: number }

type SubmitArgs = { householdId: string; safety: string; damage: number; note: string; memberMissing: boolean };

const KEY = 'adjuster-outbox-v1';
const TIMEOUT_MS = 8000;
const RETRY_MS = 20000;
const RESUBSCRIBE_GRACE_MS = 1500; // let subscriptions re-apply after a reconnect before counting

function load(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : [];
    // Anything that was mid-send when the page closed is just queued now.
    return Array.isArray(v) ? v.map((i: OutboxItem) => ({ ...i, state: i.state === 'failed' ? 'failed' : 'queued' })) : [];
  } catch {
    return [];
  }
}
function save(items: OutboxItem[]) {
  try {
    if (items.length) localStorage.setItem(KEY, JSON.stringify(items));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the report still lives in memory */
  }
}
const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const looksOffline = (msg: string) => /not connected|websocket|closed|disconnect|network|timed? ?out/i.test(msg);

export function useOutbox(o: {
  submit: (args: SubmitArgs) => Promise<void>;
  isActive: boolean;
  myCount: (householdId: string) => number;
  onSent: (r: SentRecord) => void;
}) {
  const [items, setItems] = useState<OutboxItem[]>(load);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const opts = useRef(o);
  opts.current = o;
  const inflight = useRef(new Set<string>());
  const finished = useRef(new Set<string>());

  useEffect(() => save(items), [items]);

  const patch = useCallback((opId: string, p: Partial<OutboxItem>) => {
    itemsRef.current = itemsRef.current.map((i) => (i.opId === opId ? { ...i, ...p } : i));
    setItems(itemsRef.current);
  }, []);

  const markSent = useCallback((opId: string) => {
    if (finished.current.has(opId)) return;
    const item = itemsRef.current.find((i) => i.opId === opId);
    if (!item) return;
    finished.current.add(opId);
    itemsRef.current = itemsRef.current.filter((i) => i.opId !== opId);
    setItems(itemsRef.current);
    const { baseCount: _b, createdAt: _c, tries: _t, lastTry: _l, state: _s, error: _e, ...draft } = item;
    opts.current.onSent({ ...draft, opId, sentAt: Date.now() });
  }, []);

  const attempt = useCallback(async (opId: string) => {
    const item = itemsRef.current.find((i) => i.opId === opId);
    if (!item || inflight.current.has(opId) || finished.current.has(opId)) return;
    const { isActive, myCount, submit } = opts.current;
    if (myCount(item.householdId) > item.baseCount) return markSent(opId); // already arrived
    if (!isActive) return patch(opId, { state: 'queued' });
    inflight.current.add(opId);
    patch(opId, { state: 'sending', tries: item.tries + 1, lastTry: Date.now(), error: undefined });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), TIMEOUT_MS); });
    try {
      const r = await Promise.race([
        submit({ householdId: item.householdId, safety: item.safety, damage: item.damage, note: item.note, memberMissing: item.memberMissing }).then(() => 'ok' as const),
        timeout,
      ]);
      if (r === 'ok') markSent(opId);
      else patch(opId, { state: 'queued' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!opts.current.isActive || looksOffline(msg)) patch(opId, { state: 'queued' });
      else patch(opId, { state: 'failed', error: msg });
    } finally {
      clearTimeout(timer);
      inflight.current.delete(opId);
    }
  }, [markSent, patch]);

  const send = useCallback((draft: Draft): string => {
    const opId = newId();
    const { isActive, myCount } = opts.current;
    const item: OutboxItem = {
      ...draft, opId, baseCount: myCount(draft.householdId), createdAt: Date.now(), tries: 0, lastTry: 0,
      state: isActive ? 'sending' : 'queued',
    };
    itemsRef.current = [...itemsRef.current, item];
    setItems(itemsRef.current);
    if (isActive) void attempt(opId);
    return opId;
  }, [attempt]);

  // My new report showed up in the subscription: it arrived (even if the reducer call timed out).
  useEffect(() => {
    for (const i of itemsRef.current) if (o.myCount(i.householdId) > i.baseCount) markSent(i.opId);
  }, [o.myCount, markSent]);

  // Reconnected: retry what is queued once subscriptions have had a moment to re-apply.
  useEffect(() => {
    if (!o.isActive) return;
    const id = setTimeout(() => {
      for (const i of itemsRef.current) if (i.state === 'queued') void attempt(i.opId);
    }, RESUBSCRIBE_GRACE_MS);
    return () => clearTimeout(id);
  }, [o.isActive, attempt]);

  // Background retry every 20 s while queued.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      for (const i of itemsRef.current) {
        if (i.state === 'queued' && opts.current.isActive && now - i.lastTry >= RETRY_MS) void attempt(i.opId);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [attempt]);

  const remove = useCallback((opId: string) => {
    finished.current.add(opId);
    itemsRef.current = itemsRef.current.filter((i) => i.opId !== opId);
    setItems(itemsRef.current);
  }, []);

  return { items, send, tryNow: attempt, remove };
}
