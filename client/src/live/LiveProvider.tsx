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
// The identity token is what keeps a manager / adjuster role across reloads, so it is kept on purpose:
// - saved on every connect, and also written back into the builder so automatic reconnects reuse it
//   (otherwise a page opened without a token reconnects as a brand-new identity);
// - never dropped on an ordinary connect error (network blip, database being republished). Tokens stay
//   valid when a database is rebuilt; only an explicit token rejection clears it.
export function LiveProvider({ screen, db, children }: { screen: Screen; db: string; children: ReactNode }) {
  const builder = useMemo(() => {
    const key = tokenKey(screen, db);
    const b = DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(db)
      .withToken(readToken(key));
    return b
      .onConnect((_conn, _identity, token) => {
        b.withToken(token);
        try {
          localStorage.setItem(key, token);
        } catch {
          /* role won't survive reload */
        }
      })
      .onConnectError((_ctx, err) => {
        console.error('Spacetime connect error', err);
        if (/\b401\b|unauthori[sz]ed|invalid token|token.*(expired|invalid)/i.test(String(err))) {
          try {
            localStorage.removeItem(key);
          } catch {
            /* ignore */
          }
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
