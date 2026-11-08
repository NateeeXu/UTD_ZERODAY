import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useReducer, useSpacetimeDB } from 'spacetimedb/react';
import { reducers } from '../module_bindings/index.ts';

// Self-assigned demo role. The passcode is typed here and sent to `join_as`. It is never in the code,
// env or bundle. With "Remember on this device" (on by default) it is kept in this browser's
// localStorage only, so the screen can call `join_as` again by itself whenever its membership is gone
// (a database rebuild deletes the member table; the identity token survives, the role does not).
// The display name is remembered per database so rejoining by hand is quick too.
const joinedKey = (db: string, role: string) => `triage-joined-${role}-${db}`;
const savedKey = (role: string) => `triage-staff-login-${role}`;
type Role = 'manager' | 'adjuster';
type Saved = { name: string; passcode: string };

export function rememberedName(db: string | undefined, role: string): string | null {
  if (!db) return null;
  try {
    return localStorage.getItem(joinedKey(db, role));
  } catch {
    return null;
  }
}

function rememberName(db: string | undefined, role: string, name: string) {
  if (!db) return;
  try {
    localStorage.setItem(joinedKey(db, role), name);
  } catch {
    /* ignore */
  }
}

function readSaved(role: Role): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(savedKey(role)) ?? 'null');
    return v && typeof v.passcode === 'string' && v.passcode ? { name: String(v.name ?? ''), passcode: v.passcode } : null;
  } catch {
    return null;
  }
}

function writeSaved(role: Role, saved: Saved | null) {
  try {
    if (saved) localStorage.setItem(savedKey(role), JSON.stringify(saved));
    else localStorage.removeItem(savedKey(role));
  } catch {
    /* storage blocked: manual join only */
  }
}

const defaultName = (role: Role) => (role === 'manager' ? 'Manager' : 'Adjuster');

// Rejoin with the saved passcode when this identity is not a member of the database (after a rebuild,
// or the first visit to another region). One attempt per connection: a wrong passcode forgets the saved
// one (the dialog then asks again); any other error waits for the next reconnect.
// Returns true while a rejoin is still expected (connecting, or join_as in flight), so the screen can
// say "Rejoining…" instead of flashing the dialog.
export function useAutoRejoin(role: Role, db: string | undefined, isMember: boolean, ready: boolean): boolean {
  const joinAs = useReducer(reducers.joinAs);
  const { isActive } = useSpacetimeDB();
  const tried = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Re-arm after membership returns or the socket drops (a rebuild disconnects every client).
    if (isMember || !isActive) {
      tried.current = false;
      setFailed(false);
    }
  }, [isMember, isActive]);

  useEffect(() => {
    if (!db || !ready || !isActive || isMember || tried.current) return;
    const saved = readSaved(role);
    if (!saved) return;
    tried.current = true;
    const name = saved.name || rememberedName(db, role) || defaultName(role);
    joinAs({ role, name, passcode: saved.passcode })
      .then(() => rememberName(db, role, name))
      .catch((err) => {
        if (/wrong passcode/i.test(String(err instanceof Error ? err.message : err))) writeSaved(role, null);
        console.warn('Automatic rejoin failed', err);
        setFailed(true);
      });
  }, [db, ready, isActive, isMember, role, joinAs]);

  return !!db && !isMember && !failed && readSaved(role) !== null;
}

export function JoinDialog({ role, db, onDone, onCancel }: { role: Role; db?: string; onDone: () => void; onCancel?: () => void }) {
  const joinAs = useReducer(reducers.joinAs);
  const remembered = rememberedName(db, role);
  const [name, setName] = useState(remembered ?? readSaved(role)?.name ?? '');
  const [passcode, setPasscode] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const shown = name.trim() || defaultName(role);
      await joinAs({ role, name: shown, passcode });
      writeSaved(role, remember ? { name: shown, passcode } : null);
      setPasscode('');
      rememberName(db, role, shown);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="join-title">
      <form className="modal" onSubmit={submit}>
        <h2 id="join-title">Join as {role}</h2>
        <p className="muted small">
          {role === 'manager'
            ? 'Managers can run the replay and assign inspections.'
            : 'Adjusters see their assigned homes and file field reports.'}{' '}
          Ask the team for the staff passcode.
        </p>
        {remembered && (
          <p className="small warn-text">You joined this database before as {remembered}. That access was cleared (this happens when the database is rebuilt). Enter the passcode to rejoin.</p>
        )}
        <label className="field">
          <span>Your name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={role === 'manager' ? 'Dana' : 'J. Ortiz'} autoFocus />
        </label>
        <label className="field">
          <span>Staff passcode</span>
          <input type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoComplete="off" required />
        </label>
        <label className="check small">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>Remember on this device: rejoin automatically after a database rebuild (kept in this browser only)</span>
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
          <button className="btn primary" disabled={busy || !passcode}>{busy ? 'Joining…' : 'Join'}</button>
        </div>
      </form>
    </div>
  );
}
