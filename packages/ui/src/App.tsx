import { useEffect, useState } from "react";
import type { Me } from "@mirattic/types";
import { api } from "./session";
import { Login } from "./Login";
import { Home } from "./Home";

function App() {
  const [me, setMe] = useState<Me | null | "loading">("loading");

  const loadMe = () => api.me().then(setMe, () => setMe(null));

  useEffect(() => {
    api.restore().then((ok) => (ok ? loadMe() : setMe(null)), () => setMe(null));
  }, []);

  if (me === "loading") return <main className="container">불러오는 중…</main>;
  if (!me) return <Login onSignedIn={loadMe} />;
  return (
    <Home
      me={me}
      onMeChange={setMe}
      onSignedOut={async () => {
        await api.logout();
        setMe(null);
      }}
    />
  );
}

export default App;
