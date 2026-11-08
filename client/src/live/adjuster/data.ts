// Targeted subscriptions for the adjuster phone: only rows for my assigned households (and their cells).
// Each query is keyed on the sorted id set, so it re-subscribes only when my assignments change.
import { useMemo } from 'react';
import type { Infer } from 'spacetimedb';
import { useTable } from 'spacetimedb/react';
import { tables } from '../../module_bindings/index.ts';
import type ChatMessageRowDef from '../../module_bindings/chat_message_table.ts';
import type ImessageOutboxRowDef from '../../module_bindings/imessage_outbox_table.ts';
import type { FieldReportRow, HexRow, HouseholdFollowupRow, SmsReplyRow } from '../rows';
import type { SmsSentRow } from './derive';

export type ChatRow = Infer<typeof ChatMessageRowDef>;
export type ImessageRow = Infer<typeof ImessageOutboxRowDef>;

const NONE = '__none__';
const EMPTY: readonly never[] = [];

export function idKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join('\n');
}
const listOf = (key: string) => (key ? key.split('\n') : [NONE]);

function group<T extends { householdId: string }>(rows: readonly T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const list = m.get(r.householdId);
    if (list) list.push(r);
    else m.set(r.householdId, [r]);
  }
  return m;
}

export function useRepliesFor(ids: readonly string[]): Map<string, SmsReplyRow[]> {
  const key = idKey(ids);
  const q = useMemo(() => {
    const list = listOf(key);
    return tables.smsReply.where((r) => list.map((id) => r.householdId.eq(id)).reduce((a, b) => a.or(b)));
  }, [key]);
  const [rows] = useTable(q, { enabled: key.length > 0 });
  return useMemo(() => group(key ? rows : EMPTY), [rows, key]);
}

export function useReportsFor(ids: readonly string[]): Map<string, FieldReportRow[]> {
  const key = idKey(ids);
  const q = useMemo(() => {
    const list = listOf(key);
    return tables.fieldReport.where((r) => list.map((id) => r.householdId.eq(id)).reduce((a, b) => a.or(b)));
  }, [key]);
  const [rows] = useTable(q, { enabled: key.length > 0 });
  return useMemo(() => group(key ? rows : EMPTY), [rows, key]);
}

export function useFollowupsFor(ids: readonly string[]): Map<string, HouseholdFollowupRow> {
  const key = idKey(ids);
  const q = useMemo(() => {
    const list = listOf(key);
    return tables.householdFollowup.where((r) => list.map((id) => r.householdId.eq(id)).reduce((a, b) => a.or(b)));
  }, [key]);
  const [rows] = useTable(q, { enabled: key.length > 0 });
  return useMemo(() => new Map((key ? rows : EMPTY).map((f) => [f.householdId, f])), [rows, key]);
}

export function useSentFor(ids: readonly string[]): Map<string, SmsSentRow[]> {
  const key = idKey(ids);
  const q = useMemo(() => {
    const list = listOf(key);
    return tables.smsSent.where((r) => list.map((id) => r.householdId.eq(id)).reduce((a, b) => a.or(b)));
  }, [key]);
  const [rows] = useTable(q, { enabled: key.length > 0 });
  return useMemo(() => group(key ? rows : EMPTY), [rows, key]);
}

/** Latest iMessage notice per household (the one sent when I accepted it). */
export function useImessageFor(ids: readonly string[]): Map<string, ImessageRow> {
  const key = idKey(ids);
  const q = useMemo(() => {
    const list = listOf(key);
    return tables.imessageOutbox.where((r) => list.map((id) => r.householdId.eq(id)).reduce((a, b) => a.or(b)));
  }, [key]);
  const [rows] = useTable(q, { enabled: key.length > 0 });
  return useMemo(() => {
    const m = new Map<string, ImessageRow>();
    for (const r of key ? rows : EMPTY) {
      const cur = m.get(r.householdId);
      if (!cur || r.id > cur.id) m.set(r.householdId, r);
    }
    return m;
  }, [rows, key]);
}

/** Chat rows for all my households (the Messages tab), grouped by household, oldest first. */
export function useChatFor(ids: readonly string[]): Map<string, ChatRow[]> {
  const key = idKey(ids);
  const q = useMemo(() => {
    const list = listOf(key);
    return tables.chatMessage.where((r) => list.map((id) => r.householdId.eq(id)).reduce((a, b) => a.or(b)));
  }, [key]);
  const [rows] = useTable(q, { enabled: key.length > 0 });
  return useMemo(() => {
    const m = group(key ? rows : EMPTY);
    for (const list of m.values()) list.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    return m;
  }, [rows, key]);
}

/** One household's chat thread, oldest first. Subscribed only while the thread is open. */
export function useChatThread(householdId: string | null): { rows: ChatRow[]; ready: boolean } {
  const q = useMemo(() => tables.chatMessage.where((r) => r.householdId.eq(householdId ?? NONE)), [householdId]);
  const [rows, ready] = useTable(q, { enabled: !!householdId });
  const sorted = useMemo(() => (householdId ? [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) : []), [rows, householdId]);
  return { rows: sorted, ready };
}

export function useHexRows(hexes: readonly string[]): Map<string, HexRow> {
  const key = idKey(hexes);
  const q = useMemo(() => {
    const list = listOf(key);
    return tables.hex.where((r) => list.map((h) => r.hex.eq(h)).reduce((a, b) => a.or(b)));
  }, [key]);
  const [rows] = useTable(q, { enabled: key.length > 0 });
  return useMemo(() => new Map((key ? rows : EMPTY).map((h) => [h.hex, h])), [rows, key]);
}
