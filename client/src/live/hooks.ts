// Targeted subscriptions. The real-geography databases have 20–30k households:
// subscribing to the whole `household` table takes ~25 s, so screens subscribe
// only to the rows they actually show (an OR of ids, re-subscribed when the set changes).
import { useMemo, useRef } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings/index.ts';
import type { HouseholdEstimateRow, HouseholdRow } from './rows';

const NONE = '__none__';

// While a changed query is loading, keep showing the previous rows instead of flashing empty.
function useStableRows<T>(rows: readonly T[], ready: boolean, enabled: boolean): readonly T[] {
  const last = useRef<readonly T[]>([]);
  if (!enabled) return rows;
  if (ready) last.current = rows;
  return ready ? rows : last.current;
}

function idKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join('\n');
}

export function useHouseholdsById(ids: readonly string[]): Map<string, HouseholdRow> {
  const key = idKey(ids);
  const query = useMemo(() => {
    const list = key ? key.split('\n') : [NONE];
    return tables.household.where((r) => list.map((id) => r.id.eq(id)).reduce((a, b) => a.or(b)));
  }, [key]);
  const [raw, ready] = useTable(query, { enabled: key.length > 0 });
  const rows = useStableRows(raw, ready, key.length > 0);
  return useMemo(() => new Map(rows.map((h) => [h.id, h])), [rows]);
}

export function useEstimatesById(ids: readonly string[]): Map<string, HouseholdEstimateRow> {
  const key = idKey(ids);
  const query = useMemo(() => {
    const list = key ? key.split('\n') : [NONE];
    return tables.householdEstimate.where((r) => list.map((id) => r.householdId.eq(id)).reduce((a, b) => a.or(b)));
  }, [key]);
  const [raw, ready] = useTable(query, { enabled: key.length > 0 });
  const rows = useStableRows(raw, ready, key.length > 0);
  return useMemo(() => new Map(rows.map((e) => [e.householdId, e])), [rows]);
}

export function useHouseholdsInCell(hex: string | null): readonly HouseholdRow[] {
  const query = useMemo(() => tables.household.where((r) => r.hex.eq(hex ?? NONE)), [hex]);
  const [rows] = useTable(query, { enabled: !!hex });
  return rows;
}

// Households worth showing in the action queue (the rest have P(needs help) ≤ 10%).
export const actionEstimates = tables.householdEstimate.where((r) => r.pNeedsHelp.gt(0.1));
