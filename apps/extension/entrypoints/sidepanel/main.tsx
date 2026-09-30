import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { App, configure } from '@mirattic/ui';
import { Consent, hasConsent } from './Consent';
import { connectPanel } from './panel';

// The side panel is a view: the background owns the session, the socket and the room's sync (plan.md
// decision 69), so closing the panel neither breaks the sync nor leaves the room.
let connected: ReturnType<typeof connectPanel> | undefined;

function SidePanel() {
  const [state, setState] = useState<'loading' | 'consent' | 'ready'>('loading');

  const start = async () => {
    connected ??= connectPanel(); // once, despite StrictMode; tabs are looked at only after consent
    const { api, platform } = await connected;
    configure(api, platform);
    setState('ready');
  };

  useEffect(() => {
    hasConsent().then((ok) => (ok ? start() : setState('consent')));
  }, []);

  if (state === 'consent') return <Consent onAccept={start} />;
  return state === 'ready' ? <App /> : null;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SidePanel />
  </React.StrictMode>,
);
