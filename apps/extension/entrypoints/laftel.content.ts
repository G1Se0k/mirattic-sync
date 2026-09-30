import { serveAdapter } from '../bridge';
import { LaftelAdapter } from '../providers/laftel';

// Not in the manifest: the side panel injects it into the one Laftel tab it follows, and only after the
// user turned on experimental Laftel control (docs/platform-policy/laftel.md). Adds nothing to the page but an alert over a fullscreen video.
export default defineContentScript({
  matches: ['https://laftel.net/*'],
  registration: 'runtime',
  main() {
    serveAdapter(() => new LaftelAdapter());
  },
});
