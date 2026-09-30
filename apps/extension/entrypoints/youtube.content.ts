import { serveAdapter } from '../bridge';
import { YouTubeAdapter } from '../providers/youtube';

// Reads nothing until our side panel connects (only after the user's consent); adds nothing to the page but
// an alert over a fullscreen video (toast.ts).
export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  main() {
    serveAdapter(() => new YouTubeAdapter());
  },
});
