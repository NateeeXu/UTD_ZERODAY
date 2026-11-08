// Targeted subscriptions for the adjuster phone: only rows for my assigned households (and their cells).
// Each query is keyed on the sorted id set, so it re-subscribes only when my assignments change.
import { useMemo } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../../module_bindings/index.ts';
import type { FieldReportRow, HexRow, HouseholdFollowupRow, SmsReplyRow } from '../rows';
import type { SmsSentRow } from './derive';

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

export function useHexRows(hexes: readonly string[]): Map<string, HexRow> {
  const key = idKey(hexes);
  const q = useMemo(() => {
    const list = listOf(key);
    return tables.hex.where((r) => list.map((h) => r.hex.eq(h)).reduce((a, b) => a.or(b)));
  }, [key]);
  const [rows] = useTable(q, { enabled: key.length > 0 });
  return useMemo(() => new Map((key ? rows : EMPTY).map((h) => [h.hex, h])), [rows, key]);
}
