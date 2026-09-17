// api/ws.js — relais WebSocket d'une room (WS.md §7, §8).
//
// Dumb relay : le serveur ne comprend pas le contenu des messages. Il relie les
// connexions d'une même room via Redis pub/sub et ajoute `senderId` (jamais
// accepté du client, WS.md §9). La logique de jeu reste chez le host (§18.3).
//
// NB (beta Vercel) : la durée d'une connexion WS peut être plafonnée par le
// `maxDuration` de la fonction. À ajuster si les parties longues se font couper
// (ex. `export const maxDuration = 300;`).

import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  getRedis, getSubscriber, roomKey, roomChannel, roomCountKey, ROOM_TTL_SECONDS,
} from './_redis.js';

// Vercel tue la fonction (et donc la connexion WS) au bout de `maxDuration`.
// On la pousse au maximum autorisé ; au-delà, c'est le CLIENT qui reconnecte
// (voir src/room.js et src/player.js). Le heartbeat ci-dessous sert à la fois
// d'anti-inactivité et de repère « dernier ping » côté client.
export const maxDuration = 300;

const randomId = () => randomBytes(6).toString('hex'); // player-xxxxxxxxxxxx

export default function handler(req, res) {
  // Une connexion WebSocket démarre par un GET avec header Upgrade.
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('WebSocket requis.');
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('sessionId');

  // WS.md §7.2 : format valide avant toute chose.
  if (!sessionId || !/^[a-f0-9]{16,64}$/i.test(sessionId)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('sessionId manquant ou invalide.');
    return;
  }

  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(err.message);
    return;
  }

  // La vérité de l'existence de la room vit dans Redis (§18.6) : on la vérifie
  // avant d'upgrader. Le plafond de joueurs n'est pas appliqué ici — c'est le
  // host qui valide les `lobby.join` (§18.3).
  redis.exists(roomKey(sessionId))
    .then((exists) => {
      if (!exists) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Session inconnue ou expirée.');
        return;
      }
      upgrade();
    })
    .catch((err) => {
      console.error('[ws] erreur Redis', err);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Erreur interne.');
    });

  function upgrade() {
    const wss = new WebSocketServer({ noServer: true });

    wss.on('connection', (ws) => {
      const playerId = `player-${randomId()}`;
      const channel = roomChannel(sessionId);
      let closed = false;

      // Heartbeat serveur → client : entretient la connexion (proxys, NAT) et
      // donne au client un repère de fraîcheur (« dernier ping »). La durée de
      // vie est de toute façon bornée par `maxDuration` — c'est le client qui
      // reconnecte — mais ce ping évite aussi les coupures d'inactivité.
      const heartbeat = setInterval(() => {
        if (closed || ws.readyState !== ws.OPEN) return;
        try { ws.send(JSON.stringify({ type: 'ping', payload: { ts: Date.now() } })); } catch { /* ignore */ }
      }, 15000);

      // Présence : compte les connexions (Redis, donc partagé entre instances)
      // et informe la room. `senderId` = l'origine, pour que le filtre
      // anti-écho ci-dessous ne renvoie pas l'événement à son auteur.
      const announce = (type) => {
        const key = roomCountKey(sessionId);
        const op = type === 'player.joined' ? 'incr' : 'decr';
        redis[op](key)
          .then((count) => {
            const playersCount = Math.max(0, count);
            const expire = type === 'player.joined'
              ? redis.expire(key, ROOM_TTL_SECONDS)
              : Promise.resolve();
            return expire.then(() => redis.publish(channel, JSON.stringify({
              type,
              senderId: playerId,
              payload: { playerId, playersCount },
            })));
          })
          .catch((err) => console.error('[ws] presence', err));
      };

      const sub = getSubscriber();

      // Relais Redis → socket local, sans écho à l'expéditeur (WS.md §4.4).
      sub.on('message', (ch, message) => {
        if (closed || ws.readyState !== ws.OPEN) return;
        let parsed;
        try { parsed = JSON.parse(message); } catch { return; }
        if (parsed.senderId === playerId) return;
        ws.send(message);
      });

      ws.on('error', () => { /* le `close` fera le ménage */ });

      // Message client → publish, avec `senderId` ajouté côté serveur.
      ws.on('message', (raw) => {
        let parsed;
        try { parsed = JSON.parse(raw.toString()); } catch { return; }
        if (!parsed || typeof parsed.type !== 'string') return;
        const envelope = { ...parsed, senderId: playerId };
        redis.publish(channel, JSON.stringify(envelope))
          .catch((err) => console.error('[ws] publish', err));
      });

      // Fermeture : départ propre (unsubscribe, quit, décrément du compteur).
      ws.on('close', () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        announce('player.left');
        sub.unsubscribe(channel).catch(() => {});
        sub.quit().catch(() => {});
      });

      sub.subscribe(channel, (err) => {
        if (err) {
          console.error('[ws] subscribe', err);
          ws.close(1011, 'erreur interne');
          return;
        }
        if (closed) return;
        // Accusé de réception (WS.md §5.1) : l'identité est attribuée par le
        // serveur, jamais choisie par le client.
        ws.send(JSON.stringify({
          type: 'session.connected',
          payload: { sessionId, playerId },
        }));
        announce('player.joined');
      });
    });

    wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
      wss.emit('connection', ws, req);
    });
  }
}
