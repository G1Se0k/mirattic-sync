import { defineConfig } from 'wxt';

const EXPERIMENTAL_ORIGINS = ['https://www.netflix.com/*', 'https://laftel.net/*'];

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Mirattic Sync',
    description: 'Watch together with friends. Syncs playback state only — never media.',
    // storage: the refresh token (storage.local, extension pages only) and the consent flag. The only site access is YouTube —
    // the content script's match; host_permissions repeats it so the side panel can see which tab is YouTube
    // (same install warning). The API server allows this extension's origin through CORS instead.
    // Netflix and Laftel are opt-in (experimental, docs/platform-policy/{netflix,laftel}.md): each origin is
    // requested only when the user turns it on, and `scripting` injects its script into the one tab we follow.
    permissions: ['sidePanel', 'storage', 'scripting'],
    host_permissions: ['https://www.youtube.com/*'],
    optional_host_permissions: [...EXPERIMENTAL_ORIGINS],
    action: {},
    // Dev-only public key pinning the ID to kphihploboaigagpahhdhjiaglnfmpii so the server can allow its origin.
    // ponytail: replace with the Web Store item's public key before publishing (docs/platform-policy/chrome-web-store.md).
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyTeGSr6X5t4jk2nizytY4YOGiUlsskBAgzvz8fmgQMjhlSDMgERcwNLuLo0OoIXUKp/kE57mE69aDS91ScamGWfhTh7wnDK4rTSP6FQ3N4YQHg8WAmm4JoFqfiHoOgGMkjZ+RBmTMGV4QjxcQqYYu8NurFML9CzrUiyztX7yYXChOYyD8ejiW0VnLSE9vwLnfU1phxzCeXBVj38L4l7vVcduLrq1DdtUddmx5CAWT5JG3jjRjK5RaVXMHDATrGsMQEgfoHm2Sa56vJZCfPjf3LcN47zONAI/4M5NbhgYmh7Fg6zRLAF8d5+el4sGWkM9IaSBOhX2IqcKXHJrFdt1kQIDAQAB',
  },
  hooks: {
    // WXT adds a runtime content script's matches to host_permissions; experimental sites must stay optional.
    'build:manifestGenerated': (_, manifest) => {
      manifest.host_permissions = manifest.host_permissions?.filter((p: string) => !EXPERIMENTAL_ORIGINS.includes(p));
    },
  },
});
