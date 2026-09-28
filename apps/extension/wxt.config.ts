import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Mirattic Sync',
    description: 'Watch together with friends. Syncs playback state only — never media.',
    // storage: the refresh token lives in storage.session. No host permissions: the API server allows this
    // extension's origin through CORS, and there are no content scripts until a provider adapter exists.
    permissions: ['sidePanel', 'storage'],
    action: {},
    // Dev-only public key pinning the ID to kphihploboaigagpahhdhjiaglnfmpii so the server can allow its origin.
    // ponytail: replace with the Web Store item's public key before publishing (docs/platform-policy/chrome-web-store.md).
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyTeGSr6X5t4jk2nizytY4YOGiUlsskBAgzvz8fmgQMjhlSDMgERcwNLuLo0OoIXUKp/kE57mE69aDS91ScamGWfhTh7wnDK4rTSP6FQ3N4YQHg8WAmm4JoFqfiHoOgGMkjZ+RBmTMGV4QjxcQqYYu8NurFML9CzrUiyztX7yYXChOYyD8ejiW0VnLSE9vwLnfU1phxzCeXBVj38L4l7vVcduLrq1DdtUddmx5CAWT5JG3jjRjK5RaVXMHDATrGsMQEgfoHm2Sa56vJZCfPjf3LcN47zONAI/4M5NbhgYmh7Fg6zRLAF8d5+el4sGWkM9IaSBOhX2IqcKXHJrFdt1kQIDAQAB',
  },
});
