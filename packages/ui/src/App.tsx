import { useEffect, useState } from "react";
import type { Me } from "@mirattic/types";
import { api } from "./session";
import { Login } from "./Login";
import { Home } from "./Home";
import { OffSitePrompt } from "./Experimental";

function App() {
  const [me, setMe] = useState<Me | null | "loading">("loading");

  const loadMe = () => api.me().then(setMe, () => setMe(null));

  useEffect(() => {
    api.restore().then((ok) => (ok ? loadMe() : setMe(null)), () => setMe(null));
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
          onMeChange={setMe}
          onSignedOut={async () => {
            await api.logout();
            setMe(null);
          }}
        />
      )}
    </>
  );
}

export default App;
