import { useState, type FormEvent } from 'react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../module_bindings/index.ts';

// Self-assigned demo role. The passcode is typed here and sent once to `join_as`;
// it is never stored or bundled (the connection token keeps the role across reloads).
export function JoinDialog({ role, onDone, onCancel }: { role: 'manager' | 'adjuster'; onDone: () => void; onCancel?: () => void }) {
  const joinAs = useReducer(reducers.joinAs);
  const [name, setName] = useState('');
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await joinAs({ role, name: name.trim() || (role === 'manager' ? 'Manager' : 'Adjuster'), passcode });
      setPasscode('');
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
