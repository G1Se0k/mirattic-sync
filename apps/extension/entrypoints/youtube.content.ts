import type { MediaProvider } from '@mirattic/types';

// Phase 0 shell only. Real detection lives in providers/youtube (Phase 4).
export default defineContentScript({
  matches: ['*://www.youtube.com/*'],
  main() {
    const provider: MediaProvider = 'youtube';
    console.debug('[mirattic] content script loaded', provider);
  },
});
