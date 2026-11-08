// Policyholder "Disaster check-in" page (QR target): #/reply?h=<householdId>&code=<reply passcode>. No login.
// Mobile first (390×844), safe areas, 44 px targets. One red token (--brand-red) for small accents only;
// the one large red area is the full-width Call 911 after "Need help". Styles: ./reply/reply.css.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings/index.ts';
import { LiveProvider } from './LiveProvider';
import { initialLiveRegion, type RegionId } from './config';
import { ArrowUp, Camera, ChatIcon, ChevronLeft, More, PhoneIcon, Pin, Shield } from './reply/icons';
import './reply/reply.css';

const CODE_KEY = 'triage-reply-code'; // same key as the QR card on the dashboard
const MAX_TEXT = 500; // submit_raw_reply accepts 1..500 characters
const PLACE: Record<RegionId, string> = { tx: 'Corpus Christi', ca: 'the Bay Area', harbor: 'Harbor Bend' };
const BAD_LINK = "This link doesn't match a household in the current demo.";

type ChipId = 'ok' | 'help' | 'away';
// Quick replies go to submit_parsed_reply (no Claude parse needed); damage 255 = not described.
const CHIPS: { id: ChipId; label: string; safety: 'safe' | 'needs_help'; lifeSafety: boolean; notHome: boolean }[] = [
  { id: 'ok', label: "We're OK", safety: 'safe', lifeSafety: false, notHome: false },
  { id: 'help', label: 'Need help', safety: 'needs_help', lifeSafety: true, notHome: false },
  { id: 'away', label: 'Safe, not home', safety: 'safe', lifeSafety: false, notHome: true },
];

type Out = { id: number; text: string; chip?: ChipId; status: 'sending' | 'sent' | 'failed' };

function readCode(): string {
  try {
    return localStorage.getItem(CODE_KEY) ?? '';
  } catch {
    return '';
  }
}
function writeCode(v: string) {
  try {
    if (v) localStorage.setItem(CODE_KEY, v);
    else localStorage.removeItem(CODE_KEY);
  } catch {
    /* storage blocked: kept for this visit only */
  }
}

// "Today 5:21 AM" (or "Nov 7, 5:21 AM" on another day).
function fmtWhen(d: Date): string {
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return `Today ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

// Let the page draw under the notch / home indicator (safe-area paddings in reply.css), for this route only.
function useViewportFitCover() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta || meta.content.includes('viewport-fit')) return;
    const prev = meta.content;
    meta.content = `${prev}, viewport-fit=cover`;
    return () => {
      meta.content = prev;
    };
  }, []);
}

export function ReplyLive({ householdId, code }: { householdId: string | null; code: string }) {
  const region = useMemo(initialLiveRegion, []);
  useViewportFitCover();
  if (!householdId) return <BadLinkPage />;
  return (
    <LiveProvider screen="reply" db={region.db!}>
      <CheckIn householdId={householdId} urlCode={code} place={PLACE[region.id]} />
    </LiveProvider>
  );
}

function CheckIn({ householdId, urlCode, place }: { householdId: string; urlCode: string; place: string }) {
  const [rows, ready] = useTable(useMemo(() => tables.household.where((r) => r.id.eq(householdId)), [householdId]));
  const [worldRows] = useTable(tables.world);
  const [sentRows] = useTable(useMemo(() => tables.smsSent.where((r) => r.householdId.eq(householdId)), [householdId]));
  const submitParsed = useReducer(reducers.submitParsedReply);
  const submitRaw = useReducer(reducers.submitRawReply);

  const hazard = worldRows[0]?.hazardType === 'earthquake' ? 'earthquake' : 'hurricane';
  const known = rows.length > 0;
  const bad = ready && !known;

  // When the check-in text went out (its sms_sent row), else when this page opened.
  const openedAt = useMemo(() => new Date(), []);
  const sentAt = useMemo(
    () => sentRows.reduce<Date | null>((a, r) => { const d = r.ingestedAt.toDate(); return !a || d > a ? d : a; }, null),
    [sentRows],
  );

  const [code, setCode] = useState(() => urlCode || readCode());
  const [sheet, setSheet] = useState(false);
  const pending = useRef<((c: string) => void) | null>(null);
  const [out, setOut] = useState<Out[]>([]);
  const [text, setText] = useState('');
  const [demoNote, setDemoNote] = useState(false);
  const nextId = useRef(1);
  const end = useRef<HTMLDivElement>(null);

  const chipSending = out.find((m) => m.chip && m.status === 'sending')?.chip ?? null;
  const chipDone = out.some((m) => m.chip && m.status === 'sent');
  const helpSent = out.some((m) => m.chip === 'help' && m.status === 'sent');
  const lastSent = [...out].reverse().find((m) => m.status === 'sent')?.id;

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [out]);

  const setStatus = (id: number, status: Out['status']) => setOut((list) => list.map((m) => (m.id === id ? { ...m, status } : m)));

  // Every send carries the reply passcode; with none yet, the sheet asks for it first and then sends.
  const withCode = (run: (c: string) => void) => {
    if (code) return run(code);
    pending.current = run;
    setSheet(true);
  };

  const deliver = (m: Out, c: string) => {
    setStatus(m.id, 'sending');
    const chip = m.chip && CHIPS.find((x) => x.id === m.chip);
    const call = chip
      ? submitParsed({ householdId, safety: chip.safety, damage: 255, lifeSafety: chip.lifeSafety, needs: '', notHome: chip.notHome, text: chip.label, language: 'en', passcode: c })
      : submitRaw({ householdId, text: m.text, passcode: c });
    call
      .then(() => setStatus(m.id, 'sent'))
      .catch((err) => {
        setStatus(m.id, 'failed');
        // A wrong or missing passcode: forget it and ask again; saving retries this message.
        if (/passcode/i.test(err instanceof Error ? err.message : String(err))) {
          writeCode('');
          setCode('');
          pending.current = (c2) => deliver(m, c2);
          setSheet(true);
        }
      });
  };

  const tapChip = (id: ChipId) =>
    withCode((c) => {
      const m: Out = { id: nextId.current++, text: CHIPS.find((x) => x.id === id)!.label, chip: id, status: 'sending' };
      setOut((list) => [...list.filter((x) => !(x.chip && x.status === 'failed')), m]);
      deliver(m, c);
    });

  const sendText = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim().slice(0, MAX_TEXT);
    if (!t || !known) return;
    withCode((c) => {
      const m: Out = { id: nextId.current++, text: t, status: 'sending' };
      setOut((list) => [...list, m]);
      setText('');
      deliver(m, c);
    });
  };

  const saveCode = (v: string) => {
    writeCode(v);
    setCode(v);
    setSheet(false);
    const run = pending.current;
    pending.current = null;
    run?.(v);
  };

  return (
    <Page
      helpSent={helpSent}
      demoNote={demoNote}
      onCall911={() => setDemoNote(true)}
      onAddCode={() => { pending.current = null; setSheet(true); }}
      composer={{ text, setText, onSubmit: sendText, enabled: known }}
      sheet={sheet && <PasscodeSheet onSave={saveCode} onClose={() => { pending.current = null; setSheet(false); }} />}
    >
      {bad ? (
        <p className="rp-note" role="alert">{BAD_LINK}</p>
      ) : (
        <>
          <div className="rp-meta">
            <span className="rp-shield"><Shield /></span>
            <span>{hazard === 'earthquake' ? 'Earthquake' : 'Hurricane'} · {fmtWhen(sentAt ?? openedAt)}</span>
          </div>
          <div className="rp-bubble them">After the {hazard} in {place}, are you and your household safe?</div>
          {!chipDone && (
            <div className="rp-chips" role="group" aria-label="Quick replies">
              {CHIPS.map((c) => (
                <button key={c.id} type="button" className={`rp-chip${chipSending === c.id ? ' sending' : ''}`}
                  disabled={!known || chipSending !== null} onClick={() => tapChip(c.id)}>
                  {c.label}
                </button>
              ))}
            </div>
          )}
          {out.map((m) =>
            // A quick reply shows as a bubble once it has gone (or failed); while sending, its chip turns red.
            m.chip && m.status === 'sending' ? null : (
              <div key={m.id} className={`rp-out ${m.status}`}>
                  <div className="rp-bubble me">{m.text}</div>
                  {m.status === 'failed' && (
                    <button type="button" className="rp-retry" onClick={() => withCode((c) => deliver(m, c))}>Not sent. Try again.</button>
                  )}
                  {m.status === 'sent' && m.id === lastSent && <span className="rp-status" aria-live="polite">Received.</span>}
              </div>
            ),
          )}
        </>
      )}
      <div ref={end} />
    </Page>
  );
}

// No household id in the link: same frame, no connection needed.
function BadLinkPage() {
  const [demoNote, setDemoNote] = useState(false);
  return (
    <Page helpSent={false} demoNote={demoNote} onCall911={() => setDemoNote(true)} composer={{ text: '', setText: () => undefined, onSubmit: (e) => e.preventDefault(), enabled: false }}>
      <p className="rp-note" role="alert">{BAD_LINK}</p>
    </Page>
  );
}

function Page({ helpSent, demoNote, onCall911, onAddCode, composer, sheet, children }: {
  helpSent: boolean;
  demoNote: boolean;
  onCall911: () => void;
  onAddCode?: () => void;
  composer: { text: string; setText: (v: string) => void; onSubmit: (e: FormEvent) => void; enabled: boolean };
  sheet?: ReactNode;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState(false);
  const canSend = composer.enabled && composer.text.trim().length > 0;
  const note = demoNote && <p className="rp-demo" aria-live="polite">Demo only. No call placed.</p>;
  return (
    <div className="rp">
      <div className="rp-top">
        <header className="rp-head">
          <button type="button" className="rp-close" onClick={() => { if (window.history.length > 1) window.history.back(); }}>
            <ChevronLeft /> Close
          </button>
          <h1>Disaster check-in</h1>
          <button type="button" className="rp-more" aria-label="More" aria-expanded={menu} onClick={() => setMenu((v) => !v)} disabled={!onAddCode}>
            <More />
          </button>
        </header>
        {menu && onAddCode && (
          <div className="rp-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setMenu(false); onAddCode(); }}>Add demo passcode</button>
          </div>
        )}
        <div className="rp-sub">
          <span className="rp-auto"><ChatIcon /> Automated assistant</span>
          {!helpSent && (
            <button type="button" className="rp-911" onClick={onCall911}><PhoneIcon /> Call 911</button>
          )}
        </div>
        {!helpSent && note}
      </div>

      {helpSent && (
        <div className="rp-help" role="status">
          <button type="button" className="rp-911-solid" onClick={onCall911}><PhoneIcon size={22} /> Call 911</button>
          <p className="rp-help-title">Referral created</p>
          <p className="rp-help-sub">Call 911 now if anyone is in danger.</p>
          {note}
        </div>
      )}

      <main className="rp-thread">{children}</main>

      <form className="rp-composer" onSubmit={composer.onSubmit}>
        {/* Visual only in this demo: no camera or location permission prompts. */}
        <button type="button" className="rp-icon" aria-label="Add a photo (not available in this demo)" aria-disabled="true"><Camera /></button>
        <button type="button" className="rp-icon" aria-label="Share location (not available in this demo)" aria-disabled="true"><Pin /></button>
        <input className="rp-input" value={composer.text} onChange={(e) => composer.setText(e.target.value)} maxLength={MAX_TEXT}
          placeholder="Message" aria-label="Message" disabled={!composer.enabled} enterKeyHint="send" />
        <button type="submit" className={`rp-send${canSend ? ' on' : ''}`} disabled={!canSend} aria-label="Send"><ArrowUp /></button>
      </form>
      <footer className="rp-foot">Concept prototype for the State Farm challenge. Not the State Farm app.</footer>
      {sheet}
    </div>
  );
}

function PasscodeSheet({ onSave, onClose }: { onSave: (v: string) => void; onClose: () => void }) {
  const [v, setV] = useState('');
  return (
    <div className="rp-sheet-backdrop" onClick={onClose}>
      <form className="rp-sheet" role="dialog" aria-modal="true" aria-labelledby="rp-sheet-title"
        onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (v.trim()) onSave(v.trim()); }}>
        <span className="rp-grabber" aria-hidden="true" />
        <h2 id="rp-sheet-title">Add demo passcode</h2>
        <p className="rp-sheet-sub">Ask the demo team. It stays on this device.</p>
        <input className="rp-field" type="password" value={v} onChange={(e) => setV(e.target.value)} autoFocus autoComplete="off" aria-label="Demo passcode" />
        <div className="rp-sheet-actions">
          <button type="button" className="rp-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="rp-btn primary" disabled={!v.trim()}>Save</button>
        </div>
      </form>
    </div>
  );
}
