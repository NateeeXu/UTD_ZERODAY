// Policyholder SMS page (QR target): #/reply?h=<householdId>&code=<reply passcode>. No login.
import { useMemo, useState, type ReactNode } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings/index.ts';
import { LiveProvider } from './LiveProvider';
import { initialLiveRegion } from './config';

export function ReplyLive({ householdId, code }: { householdId: string | null; code: string }) {
  const region = useMemo(initialLiveRegion, []);
  if (!householdId) {
    return (
      <div className="phone sms">
        <header className="phone-top"><strong>State Farm Alerts</strong><span className="muted small">demo · synthetic</span></header>
        <p className="muted pad">Open this page from the QR code on the demo screen.</p>
      </div>
    );
  }
  return (
    <LiveProvider screen="reply" db={region.db!}>
      <ReplyThread householdId={householdId} code={code} />
    </LiveProvider>
  );
}

type Step = 'safety' | 'damage' | 'sending' | 'done';
const MISSING_TEXT = 'Someone in my household is unaccounted for';

function ReplyThread({ householdId, code }: { householdId: string; code: string }) {
  const [rows, ready] = useTable(tables.household.where((r) => r.id.eq(householdId)));
  const [worldRows] = useTable(tables.world);
  const hazard = worldRows[0]?.hazardType === 'earthquake' ? 'Earthquake' : 'Hurricane';
  const submit = useReducer(reducers.submitSmsReply);
  const submitText = useReducer(reducers.submitSmsTextReply);
  const [missing, setMissing] = useState(false); // "Someone in my household is unaccounted for"
  const [step, setStep] = useState<Step>('safety');
  const [safety, setSafety] = useState<'safe' | 'needs_help' | null>(null);
  const [damage, setDamage] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const answerDamage = async (d: number) => {
    setDamage(d);
    setStep('sending');
    setError(null);
    try {
      if (missing) await submitText({ householdId, safety: 'needs_help', damage: d, text: MISSING_TEXT, language: 'en', passcode: code });
      else await submit({ householdId, safety: safety!, damage: d, passcode: code });
      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('damage');
    }
  };

  const known = rows.length > 0;
  return (
    <div className="phone sms">
      <header className="phone-top"><strong>State Farm Alerts</strong><span className="muted small">demo · synthetic</span></header>
      <div className="thread">
        {ready && !known && <p className="form-error small">This link doesn't match a household in the current demo.</p>}
        <Bubble from="them">{hazard} check-in for your insured home. Are you safe? Reply SAFE or HELP.</Bubble>
        {safety && <Bubble from="me">{missing ? MISSING_TEXT : safety === 'safe' ? 'SAFE' : 'HELP'}</Bubble>}
        {safety === 'needs_help' && (
          <Bubble from="them">
            {missing
              ? "We've flagged your household for priority follow-up and will help locate them. If anyone is in immediate danger, call 911."
              : "We've flagged your address for priority follow-up. If you are in immediate danger, call 911."}
          </Bubble>
        )}
        {step !== 'safety' && <Bubble from="them">How bad is the damage? Reply 0 (none), 1 (minor), 2 (severe), 3 (can't stay there).</Bubble>}
        {damage != null && step !== 'damage' && <Bubble from="me">{damage}</Bubble>}
        {step === 'done' && <Bubble from="them">Thank you. Your reply has been shared with your claims team.</Bubble>}
        {error && <p className="form-error small">Couldn't send: {error}</p>}
      </div>
      <div className="reply-bar">
        {step === 'safety' && (
          <div className="reply-choices">
            <button className="btn primary" onClick={() => { setSafety('safe'); setStep('damage'); }}>SAFE</button>
            <button className="btn danger" onClick={() => { setSafety('needs_help'); setStep('damage'); }}>HELP</button>
            <button className="btn wide" onClick={() => { setMissing(true); setSafety('needs_help'); setStep('damage'); }}>Someone in my household is unaccounted for</button>
          </div>
        )}
        {step === 'damage' && [0, 1, 2, 3].map((d) => <button key={d} className="btn" onClick={() => answerDamage(d)}>{d}</button>)}
        {step === 'sending' && <span className="muted">Sending…</span>}
        {step === 'done' && <span className="muted small">Reply sent</span>}
      </div>
    </div>
  );
}

function Bubble({ from, children }: { from: 'me' | 'them'; children: ReactNode }) {
  return <div className={`bubble ${from}`}>{children}</div>;
}
