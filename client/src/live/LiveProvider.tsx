import { useMemo, type ReactNode } from 'react';
import { SpacetimeDBProvider, useSpacetimeDB } from 'spacetimedb/react';
import { DbConnection } from '../module_bindings/index.ts';
import { HOST, tokenKey, type Screen } from './config';

function readToken(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

// One connection per (screen, database). Remount with a different `db` to switch regions.
export function LiveProvider({ screen, db, children }: { screen: Screen; db: string; children: ReactNode }) {
  const builder = useMemo(() => {
    const key = tokenKey(screen, db);
    return DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(db)
      .withToken(readToken(key))
      .onConnect((_conn, _identity, token) => {
        try {
          localStorage.setItem(key, token);
        } catch {
          /* role won't survive reload */
        }
      })
      .onConnectError((_ctx, err) => {
        // A stale token for a wiped database fails here: drop it and reconnect fresh next load.
        console.error('Spacetime connect error', err);
        try {
          localStorage.removeItem(key);
        } catch {
          /* ignore */
        }
      });
  }, [screen, db]);

  return <SpacetimeDBProvider connectionBuilder={builder}>{children}</SpacetimeDBProvider>;
}

export function ConnectionBadge() {
  const { isActive, connectionError } = useSpacetimeDB();
  if (connectionError) return <span className="conn err" title={String(connectionError)}>offline</span>;
  return <span className={`conn ${isActive ? 'ok' : ''}`}>{isActive ? 'live' : 'connecting…'}</span>;
}
