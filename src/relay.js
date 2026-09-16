// relay.js — accès au relais WebSocket, partagé entre le host et le joueur.
//
// En dev, le relais tourne sur un serveur séparé (port :3000, lancé par
// `npm run dev-ws`) sur la MÊME machine que le front. On dérive donc son
// origine de l'hôte courant : ainsi un joueur qui ouvre le lien depuis un
// téléphone du LAN (http://192.168.x.x:5173) vise bien le relais du host
// (http://192.168.x.x:3000), pas `localhost` qui serait sa propre machine.
// En prod, même origine que le front (Vercel).

export const RELAY_ORIGIN = import.meta.env.DEV
  ? `${location.protocol}//${location.hostname}:3000`
  : location.origin;

export function relayWsUrl(sessionId) {
  const url = new URL('/api/ws', RELAY_ORIGIN.replace(/^http/, 'ws'));
  url.searchParams.set('sessionId', sessionId);
  return url;
}
