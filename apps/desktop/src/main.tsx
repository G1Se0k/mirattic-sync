import React from "react";
import ReactDOM from "react-dom/client";
import { App, configure } from "@mirattic/ui";
import { api, SOCKET_URL } from "./session";

configure(api, SOCKET_URL);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
