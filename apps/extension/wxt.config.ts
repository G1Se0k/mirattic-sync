import { defineConfig } from 'wxt';

const EXPERIMENTAL_ORIGINS = ['https://www.netflix.com/*', 'https://laftel.net/*'];

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Mirattic Sync',
    description: 'Watch together with friends. Syncs playback state only — never media.',
    // storage: the refresh token (storage.local, extension pages only), the consent flag and settings. Site access:
    // YouTube (the content script's match; host_permissions repeats it so the side panel can see which tab is
    // YouTube). Netflix and Laftel (plan.md decision 81): granted at install so the extension sees that a tab is on
    // one of them and can warn while its control is off; their pages are read and driven only once the user turns
    // the control on (experimental, docs/platform-policy/{netflix,laftel}.md) — `scripting` then injects its script
    // into the one tab we follow. The API server allows this extension's origin through CORS instead.
    // identity: launchWebAuthFlow for the Mirattic account sign-in window.
    permissions: ['sidePanel', 'storage', 'scripting', 'identity'],
    host_permissions: ['https://www.youtube.com/*', ...EXPERIMENTAL_ORIGINS],
    action: {},
    // The Chrome Web Store item's public key, so unpacked builds get the store ID ffoifpjldcgdiipbhljkofgifmefgohk
    // and the server can allow its origin. The store rejects `key`: strip it from manifest.json in the upload zip.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsFKGqDrWTqQWq1NOsBd4iTmlgx4tfwJtDksGa7iM884X5GRglPrz4EMxpQnC528KgXvGuJYQ6wK4B8HKEV5R5noHpKD23wxQXSnlwY/7e6hReWCqhqwbdSqU6dvt6OhT4adINHWw7Tq7Hjw0MNHBTKDwArO22i9ek2IJQ/5Otq8lfZQu0mw4JgPM+mf53zbRL1lsth8S2sCyRutQ/fQzLjT6uJVVRgGyEFIVytuqLbByW1HC2QxmkyiZ3uXoU2Lc6Ljt6PZZ60RWDo0SypX67l59AFu2OpCxM/UlfoPBslXfA0LDwJ58Afdh1uWRSatq7E8cdMayKSAEbjTCqqlThQIDAQAB',
  },
});
