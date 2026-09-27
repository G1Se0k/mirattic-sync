import React from 'react';
import ReactDOM from 'react-dom/client';
import { MEDIA_PROVIDERS } from '@mirattic/types';

function SidePanel() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <h1 style={{ fontSize: 18 }}>Mirattic Sync</h1>
      <p>Chat panel — coming in Phase 3/4.</p>
      <p>Providers: {MEDIA_PROVIDERS.join(', ')}</p>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SidePanel />
  </React.StrictMode>,
);
