import { invoke, isTauri } from "@tauri-apps/api/core";
import { createApi, socketUrl, type RefreshTokenStore } from "@mirattic/client";

export const API_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:8080";
export const SOCKET_URL = socketUrl(API_URL);

// In the Tauri app the refresh token goes to the OS keychain. Plain browser dev (vite on :1420)
// falls back to sessionStorage so two tabs can act as two users.
const store: RefreshTokenStore = isTauri()
  ? {
      load: () => invoke<string | null>("refresh_token_load"),
      save: (token) => invoke("refresh_token_save", { token }),
    }
  : {
      load: async () => sessionStorage.getItem("mirattic.refresh"),
      save: async (token) =>
        token ? sessionStorage.setItem("mirattic.refresh", token) : sessionStorage.removeItem("mirattic.refresh"),
    };

export const api = createApi({ baseUrl: API_URL, store });
