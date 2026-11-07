import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

// Points judges' phones at the policyholder SMS page.
export function QrCard() {
  const url = `${window.location.origin}${window.location.pathname}#/sms`;
  const [src, setSrc] = useState<string | null>(null);
  const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);

  useEffect(() => {
    QRCode.toDataURL(url, { margin: 0, width: 168, color: { dark: '#111111', light: '#ffffff' } })
      .then(setSrc)
      .catch(() => setSrc(null));
  }, [url]);

  return (
    <div className="qr-card">
      {src ? <img src={src} width={84} height={84} alt={`QR code for ${url}`} /> : <div className="qr-ph" />}
      <div className="qr-text">
        <b>Try it yourself</b>
        <span className="muted">Scan to reply as a policyholder. Your answer shows up on this map.</span>
        {local && <span className="warn-text">Open via the Network URL so phones can reach it.</span>}
      </div>
    </div>
  );
}
