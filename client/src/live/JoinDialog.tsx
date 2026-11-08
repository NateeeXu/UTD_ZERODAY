import { useState, type FormEvent } from 'react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../module_bindings/index.ts';

// Self-assigned demo role. The passcode is typed here and sent once to `join_as`;
// it is never stored or bundled (the connection token keeps the role across reloads).
// The display name is remembered per database so rejoining after a database rebuild is quick.
const joinedKey = (db: string, role: string) => `triage-joined-${role}-${db}`;
export function rememberedName(db: string | undefined, role: string): string | null {
  if (!db) return null;
  try {
    return localStorage.getItem(joinedKey(db, role));
  } catch {
    return null;
  }
}

export function JoinDialog({ role, db, onDone, onCancel }: { role: 'manager' | 'adjuster'; db?: string; onDone: () => void; onCancel?: () => void }) {
  const joinAs = useReducer(reducers.joinAs);
  const remembered = rememberedName(db, role);
  const [name, setName] = useState(remembered ?? '');
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const shown = name.trim() || (role === 'manager' ? 'Manager' : 'Adjuster');
      await joinAs({ role, name: shown, passcode });
      setPasscode('');
      if (db) {
        try {
          localStorage.setItem(joinedKey(db, role), shown);
        } catch {
          /* ignore */
        }
      }
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
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
          <button className="btn primary" disabled={busy || !passcode}>{busy ? 'Joining…' : 'Join'}</button>
        </div>
      </form>
    </div>
  );
}
