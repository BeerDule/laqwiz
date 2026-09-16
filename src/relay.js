// relay.js — accès au relais WebSocket, partagé entre le host et le joueur.
//
// En dev, le relais tourne sur un serveur séparé (:3000, lancé par
// `npm run dev-ws`). En prod, même origine que le front (Vercel).

export const RELAY_ORIGIN = import.meta.env.DEV ? 'http://localhost:3000' : location.origin;

export function relayWsUrl(sessionId) {
  const url = new URL('/api/ws', RELAY_ORIGIN.replace(/^http/, 'ws'));
  url.searchParams.set('sessionId', sessionId);
  return url;
}
