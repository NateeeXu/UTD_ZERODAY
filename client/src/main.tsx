import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { TriageProvider } from './state/TriageStore';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TriageProvider>
      <App />
    </TriageProvider>
  </StrictMode>,
);
