import { useEffect, useState, type ReactNode } from 'react';
import { ManagerLive } from './live/ManagerLive';
import { AdjusterLive } from './live/AdjusterLive';
import { ReplyLive } from './live/ReplyLive';
import { ManagerView } from './views/ManagerView';
import { AdjusterView } from './views/AdjusterView';
import { SmsView } from './views/SmsView';
import { LabView } from './views/LabView';
import { RegionsView } from './regions/RegionsView';
import { MapPatterns } from './components/HexMap';
import { TriageProvider } from './state/TriageStore';

// Hash routes so the static build works anywhere.
//   Live (SpacetimeDB):
//     #/                    manager dashboard
//     #/adjuster            adjuster phone
//     #/reply?h=ID&code=C   policyholder SMS page (QR target)
//   Local mode (browser-only replay of data/live.json, no backend):
//     #/local  #/local/adjuster  #/local/sms?h=ID
//   Design explorations:
//     #/lab  #/regions
function useHash() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

const Local = ({ children }: { children: ReactNode }) => (
  <TriageProvider>
    <MapPatterns />
    {children}
  </TriageProvider>
);

export function App() {
  const hash = useHash();
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const q = new URLSearchParams(query);
  switch (path) {
    case '/adjuster':
      return <AdjusterLive />;
    case '/reply':
    case '/sms':
      return <ReplyLive householdId={q.get('h')} code={q.get('code') ?? ''} />;
    case '/local':
      return <Local><ManagerView /></Local>;
    case '/local/adjuster':
      return <Local><AdjusterView /></Local>;
    case '/local/sms':
      return <Local><SmsView householdId={q.get('h')} /></Local>;
    case '/lab':
      return <Local><LabView /></Local>;
    case '/regions':
      return <RegionsView />;
    default:
      return <ManagerLive />;
  }
}
