// "New random disaster", right of the Saviu brand on every region. The manager queues one request
// (request_new_disaster) and the demo Mac's worker for this database does the work. Corpus Christi and
// Bay Area replace their own map with their own kind of disaster; the sandbox offers both. Without a
// running worker a request only waits, so a map is locked by leaving its worker off.
// Progress is read only from the one-row disaster_request table: loading a world swaps the connection
// (LiveProvider's world watch shows "New scenario" and remounts everything), so nothing about the
// request may live in component state.
import { useEffect, useRef, useState } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings/index.ts';
import './random-disaster.css';

type Region = 'ca' | 'tx';
type Choice = { region: Region; label: string };
const CHOICES: Choice[] = [
  { region: 'ca', label: 'Earthquake · Bay Area' },
  { region: 'tx', label: 'Hurricane · Corpus Christi' },
];
const STALE_QUEUE_MS = 15_000; // queued this long with no loader picking it up
const LOADED_NOTE_MS = 20_000; // how long "New disaster loaded" stays after done
// Menu of the two disaster kinds, closed by an outside click or Escape.
function useMenu() {
  const [menu, setMenu] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);
  return { menu, setMenu, wrap };
}

function Menu({ onPick }: { onPick: (c: Choice) => void }) {
  return (
    <div className="glass rd-menu" role="menu" aria-label="New random disaster">
      {CHOICES.map((c) => <button key={c.region} type="button" role="menuitem" onClick={() => onPick(c)}>{c.label}</button>)}
    </div>
  );
}

function Confirm({ choice, body, action, onCancel, onConfirm }: { choice: Choice; body: string; action: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rd-title" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 id="rd-title">Replace this disaster?</h2>
        <p className="small muted">{choice.label}</p>
        <p>{body}</p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn primary" onClick={onConfirm}>{action}</button>
        </div>
      </div>
    </div>
  );
}

const SANDBOX_BODY = 'This generates a new hypothetical disaster and replaces the current one in this sandbox. Replies, assignments and chats are cleared. Members stay.';
const MAP_BODY = 'This generates a new hypothetical disaster and replaces the one on this map. Replies, assignments and chats are cleared. Members stay.';

// Queue the request and show its progress. only = this map's one kind of disaster (no menu).
export function RandomDisasterButton({ canControl, only, onNeedJoin }: { canControl: boolean; only?: Region; onNeedJoin: () => void }) {
  const [rows] = useTable(tables.disasterRequest);
  const req = rows[0];
  const request = useReducer(reducers.requestNewDisaster);
  const cancel = useReducer(reducers.cancelDisasterRequest);
  const { menu, setMenu, wrap } = useMenu();
  const [confirm, setConfirm] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

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

  const submit = async (region: Region) => {
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

  const open = () => {
    setError(null);
    if (!canControl) return onNeedJoin();
    const own = CHOICES.find((c) => c.region === only);
    if (own) setConfirm(own);
    else setMenu((m) => !m);
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
      {menu && <Menu onPick={(c) => { setMenu(false); setConfirm(c); }} />}
      {confirm && (
        <Confirm choice={confirm} body={only ? MAP_BODY : SANDBOX_BODY} action="Replace disaster" onCancel={() => setConfirm(null)}
          onConfirm={() => { const r = confirm.region; setConfirm(null); void submit(r); }} />
      )}
    </div>
  );
}
