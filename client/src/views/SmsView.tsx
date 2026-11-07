// Simulated policyholder SMS thread, opened from a QR code: #/sms?h=hh-0123
// Without ?h= it picks a household with a phone on file.
import { useMemo, useState, type ReactNode } from 'react';
import type { Damage } from '@shared/types';
import { useTriage } from '../state/TriageStore';

type Step = 'safety' | 'damage' | 'done';

export function SmsView({ householdId }: { householdId: string | null }) {
  const s = useTriage();
  const [step, setStep] = useState<Step>('safety');
  const [safety, setSafety] = useState<'safe' | 'needs_help' | null>(null);
  const [damage, setDamage] = useState<Damage | null>(null);

  const hh = useMemo(() => {
    if (householdId) return s.householdById.get(householdId) ?? null;
    const withPhone = [...s.householdById.values()].filter((h) => h.phoneOnFile);
    return withPhone.length ? withPhone[Math.floor(Math.random() * withPhone.length)] : null;
  }, [householdId, s.householdById]);

  if (!s.bundle) return <div className="loading">Loading…</div>;
  if (!hh) return <div className="loading">Unknown household.</div>;

  const answerSafety = (v: 'safe' | 'needs_help') => {
    setSafety(v);
    setStep('damage');
  };
  const answerDamage = (d: Damage) => {
    setDamage(d);
    setStep('done');
    s.inject({ kind: 'sms_reply', t: s.t, householdId: hh.id, safety: safety!, damage: d });
  };

  return (
    <div className="phone sms">
      <header className="phone-top">
        <strong>State Farm Alerts</strong>
        <span className="muted">demo · synthetic</span>
      </header>
      <div className="thread">
        <Bubble from="them">
          Hurricane check-in for your insured home. Are you safe? Reply SAFE or HELP.
        </Bubble>
        {safety && <Bubble from="me">{safety === 'safe' ? 'SAFE' : 'HELP'}</Bubble>}
        {safety === 'needs_help' && (
          <Bubble from="them">
            We've flagged your address for priority follow-up. If you are in immediate danger, call 911.
          </Bubble>
        )}
        {step !== 'safety' && (
          <Bubble from="them">
            How bad is the damage? Reply 0 (none), 1 (minor), 2 (severe), 3 (can't stay there).
          </Bubble>
        )}
        {damage != null && <Bubble from="me">{damage}</Bubble>}
        {step === 'done' && (
          <Bubble from="them">Thank you. Your reply has been shared with your claims team.</Bubble>
        )}
      </div>
      <div className="reply-bar">
        {step === 'safety' && (
          <>
            <button className="btn primary" onClick={() => answerSafety('safe')}>SAFE</button>
            <button className="btn danger" onClick={() => answerSafety('needs_help')}>HELP</button>
          </>
        )}
        {step === 'damage' &&
          ([0, 1, 2, 3] as Damage[]).map((d) => (
            <button key={d} className="btn" onClick={() => answerDamage(d)}>{d}</button>
          ))}
        {step === 'done' && <span className="muted">Reply sent · {hh.id}</span>}
      </div>
    </div>
  );
}

function Bubble({ from, children }: { from: 'me' | 'them'; children: ReactNode }) {
  return <div className={`bubble ${from}`}>{children}</div>;
}
