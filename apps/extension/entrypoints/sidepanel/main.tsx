import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { lang, subscribeLang } from '@mirattic/i18n';
import { followLang } from '../../lang';
import ReactDOM from 'react-dom/client';
import { App, configure } from '@mirattic/ui';
import { Consent, hasConsent } from './Consent';
import { connectPanel, holdWindow } from './panel';

// The side panel is a view: the background owns the session, the socket and the room's sync (plan.md
// decision 69), so closing the panel neither breaks the sync nor leaves the room.
let connected: ReturnType<typeof connectPanel> | undefined;
/** When this panel opened: as the page starts, before consent or anything else is waited for (decision 94). */
const openedAt = performance.timeOrigin + performance.now(); // finer than a millisecond: two windows' panels told apart
const held = holdWindow(openedAt); // which window has the side panel is decided even before consent

/** The language kept on this device, read before anything is drawn (decision 124). */
const langRead = followLang();
// The panel's own page says which language it's in (not a site's page: content scripts follow the choice too).
const markLang = () => void (document.documentElement.lang = lang());
void langRead.then(markLang);
subscribeLang(markLang);

function SidePanel() {
  const [state, setState] = useState<'loading' | 'consent' | 'ready'>('loading');
  useSyncExternalStore(subscribeLang, lang); // a language chosen: every screen drawn again in it

  const start = async () => {
    connected ??= connectPanel(openedAt); // once, despite StrictMode; tabs are looked at only after consent
    const { api, platform } = await connected;
    held.release(); // the real connection says the same from now on
    configure(api, platform);
    setState('ready');
  };

  useEffect(() => {
    void langRead.then(() => hasConsent()).then((ok) => (ok ? start() : setState('consent')));
  }, []);

  if (state === 'consent') return <Consent onAccept={start} />;
  return state === 'ready' ? <App /> : null;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SidePanel />
  </React.StrictMode>,
);
