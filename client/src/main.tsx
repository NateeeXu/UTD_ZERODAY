import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { consumeAdjusterHandoff } from './live/config';
import './styles.css';

consumeAdjusterHandoff();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
