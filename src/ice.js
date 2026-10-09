// ice.js — configuration ICE (STUN/TURN) des connexions WebRTC.
//
// Le défaut est un STUN public (Google) : il suffit au hole punching pour la
// plupart des box (NAT à cône). Pour les NAT symétriques, renseigner
// `VITE_ICE_SERVERS` (tableau JSON d'iceServers, figé à la compilation comme
// `VITE_RELAY_ORIGIN`), typiquement avec un relais TURN (coturn).

const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

function parseIceServers(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch { return null; }
}

export const ICE_SERVERS = parseIceServers(import.meta.env.VITE_ICE_SERVERS) || DEFAULT_ICE_SERVERS;
