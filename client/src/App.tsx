import { useEffect, useState } from 'react';
import { ManagerView } from './views/ManagerView';
import { AdjusterView } from './views/AdjusterView';
import { SmsView } from './views/SmsView';

// Hash routes so the static build works anywhere:
//   #/          manager dashboard
//   #/adjuster  adjuster phone view
//   #/sms?h=ID  policyholder SMS page (QR target)
function useHash() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  if (path === '/adjuster') return <AdjusterView />;
  if (path === '/sms') return <SmsView householdId={new URLSearchParams(query).get('h')} />;
  return <ManagerView />;
}
