import { MEDIA_PROVIDERS } from "@mirattic/types";
import "./App.css";

function App() {
  return (
    <main className="container">
      <h1>Mirattic Sync</h1>
      <p>Supported providers: {MEDIA_PROVIDERS.join(", ")}</p>
    </main>
  );
}

export default App;
