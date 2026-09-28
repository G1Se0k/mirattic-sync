import React from 'react';
import ReactDOM from 'react-dom/client';
import { App, configure } from '@mirattic/ui';
import { api, SOCKET_URL } from './session';

// The side panel page owns the socket: it lives exactly as long as the panel is open, which is when the
// user is watching together. The background service worker would be shut down after 30s without traffic.
configure(api, SOCKET_URL);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
