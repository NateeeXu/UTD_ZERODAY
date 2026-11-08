import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { useReducer } from 'spacetimedb/react';
import { DbConnection, reducers } from '../module_bindings/index.ts';
import { HOST, type RegionId } from './config';
import { freeName, rememberName, savedPasscode } from './JoinDialog';
import type { HouseholdRow } from './rows';

const CODE_KEY = 'triage-reply-code';

// Policyholder SMS link. region= always goes in the query (before the #): the top-bar region
// switch doesn't touch the URL, and without it the phone would open its own saved or default region.
// Other query params are kept.
export function replyLink(
  loc: Pick<Location, 'origin' | 'pathname' | 'search'>, region: RegionId, householdId: string, code: string,
): string {
  const params = new URLSearchParams(loc.search);
  params.set('region', region);
  return `${loc.origin}${loc.pathname}?${params}#/reply?h=${encodeURIComponent(householdId)}&code=${encodeURIComponent(code)}`;
}

// QR for judges: opens the policyholder SMS page for one household. The reply passcode
// may travel in this link (it only allows SMS replies); the staff passcode never does.
export function LiveQrCard({ household, region, large = false }: { household: HouseholdRow | null; region: RegionId; large?: boolean }) {
  const [code, setCode] = useState(() => {
    try {
      return localStorage.getItem(CODE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [draft, setDraft] = useState('');
  const [src, setSrc] = useState<string | null>(null);
  const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const url = household && code ? replyLink(window.location, region, household.id, code) : null;

  useEffect(() => {
    if (!url) return setSrc(null);
    QRCode.toDataURL(url, { margin: 0, width: large ? 560 : 168, color: { dark: '#111111', light: '#ffffff' } }).then(setSrc).catch(() => setSrc(null));
  }, [url, large]);

  const save = (v: string) => {
    setCode(v);
    try {
      localStorage.setItem(CODE_KEY, v);
    } catch {
      /* ignore */
    }
  };

  if (!code) {
    return (
      <form className={`qr-card${large ? ' large' : ''}`} onSubmit={(e) => { e.preventDefault(); if (draft.trim()) save(draft.trim()); }}>
        <div className="qr-ph" aria-hidden />
        <div className="qr-text">
          <b>Judge QR code</b>
          <span className="muted">Enter the reply passcode to show it.</span>
          <span className="qr-input">
            <input type="password" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Reply passcode" autoComplete="off" />
            <button className="btn">Set</button>
          </span>
        </div>
      </form>
    );
  }

  return (
    <div className={`qr-card${large ? ' large' : ''}`}>
      {src ? <a href={url!} target="_blank" rel="noreferrer"><img src={src} width={large ? 280 : 84} height={large ? 280 : 84} alt="QR code for the policyholder SMS page" /></a> : <div className="qr-ph" />}
      <div className="qr-text">
        <b>Try it yourself</b>
        <span className="muted">Scan to reply as a policyholder in the quietest hard-hit area.</span>
        {local && <span className="warn-text">Open via the Network URL so phones can reach it.</span>}
        <button className="link muted small" onClick={() => save('')}>Change passcode</button>
      </div>
    </div>
  );
}

// ---- Adjuster phone hand-off ------------------------------------------------------------------
// The QR opens #/adjuster on a phone already signed in: it carries the identity token of a throwaway
// adjuster minted here for that purpose (never the manager's own token, never the staff passcode).
// Whoever scans it acts as that adjuster, so "New code" removes the old member (remove_member) first.
// The token rides after '#', so it never reaches the web server; the phone stores it and strips it
// from the address bar before connecting (config.consumeAdjusterHandoff).
const qrKey = (db: string) => `triage-qr-adjuster-${db}`;
let typedPasscode: string | null = null; // memory only, for this page session
// The passcode remembered by the join dialog can be stale (e.g. after a rebuild with a new passcode).
// Once the database refuses it, stop using it here and ask for the passcode instead.
let savedRejected = false;

type Member = { identity: { toHexString(): string }; name: string; role: string };

function tokenIdentity(token: string): string | null {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(b64)) as { hex_identity?: unknown };
    return typeof claims.hex_identity === 'string' ? claims.hex_identity : null;
  } catch {
    return null;
  }
}

function readQrToken(db: string): string | null {
  try {
    return localStorage.getItem(qrKey(db));
  } catch {
    return null;
  }
}

function writeQrToken(db: string, token: string | null) {
  try {
    if (token) localStorage.setItem(qrKey(db), token);
    else localStorage.removeItem(qrKey(db));
  } catch {
    /* storage blocked: the code lasts until reload */
  }
}

// A fresh identity that joins as an adjuster, then disconnects. Resolves with its token.
function mintAdjuster(db: string, name: string, passcode: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => finish(() => reject(new Error('No response from the database. Try again.'))), 15000);
    DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(db)
      .onConnect((conn, _identity, token) => {
        conn.reducers.joinAs({ role: 'adjuster', name, passcode })
          .then(() => finish(() => resolve(token)), (err: unknown) => finish(() => reject(err)))
          .finally(() => conn.disconnect());
      })
      .onConnectError((_ctx, err) => finish(() => reject(err)))
      .build();
  });
}

const adjusterLink = (loc: Pick<Location, 'origin' | 'pathname' | 'search'>, region: RegionId, token: string) => {
  const params = new URLSearchParams(loc.search);
  params.set('region', region);
  return `${loc.origin}${loc.pathname}?${params}#/adjuster?t=${encodeURIComponent(token)}`;
};

export function AdjusterQr({ db, region, members, managerName }: { db: string; region: RegionId; members: readonly Member[]; managerName: string | undefined }) {
  const [token, setToken] = useState<string | null>(() => readQrToken(db));
  const [src, setSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pass, setPass] = useState('');
  const removeMember = useReducer(reducers.removeMember);
  const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);

  const ident = token ? tokenIdentity(token) : null;
  const member = ident ? members.find((m) => m.identity.toHexString() === ident && m.role === 'adjuster') : undefined;
  const url = token && member ? adjusterLink(window.location, region, token) : null;
  const known = typedPasscode ?? (savedRejected ? null : savedPasscode());

  useEffect(() => {
    if (!url) return setSrc(null);
    QRCode.toDataURL(url, { margin: 0, width: 560, color: { dark: '#111111', light: '#ffffff' } }).then(setSrc).catch(() => setSrc(null));
  }, [url]);

  const create = async (passcode: string) => {
    setBusy(true);
    setError(null);
    try {
      // Revoke the previous code's adjuster (if it is still a member) so an old photo stops working.
      if (member) await removeMember({ identityHex: member.identity.toHexString() }).catch(() => undefined);
      const taken = new Set(members.map((m) => m.name.trim().toLowerCase()));
      const name = freeName(`${(managerName ?? 'Manager').slice(0, 30)} · phone`, taken);
      const t = await mintAdjuster(db, name, passcode);
      typedPasscode = passcode;
      writeQrToken(db, t);
      rememberName(db, 'adjuster', name);
      setToken(t);
      setPass('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/wrong passcode/i.test(msg)) {
        typedPasscode = null;
        savedRejected = true; // show the passcode field on the next render
      }
      setError(/wrong passcode/i.test(msg) ? 'Wrong staff passcode.' : msg);
    } finally {
      setBusy(false);
    }
  };

  if (url) {
    return (
      <div className="qr-card large">
        {src ? <a href={url} target="_blank" rel="noreferrer"><img src={src} width={280} height={280} alt="QR code that opens the adjuster screen on a phone" /></a> : <div className="qr-ph" />}
        <div className="qr-text">
          <b>Adjuster on your phone</b>
          <span className="muted">Scan to open the adjuster screen as <b>{member!.name}</b>. No sign-in needed; the phone stays signed in.</span>
          <span className="muted small">Anyone who scans this code acts as that adjuster. Demo only.</span>
          {local && <span className="warn-text">Open via the Network URL so phones can reach it.</span>}
          {error && <span className="form-error small" role="alert">{error}</span>}
          {/* No usable passcode (never typed, or the remembered one was refused): ask for it here too. */}
          {!known && (
            <span className="qr-input">
              <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} aria-label="Staff passcode" placeholder="Staff passcode for a new code" autoComplete="off" />
            </span>
          )}
          <button className="link muted small" disabled={busy || !(known ?? pass.trim())} onClick={() => { const p = known ?? pass.trim(); if (p) void create(p); }}
            title="Remove this adjuster and show a new code">
            {busy ? 'Making a new code…' : 'New code (the old one stops working)'}
          </button>
        </div>
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = known ?? pass.trim();
    if (p) void create(p);
  };
  return (
    <form className="qr-card large" onSubmit={submit}>
      <div className="qr-ph" aria-hidden />
      <div className="qr-text">
        <b>Adjuster on your phone</b>
        <span className="muted">Makes a demo adjuster for your phone. Scan the code and the adjuster screen opens signed in.</span>
        {!known && (
          <span className="qr-input">
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} aria-label="Staff passcode" placeholder="Staff passcode" autoComplete="off" />
          </span>
        )}
        {error && <span className="form-error small" role="alert">{error}</span>}
        <button className="btn" disabled={busy || (!known && !pass.trim())}>{busy ? 'Creating…' : 'Show code'}</button>
      </div>
    </form>
  );
}

// Header button → full-screen QR so people can scan it from their seats: the adjuster phone hand-off
// (default) or the policyholder check-in page.
export function QrButton({ household, region, db, members, managerName }: {
  household: HouseholdRow | null; region: RegionId; db: string; members: readonly Member[]; managerName: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'adjuster' | 'policyholder'>('adjuster');
  return (
    <>
      <button className="btn ghost-btn" onClick={() => setOpen(true)}>QR</button>
      {open && (
        <div className="modal-backdrop qr-backdrop" role="dialog" aria-modal="true" aria-label="QR code" onClick={() => setOpen(false)}>
          <div className="glass qr-modal" onClick={(e) => e.stopPropagation()}>
            <div className="segmented qr-kind" role="group" aria-label="QR code for">
              <button className={kind === 'adjuster' ? 'on' : ''} aria-pressed={kind === 'adjuster'} onClick={() => setKind('adjuster')}>Adjuster</button>
              <button className={kind === 'policyholder' ? 'on' : ''} aria-pressed={kind === 'policyholder'} onClick={() => setKind('policyholder')}>Policyholder</button>
            </div>
            {kind === 'adjuster'
              ? <AdjusterQr db={db} region={region} members={members} managerName={managerName} />
              : <LiveQrCard household={household} region={region} large />}
            <button className="btn" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </>
  );
}
