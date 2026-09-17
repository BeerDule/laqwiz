// relay.js — accès au relais WebSocket, partagé entre le host et le joueur.
//
// Le relais est un serveur auto-hébergé (server/relay.mjs) sur un VPS. Son
// origine est configurable à la compilation via VITE_RELAY_ORIGIN ; à défaut :
//   - en dev, le relais local (:3000) sur la même machine que le front ;
//   - en prod, la même origine que le front (le relais peut servir dist/).

export const RELAY_ORIGIN = import.meta.env.VITE_RELAY_ORIGIN
  || (import.meta.env.DEV ? `${location.protocol}//${location.hostname}:3000` : location.origin);

export function relayWsUrl(sessionId) {
  const url = new URL('/api/ws', RELAY_ORIGIN.replace(/^http/, 'ws'));
  url.searchParams.set('sessionId', sessionId);
  return url;
}
