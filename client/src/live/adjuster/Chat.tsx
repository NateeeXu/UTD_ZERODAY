// Adjuster and policyholder thread for one household.
// The backend inserts every chat row (send_chat_message); nothing is added locally.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../../module_bindings/index.ts';
import { resetPageScroll, useVisualViewport } from '../useVisualViewport';
import { useChatThread, type ChatRow } from './data';
import { Icon } from './icons';

const MAX = 500;

const fmtClock = (r: ChatRow) => r.createdAt.toDate().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const codePoints = (s: string) => [...s].length;

export function ChatScreen({ householdId, label, meName, live, canSend, onBack }: {
  householdId: string; label: string; meName: string; live: React.ReactNode; canSend: boolean; onBack: () => void;
}) {
  const { rows, ready } = useChatThread(householdId);
  const send = useReducer(reducers.sendChatMessage);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendSeq = useRef(0); // a late answer to an earlier Send must not unlock a newer one
  useVisualViewport(pageRef); // header on top, composer just above the keyboard

  // Stay at the newest message.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length, ready]);
  // ...also when the thread gets shorter (keyboard opens, the box grows, a warning shows), unless scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let pinned = true;
    const onScroll = () => { pinned = el.scrollHeight - el.clientHeight - el.scrollTop < 48; };
    const ro = new ResizeObserver(() => { if (pinned) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener('scroll', onScroll); };
  }, []);
  // Grow the input up to about four lines.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 120)}px`; // + the 1 px borders (border-box)
    // No scrollbar until the text actually outgrows the 120 px cap.
    el.style.overflowY = el.scrollHeight + 2 > 120 ? 'auto' : 'hidden';
  }, [text]);

  const body = text.trim();
  const n = codePoints(body);
  const ok = n >= 1 && n <= MAX && !sending;
  const submit = async () => {
    if (!ok) return;
    if (!canSend) { setError('Not sent: offline'); return; }
    const sentText = text;
    const seq = ++sendSeq.current;
    const latest = () => sendSeq.current === seq;
    setSending(true);
    setError(null);
    // A stalled connection can leave the call hanging: after 10 s unlock Send and keep the text.
    const timer = setTimeout(() => { if (latest()) { setSending(false); setError('No response yet. Check the thread before resending.'); } }, 10_000);
    try {
      // Resolves once the server's reply has put the new chat_message row in the local cache, so the thread
      // already shows it: nothing else to wait for.
      await send({ householdId, text: body });
      setText((cur) => (cur === sentText ? '' : cur)); // kept if edited meanwhile
      if (latest()) setError(null);
    } catch (e) {
      if (latest()) setError(`Not sent: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
      if (latest()) setSending(false);
      resetPageScroll();
    }
  };

  return (
    <div className="adj-page adj-chat" ref={pageRef} aria-label={`Messages with ${label}`}>
      <header className="adj-topbar">
        <button type="button" className="adj-circle t44" aria-label="Back" onClick={onBack}><Icon name="back" size={18} stroke={2.2} /></button>
        <div className="center"><strong>{label}</strong><span>Policyholder</span></div>
        {live}
      </header>

      <div className="adj-thread" ref={scrollRef} aria-live="polite">
        {!ready && rows.length === 0 && <span className="adj-muted adj-thread-empty">Loading…</span>}
        {ready && rows.length === 0 && <span className="adj-muted adj-thread-empty">No messages yet.</span>}
        {rows.map((m, i) => {
          const mine = m.sender === 'adjuster' && m.senderName === meName;
          const who = m.sender === 'system' ? 'Automated assistant'
            : m.sender === 'policyholder' ? 'Policyholder'
            : mine ? 'You' : m.senderName || 'Adjuster';
          const prev = rows[i - 1];
          const sameAsPrev = !!prev && prev.sender === m.sender && prev.senderName === m.senderName;
          return (
            <div key={String(m.id)} className={`adj-msg ${mine ? 'mine' : m.sender}`}>
              {!sameAsPrev && <span className="adj-msg-who">{who}, {fmtClock(m)}</span>}
              <p className="adj-bubble">{m.text}</p>
            </div>
          );
        })}
      </div>

      <footer className="adj-pagefoot adj-compose">
        {/* amber, not red: red is only for 911 */}
        {error && <p className="adj-warn" role="alert">{error}</p>}
        <span className="adj-caption">No arrival times or payment promises</span>
        <div className="adj-compose-row">
          <textarea
            ref={inputRef} className="adj-note adj-compose-input" rows={1} maxLength={MAX} value={text}
            placeholder="Message" aria-label={`Message to ${label}`}
            onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}
          />
          <button type="button" className="adj-btn dark adj-send" aria-label={sending ? 'Sending' : 'Send'} disabled={!ok} onClick={() => void submit()}>
            {sending ? <span className="adj-spin" /> : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
            )}
          </button>
        </div>
        {n > MAX - 100 && <span className="adj-muted adj-count">{n}/{MAX}</span>}
      </footer>
    </div>
  );
}
