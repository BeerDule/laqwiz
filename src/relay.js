// relay.js — accès au serveur de signalisation WebSocket, partagé host/joueur.
//
// Le serveur (server/relay.mjs) auto-hébergé sur un VPS ne relaie PAS les
// données de jeu : il ne fait que la signalisation (présentation des pairs,
// offres/réponses/candidats ICE). Son origine est configurable à la compilation
// via VITE_RELAY_ORIGIN ; à défaut :
//   - en dev, le serveur local (:3000) sur la même machine que le front ;
//   - en prod, la même origine que le front (le serveur peut servir dist/).

export const RELAY_ORIGIN = import.meta.env.VITE_RELAY_ORIGIN
  || (import.meta.env.DEV ? `${location.protocol}//${location.hostname}:3000` : location.origin);

export function relayWsUrl(sessionId, { role, token } = {}) {
  const url = new URL('/api/ws', RELAY_ORIGIN.replace(/^http/, 'ws'));
  url.searchParams.set('sessionId', sessionId);
  if (role) url.searchParams.set('role', role);
  if (token) url.searchParams.set('token', token);
  return url;
}
