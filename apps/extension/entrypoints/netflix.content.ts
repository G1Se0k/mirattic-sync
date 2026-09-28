import { serveAdapter } from '../bridge';
import { NetflixAdapter } from '../providers/netflix';

// Not in the manifest: the side panel injects it into the one Netflix tab it follows, and only after the
// user turned on experimental Netflix control (docs/platform-policy/netflix.md). Adds nothing to the page.
export default defineContentScript({
  matches: ['https://www.netflix.com/*'],
  registration: 'runtime',
  main() {
    // Injected again on every rebind; one listener per page is enough.
    const g = globalThis as { miratticNetflix?: true };
    if (g.miratticNetflix) return;
    g.miratticNetflix = true;
    serveAdapter(() => new NetflixAdapter());
  },
});
