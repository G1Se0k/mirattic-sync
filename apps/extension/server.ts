// The Mirattic Sync server: .env.production's in `wxt build`, a local one in development. Kept apart from session.ts
// (the background's token store) so extension pages can import it without that module's side effects.
export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8080';
