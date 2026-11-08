import { useEffect, useState } from 'react';
import { ManagerView } from './views/ManagerView';
import { AdjusterView } from './views/AdjusterView';
import { SmsView } from './views/SmsView';
import { LabView } from './views/LabView';
import { RegionsView } from './regions/RegionsView';
import { MapPatterns } from './components/HexMap';

// Hash routes so the static build works anywhere:
//   #/          manager dashboard
//   #/adjuster  adjuster phone view
//   #/sms?h=ID  policyholder SMS page (QR target)
//   #/lab       map style variants side by side
//   #/regions   irregular disaster boundaries on real coastlines
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
  let view;
  if (path === '/adjuster') view = <AdjusterView />;
  else if (path === '/sms') view = <SmsView householdId={new URLSearchParams(query).get('h')} />;
  else if (path === '/lab') view = <LabView />;
  else if (path === '/regions') view = <RegionsView />;
  else view = <ManagerView />;
  return (
    <>
      <MapPatterns />
      {view}
    </>
  );
}
