import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { HouseholdRow } from './rows';

const CODE_KEY = 'triage-reply-code';

// QR for judges: opens the policyholder SMS page for one household. The reply passcode
// may travel in this link (it only allows SMS replies); the staff passcode never does.
export function LiveQrCard({ household }: { household: HouseholdRow | null }) {
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
  const url = household && code
    ? `${window.location.origin}${window.location.pathname}${window.location.search}#/reply?h=${encodeURIComponent(household.id)}&code=${encodeURIComponent(code)}`
    : null;

  useEffect(() => {
    if (!url) return setSrc(null);
    QRCode.toDataURL(url, { margin: 0, width: 168, color: { dark: '#111111', light: '#ffffff' } }).then(setSrc).catch(() => setSrc(null));
  }, [url]);

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
      <form className="qr-card" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) save(draft.trim()); }}>
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
    <div className="qr-card">
      {src ? <a href={url!} target="_blank" rel="noreferrer"><img src={src} width={84} height={84} alt="QR code for the policyholder SMS page" /></a> : <div className="qr-ph" />}
      <div className="qr-text">
        <b>Try it yourself</b>
        <span className="muted">Scan to reply as a policyholder in the quietest hard-hit area.</span>
        {local && <span className="warn-text">Open via the Network URL so phones can reach it.</span>}
        <button className="link muted small" onClick={() => save('')}>Change passcode</button>
      </div>
    </div>
  );
}
