// "New random disaster" for the dev sandbox (?region=harbor). The manager queues one request
// (request_new_disaster); a worker on the demo Mac generates the disaster and loads it into this database.
// Progress lives in the one-row disaster_request table: loading a world swaps the connection
// (LiveProvider's world watch shows "New scenario" and remounts everything), so nothing about the
// request may be kept in component state. Mounted only for the dev region; tx / ca have no such table.
import { useEffect, useRef, useState } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings/index.ts';
import './random-disaster.css';

type Choice = { region: 'ca' | 'tx'; label: string };
const CHOICES: Choice[] = [
  { region: 'ca', label: 'Earthquake · Bay Area' },
  { region: 'tx', label: 'Hurricane · Corpus Christi' },
];
const STALE_QUEUE_MS = 15_000; // queued this long with no loader picking it up
const LOADED_NOTE_MS = 20_000; // how long "New disaster loaded" stays after done

export function RandomDisasterButton({ canControl, onNeedJoin }: { canControl: boolean; onNeedJoin: () => void }) {
  const [rows] = useTable(tables.disasterRequest);
  const req = rows[0];
  const request = useReducer(reducers.requestNewDisaster);
  const cancel = useReducer(reducers.cancelDisasterRequest);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const wrap = useRef<HTMLDivElement>(null);

  // Close the menu on a click outside it, or on Escape.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  const status = req?.status ?? '';
  const updated = req ? req.updatedAt.toDate().getTime() : 0;
  const queued = status === 'queued';
  const running = status === 'running';
  // Tick only while a time-based note can still change (stale queue, fresh "loaded").
  const ticking = queued || (status === 'done' && now - updated < LOADED_NOTE_MS);
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  const open = () => {
    setError(null);
    if (!canControl) return onNeedJoin();
    setMenu((m) => !m);
  };

  const replace = async () => {
    if (!confirm) return;
    const { region } = confirm;
    setConfirm(null);
    setBusy(true);
    setError(null);
    try {
      await request({ region });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async () => {
    setError(null);
    try {
      await cancel();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const label = queued ? 'Waiting for loader…' : running ? 'Loading new disaster…' : 'New random disaster';
  const note = queued
    ? now - updated > STALE_QUEUE_MS ? 'The loader is not responding. Start it on the demo Mac, or cancel.' : null
    : status === 'done' && now - updated < LOADED_NOTE_MS
      ? 'New disaster loaded. Press Start.'
      : status === 'failed'
        ? `Could not load: ${req!.error || 'unknown error'}`
        : null;

  return (
    <div className="rd-wrap" ref={wrap}>
      <button type="button" className="btn ghost-btn rd-btn" disabled={queued || running || busy} onClick={open}
        aria-haspopup="menu" aria-expanded={menu}>
        {busy ? 'Requesting…' : label}
      </button>
      {queued && <button type="button" className="link small rd-cancel" onClick={() => void doCancel()}>Cancel</button>}
      {(error || note) && (
        <span className={`small rd-note${error || status === 'failed' ? ' bad' : status === 'done' ? ' ok' : ''}`} role="status" title={error ?? note ?? undefined}>
          {error ?? note}
        </span>
      )}

      {menu && (
        <div className="glass rd-menu" role="menu" aria-label="New random disaster">
          {CHOICES.map((c) => (
            <button key={c.region} type="button" role="menuitem" onClick={() => { setMenu(false); setConfirm(c); }}>{c.label}</button>
          ))}
        </div>
      )}

      {confirm && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rd-title" onClick={() => setConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 id="rd-title">Replace this disaster?</h2>
            <p className="small muted">{confirm.label}</p>
            <p>This generates a new hypothetical disaster and replaces the current one in this sandbox. Replies, assignments and chats are cleared. Members stay.</p>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className="btn primary" onClick={() => void replace()}>Replace disaster</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
