import { useCallback, useEffect, useRef, useState } from "react";
import type { Me } from "@mirattic/types";
import { api } from "./session";
import { Login } from "./Login";
import { Home } from "./Home";
import { OffSitePrompt } from "./Experimental";

function App() {
  const [me, setMe] = useState<Me | null | "loading">("loading");
  /** Bumped by every change of `me` and every re-read: a re-read answering after any of them is older news. */
  const meVersion = useRef(0);
  const showMe = (m: Me | null) => {
    meVersion.current++;
    setMe(m);
  };

  const loadMe = () => api.me().then(showMe, () => showMe(null));

  useEffect(() => {
    api.restore().then((ok) => (ok ? loadMe() : showMe(null)), () => showMe(null));
  }, []);

  // Back to the panel (e.g. from "계정 정보 수정" in another tab): read again, so a name changed at Mirattic Auth shows
  // (decision 99). A failure here keeps what is shown (signing out is the restore's say, not this).
  const signedIn = !!me && me !== "loading";
  useEffect(() => {
    if (!signedIn) return;
    const again = () => {
      const at = ++meVersion.current;
      // Only if nothing changed since (a later re-read, a setting saved, signing out started): else it is older news.
      void api.me().then((m) => at === meVersion.current && setMe(m), () => {});
    };
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [signedIn]);

  // The same function across renders: Home's socket depends on it, and a re-read (above) must not restart that.
  const signOut = useCallback(async () => {
    meVersion.current++; // a re-read under way isn't shown over signing out
    await api.logout();
    meVersion.current++;
    setMe(null);
  }, []);

  // The site prompt is mounted once, beside every screen (signed in or not): a dismissed arrival stays dismissed.
  return (
    <>
      <OffSitePrompt />
      {me === "loading" ? (
        <main className="container">불러오는 중…</main>
      ) : !me ? (
        <Login onSignedIn={loadMe} />
      ) : (
        <Home
          me={me}
          onMeChange={showMe}
          onSignedOut={signOut}
        />
      )}
    </>
  );
}

export default App;
