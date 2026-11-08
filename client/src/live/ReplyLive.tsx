// Policyholder "Disaster check-in" page (QR target): #/reply?h=<householdId>&code=<reply passcode>. No login.
// Mobile first (390×844), safe areas, 44 px targets. One red token (--brand-red) for small accents only;
// the one large red area is the full-width Call 911 after "Need help". Styles: ./reply/reply.css.
//
// The thread is this household's chat_message rows (subscribed by householdId, sorted by id): automatic
// notices, the assigned adjuster and the policyholder's typed replies. submit_raw_reply writes the typed
// reply into chat_message itself, so typed text is never added locally. Quick replies go through
// submit_parsed_reply, which does not write chat_message, so they keep a local bubble placed after the
// last chat row that existed when the chip was tapped.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import type { Infer } from 'spacetimedb';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings/index.ts';
import type ChatMessageRowDef from '../module_bindings/chat_message_table.ts';
import { LiveProvider } from './LiveProvider';
import { initialLiveRegion, type RegionId } from './config';
import { useVisualViewport } from './useVisualViewport';
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

type ChatRow = Infer<typeof ChatMessageRowDef>;
// A quick reply (local only). after = id of the newest chat row when it was sent, for its place in the thread.
type ChipOut = { key: number; chip: ChipId; text: string; status: 'sending' | 'sent' | 'failed'; after: bigint };
type SendState = 'idle' | 'sending' | 'failed';
// Where "Received." goes: under a quick-reply bubble, or under the chat row that a typed reply produced.
type Received = { chip: number } | { text: string; after: bigint };
type Item = { kind: 'row'; row: ChatRow } | { kind: 'chip'; m: ChipOut };

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

const byId = (a: ChatRow, b: ChatRow) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const isPasscodeError = (err: unknown) => /passcode/i.test(err instanceof Error ? err.message : String(err));

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
  const [chatRows] = useTable(useMemo(() => tables.chatMessage.where((r) => r.householdId.eq(householdId)), [householdId]));
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

  const chat = useMemo(() => [...chatRows].sort(byId), [chatRows]);
  const lastChatId = chat.length ? chat[chat.length - 1].id : 0n;
  const lastChat = useRef(0n); // read by send handlers, which may run from an older render (passcode sheet)
  useEffect(() => {
    lastChat.current = lastChatId;
  }, [lastChatId]);

  const [code, setCode] = useState(() => urlCode || readCode());
  const [sheet, setSheet] = useState(false);
  const pending = useRef<((c: string) => void) | null>(null);
  const [chips, setChips] = useState<ChipOut[]>([]);
  const [text, setText] = useState('');
  const [send, setSend] = useState<SendState>('idle');
  const [received, setReceived] = useState<Received | null>(null);
  const nextKey = useRef(1);

  const chipSending = chips.find((m) => m.status === 'sending')?.chip ?? null;
  const chipDone = chips.some((m) => m.status === 'sent');
  const helpSent = chips.some((m) => m.chip === 'help' && m.status === 'sent');

  // One chronological thread: chat rows by id, each quick-reply bubble after the row that was newest when it
  // was sent. A quick reply that is still sending shows as its red chip, not as a bubble.
  const items = useMemo(() => {
    const local = chips
      .filter((m) => m.status !== 'sending')
      .sort((a, b) => (a.after === b.after ? a.key - b.key : a.after < b.after ? -1 : 1));
    const list: Item[] = [];
    let i = 0;
    for (const row of chat) {
      while (i < local.length && local[i].after < row.id) list.push({ kind: 'chip', m: local[i++] });
      list.push({ kind: 'row', row });
    }
    while (i < local.length) list.push({ kind: 'chip', m: local[i++] });
    return list;
  }, [chat, chips]);

  const receivedRow = useMemo(() => {
    if (!received || !('text' in received)) return null;
    return chat.find((r) => r.sender === 'policyholder' && r.id > received.after && r.text === received.text)?.id ?? null;
  }, [chat, received]);

  // Page scrolls to the newest message whenever this changes (a new row, e.g. an adjuster's message arriving
  // while the page is open, a quick reply's status, a send starting). '' until there is a message.
  const lastItem = items[items.length - 1];
  const scrollKey = lastItem
    ? [lastItem.kind === 'row' ? `r${lastItem.row.id}` : `c${lastItem.m.key}${lastItem.m.status}`, items.length, send, chipSending, receivedRow,
        received && 'chip' in received ? received.chip : ''].join('|')
    : '';

  const patchChip = (key: number, p: Partial<ChipOut>) => setChips((list) => list.map((m) => (m.key === key ? { ...m, ...p } : m)));

  // Every send carries the reply passcode; with none yet, the sheet asks for it first and then sends.
  const withCode = (run: (c: string) => void) => {
    if (code) return run(code);
    pending.current = run;
    setSheet(true);
  };

  // A wrong or missing passcode: forget it and ask again; saving retries the send.
  const askAgain = (retry: (c: string) => void) => {
    writeCode('');
    setCode('');
    pending.current = retry;
    setSheet(true);
  };

  const deliverChip = (m: ChipOut, c: string) => {
    patchChip(m.key, { status: 'sending', after: lastChat.current });
    const chip = CHIPS.find((x) => x.id === m.chip)!;
    submitParsed({ householdId, safety: chip.safety, damage: 255, lifeSafety: chip.lifeSafety, needs: '', notHome: chip.notHome, text: chip.label, language: 'en', passcode: c })
      .then(() => {
        patchChip(m.key, { status: 'sent' });
        setReceived({ chip: m.key });
      })
      .catch((err) => {
        patchChip(m.key, { status: 'failed' });
        if (isPasscodeError(err)) askAgain((c2) => deliverChip(m, c2));
      });
  };

  const tapChip = (id: ChipId) =>
    withCode((c) => {
      const m: ChipOut = { key: nextKey.current++, text: CHIPS.find((x) => x.id === id)!.label, chip: id, status: 'sending', after: lastChat.current };
      setChips((list) => [...list.filter((x) => x.status !== 'failed'), m]);
      deliverChip(m, c);
    });

  // Typed text stays in the composer until the server has it; its chat_message row then appears in the thread.
  const deliverText = (t: string, c: string) => {
    setSend('sending');
    const after = lastChat.current;
    submitRaw({ householdId, text: t, passcode: c })
      .then(() => {
        setSend('idle');
        setText((cur) => (cur.trim() === t ? '' : cur));
        setReceived({ text: t, after });
      })
      .catch((err) => {
        setSend('failed');
        if (isPasscodeError(err)) askAgain((c2) => deliverText(t, c2));
      });
  };

  const sendText = (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim().slice(0, MAX_TEXT);
    if (!t || !known || send === 'sending') return;
    withCode((c) => deliverText(t, c));
  };

  const editText = (v: string) => {
    setText(v);
    if (send === 'failed') setSend('idle');
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
      scrollKey={scrollKey}
      onAddCode={() => { pending.current = null; setSheet(true); }}
      composer={{ text, setText: editText, onSubmit: sendText, onRetry: () => sendText(), enabled: known, state: send }}
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
          <div className="rp-log" role="log" aria-label="Messages">
            {items.map((it) =>
              it.kind === 'row' ? (
                <ChatBubble key={`r${it.row.id}`} row={it.row} received={it.row.id === receivedRow} />
              ) : (
                <div key={`c${it.m.key}`} className={`rp-out ${it.m.status}`}>
                  <div className="rp-bubble me">{it.m.text}</div>
                  {it.m.status === 'failed' && (
                    <button type="button" className="rp-retry" onClick={() => withCode((c) => deliverChip(it.m, c))}>Not sent. Try again.</button>
                  )}
                  {it.m.status === 'sent' && received && 'chip' in received && received.chip === it.m.key && (
                    <span className="rp-status" aria-live="polite">Received.</span>
                  )}
                </div>
              ),
            )}
          </div>
        </>
      )}
    </Page>
  );
}

// system -> "Automated assistant" and adjuster -> their name, both on the left with a label; policyholder on the right.
function ChatBubble({ row, received }: { row: ChatRow; received: boolean }) {
  if (row.sender === 'policyholder') {
    return (
      <div className="rp-out">
        <div className="rp-bubble me">{row.text}</div>
        {received && <span className="rp-status" aria-live="polite">Received.</span>}
      </div>
    );
  }
  const from = row.sender === 'adjuster' ? row.senderName.trim() || 'Adjuster' : 'Automated assistant';
  return (
    <div className="rp-msg">
      <span className="rp-from">{from}</span>
      <div className="rp-bubble them">{row.text}</div>
    </div>
  );
}

// No household id in the link: same frame, no connection needed.
function BadLinkPage() {
  return (
    <Page helpSent={false} composer={{ text: '', setText: () => undefined, onSubmit: (e) => e.preventDefault(), onRetry: () => undefined, enabled: false, state: 'idle' }}>
      <p className="rp-note" role="alert">{BAD_LINK}</p>
    </Page>
  );
}

type Composer = {
  text: string;
  setText: (v: string) => void;
  onSubmit: (e: FormEvent) => void;
  onRetry: () => void;
  enabled: boolean;
  state: SendState;
};

// Keeps the thread on its newest message: jumps there when the first messages load, glides there when `key`
// changes, and stays there through later layout changes (web font swap, the help band, the phone keyboard)
// unless the reader has scrolled up.
function useStickToBottom(thread: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, key: string | undefined) {
  const pinned = useRef(true);
  const autoUntil = useRef(0); // while our own smooth scroll runs, its scroll events don't unpin
  const loaded = useRef(false);
  useEffect(() => {
    const t = thread.current;
    const c = content.current;
    if (!t || !c) return;
    const onScroll = () => {
      if (performance.now() < autoUntil.current) return;
      pinned.current = t.scrollHeight - t.clientHeight - t.scrollTop < 48;
    };
    const ro = new ResizeObserver(() => {
      if (pinned.current || performance.now() < autoUntil.current) t.scrollTop = t.scrollHeight;
    });
    ro.observe(t);
    ro.observe(c);
    t.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      t.removeEventListener('scroll', onScroll);
    };
  }, [thread, content]);
  useEffect(() => {
    const t = thread.current;
    if (!t || key === undefined) return;
    const smooth = loaded.current && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (key) loaded.current = true;
    pinned.current = true;
    autoUntil.current = smooth ? performance.now() + 800 : 0;
    t.scrollTo({ top: t.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, [thread, key]);
}

// Call 911 is visual only in this demo: it never dials and shows no message.
function Page({ helpSent, scrollKey, onAddCode, composer, sheet, children }: {
  helpSent: boolean;
  scrollKey?: string;
  onAddCode?: () => void;
  composer: Composer;
  sheet?: ReactNode;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useStickToBottom(threadRef, contentRef, scrollKey);
  useVisualViewport(pageRef); // header on top, composer just above the phone keyboard
  const sending = composer.state === 'sending';
  const canSend = composer.enabled && !sending && composer.text.trim().length > 0;
  return (
    <div className="rp" ref={pageRef}>
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
            <button type="button" className="rp-911"><PhoneIcon /> Call 911</button>
          )}
        </div>
      </div>

      {helpSent && (
        <div className="rp-help" role="status">
          <button type="button" className="rp-911-solid"><PhoneIcon size={22} /> Call 911</button>
          <p className="rp-help-title">Referral created</p>
          <p className="rp-help-sub">Call 911 now if anyone is in danger.</p>
        </div>
      )}

      <main className="rp-thread" ref={threadRef}>
        <div className="rp-thread-in" ref={contentRef}>{children}</div>
      </main>

      {/* Typed reply state, just above the composer: "Sending…" while the server has not answered, or a retry. */}
      <div className="rp-compose-note" role="status">
        {sending && <span className="rp-status">Sending…</span>}
        {composer.state === 'failed' && (
          <button type="button" className="rp-retry" onClick={composer.onRetry}>Not sent. Try again.</button>
        )}
      </div>
      <form className="rp-composer" onSubmit={composer.onSubmit} aria-busy={sending}>
        {/* Visual only in this demo: no camera or location permission prompts. */}
        <button type="button" className="rp-icon" aria-label="Add a photo (not available in this demo)" aria-disabled="true"><Camera /></button>
        <button type="button" className="rp-icon" aria-label="Share location (not available in this demo)" aria-disabled="true"><Pin /></button>
        <input className="rp-input" value={composer.text} onChange={(e) => composer.setText(e.target.value)} maxLength={MAX_TEXT}
          placeholder="Message" aria-label="Message" disabled={!composer.enabled} enterKeyHint="send" />
        <button type="submit" className={`rp-send${canSend ? ' on' : ''}`} disabled={!canSend} aria-label={sending ? 'Sending' : 'Send'}><ArrowUp /></button>
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
