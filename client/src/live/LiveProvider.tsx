import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { SpacetimeDBProvider, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { DbConnection, tables } from '../module_bindings/index.ts';
import { HOST, tokenKey, type Screen } from './config';

function readToken(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

// A new disaster (docs/DATA.md section 9) replaces the whole world in place: wipe_world, then
// seed_world, hexes and households in batches, events, reset_demo. Nothing on screen may outlive
// that (cell set, map bounds, district names, width history, kept lists), so when the `world` row
// changes (event, name, hazard type, landfall time) or disappears and comes back, the provider is
// unmounted for a moment: the SDK pool then closes the socket and drops its client cache, and the
// remount builds a new connection (same identity token, so roles survive) and every screen
// subscribes again from scratch.
type WorldKey = { eventId: string; name: string; hazardType: string; landfallIso: string };
const worldSig = (w: WorldKey) => [w.eventId, w.name, w.hazardType, w.landfallIso].join('␟');
type Seen = { sig: string | null; gap: boolean };
type Swap = { name: string; changed: boolean };

// Longer than the pool's deferred release (setTimeout 0), so the remount cannot reuse the old socket.
const SWAP_GAP_MS = 200;

// One connection per (screen, database). Remount with a different `db` to switch regions.
// The identity token is what keeps a manager / adjuster role across reloads, so it is kept on purpose:
// - saved on every connect, and also written back into the builder so automatic reconnects reuse it
//   (otherwise a page opened without a token reconnects as a brand-new identity);
// - never dropped on an ordinary connect error (network blip, database being republished). Tokens stay
//   valid when a database is rebuilt; only an explicit token rejection clears it.
export function LiveProvider({ screen, db, children }: { screen: Screen; db: string; children: ReactNode }) {
  const [epoch, setEpoch] = useState(0);
  const [swap, setSwap] = useState<Swap | null>(null);
  const seen = useRef<Seen>({ sig: null, gap: false });

  useEffect(() => {
    if (!swap) return;
    const id = setTimeout(() => {
      setEpoch((e) => e + 1);
      setSwap(null);
    }, SWAP_GAP_MS);
    return () => clearTimeout(id);
  }, [swap]);

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
  }, [screen, db, epoch]); // eslint-disable-line react-hooks/exhaustive-deps -- a new epoch needs a new builder

  if (swap) {
    return (
      <div className="world-swap" role="status">
        <span className="p1-label">{swap.changed ? 'New scenario' : 'Scenario reloaded'}</span>
        <b>{swap.name || 'Loading…'}</b>
        <span className="muted small">Reconnecting and loading the new data…</span>
      </div>
    );
  }
  return (
    <SpacetimeDBProvider key={epoch} connectionBuilder={builder}>
      <WorldWatch seen={seen} onSwap={setSwap} />
      {children}
    </SpacetimeDBProvider>
  );
}

// Watches the singleton `world` row of the current connection and asks for a fresh connection when
// the world is replaced. The first world seen on a connection is only recorded.
function WorldWatch({ seen, onSwap }: { seen: MutableRefObject<Seen>; onSwap: (s: Swap) => void }) {
  const [rows, ready] = useTable(tables.world);
  const { isActive } = useSpacetimeDB();
  const world = rows[0];
  const sig = world ? worldSig(world) : null;
  const name = world?.name ?? '';
  useEffect(() => {
    if (!ready || !isActive) return;
    const s = seen.current;
    if (!sig) {
      if (s.sig) s.gap = true; // wiped: whatever comes next is a new world, even under the same name
      return;
    }
    if (s.sig === null) {
      s.sig = sig;
      return;
    }
    if (sig !== s.sig || s.gap) {
      const changed = sig !== s.sig;
      seen.current = { sig, gap: false };
      onSwap({ name, changed });
    }
  }, [sig, ready, isActive, name, seen, onSwap]);
  return null;
}

export function ConnectionBadge() {
  const { isActive, connectionError } = useSpacetimeDB();
  if (connectionError) return <span className="conn err" title={String(connectionError)}>offline</span>;
  return <span className={`conn ${isActive ? 'ok' : ''}`}>{isActive ? 'live' : 'connecting…'}</span>;
}
