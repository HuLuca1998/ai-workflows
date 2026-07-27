import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AppShell } from './AppShell.js';
import './styles.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </StrictMode>,
  );
}
