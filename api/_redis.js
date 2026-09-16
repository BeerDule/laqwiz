// api/_redis.js — accès Redis Cloud partagé (état des rooms + pub/sub).
//
// Le serveur reste un « dumb relay » (WS.md §18.6) : l'état de room vit dans
// Redis (avec TTL), le relais inter-instances passe par pub/sub sur le canal
// `room:<roomId>`. La Map en mémoire du §3 ne sert qu'aux sockets LOCAUX d'une
// instance — elle ne figure donc pas ici, chaque connexion étant autonome.

import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL;

// Durée de vie d'une room (WS.md §4) : 30 min sans activité, 4 h max.
export const ROOM_TTL_SECONDS = 4 * 60 * 60;

export const roomKey = (sessionId) => `room:${sessionId}`;
export const roomChannel = (sessionId) => `room:${sessionId}`;
export const roomCountKey = (sessionId) => `room:${sessionId}:count`;

let commandClient = null;

/**
 * Connexion « commandes » (SET/GET/EXISTS/PUBLISH/INCR), réutilisée par
 * instance de fonction. Une seule connexion suffit : ioredis multiplexe les
 * commandes.
 */
export function getRedis() {
  if (!commandClient) {
    if (!REDIS_URL) {
      throw new Error(
        'REDIS_URL manquante — lancer `vc i redis` puis `vercel env pull`.'
      );
    }
    commandClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    commandClient.on('error', (err) => console.error('[redis] erreur', err.message));
  }
  return commandClient;
}

/**
 * Connexion dédiée à la souscription pub/sub. Une connexion ioredis en mode
 * subscriber ne peut plus exécuter de commandes : on la `duplicate()` depuis la
 * connexion principale.
 */
export function getSubscriber() {
  return getRedis().duplicate();
}
