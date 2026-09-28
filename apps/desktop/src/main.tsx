import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { App, configure } from "@mirattic/ui";
import { api, SOCKET_URL } from "./session";

// Desktop plays only mock rooms itself; real providers open in the user's browser, where the extension syncs.
configure(api, SOCKET_URL, {
  open: (url) => void (isTauri() ? openUrl(url) : window.open(url, "_blank", "noopener")),
  notify: (title, body) => void notify(title, body),
});

/** The OS asks once; a refusal just means no notifications (the lists still show everything). */
async function notify(title: string, body: string) {
  if (!isTauri()) {
    if ((await Notification.requestPermission()) === "granted") new Notification(title, { body });
    return;
  }
  if (await isPermissionGranted() || (await requestPermission()) === "granted") sendNotification({ title, body });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
