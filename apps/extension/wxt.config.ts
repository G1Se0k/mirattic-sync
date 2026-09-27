import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Mirattic Sync',
    description: 'Watch together with friends. Syncs playback state only — never media.',
    permissions: ['sidePanel'],
    action: {},
  },
});
