import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { App, configure } from "@mirattic/ui";
import { api, SOCKET_URL } from "./session";

// Desktop plays only mock rooms itself; real providers open in the user's browser, where the extension syncs.
configure(api, SOCKET_URL, {
  open: (url) => void (isTauri() ? openUrl(url) : window.open(url, "_blank", "noopener")),
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
