import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { App, configure } from '@mirattic/ui';
import { api, SOCKET_URL } from './session';
import { Consent, hasConsent } from './Consent';
import { youtubeWatch } from './watch';

// The side panel page owns the socket: it lives exactly as long as the panel is open, which is when the
// user is watching together. The background service worker would be shut down after 30s without traffic.
let platform: ReturnType<typeof youtubeWatch> | undefined;

function SidePanel() {
  const [state, setState] = useState<'loading' | 'consent' | 'ready'>('loading');

  const start = async () => {
    platform ??= youtubeWatch(); // only now do we look at YouTube tabs; once, despite StrictMode
    configure(api, SOCKET_URL, await platform);
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
