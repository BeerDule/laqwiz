// demo/dev-server.mjs — serveur local minimal qui monte les fonctions /api
// pour tester le relais SANS `vercel dev` (et sans login Vercel).
//
// Usage :
//   REDIS_URL=redis://localhost:6380 node demo/dev-server.mjs
//
// Puis, dans un autre terminal :
//   REDIS_URL=redis://localhost:6380 node demo/ws-relay-test.mjs
//
// Les handlers reproduisent le contrat Vercel : `(req, res)` Node pour les
// routes HTTP, et l'événement `upgrade` pour la connexion WebSocket.

import http from 'node:http';
import sessions from '../api/sessions.js';
import wsRelay from '../api/ws.js';

const PORT = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    sessions(req, res);
  } else {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
  }
});

// Les requêtes d'upgrade WebSocket n'émettent PAS `request` : on les traite ici.
server.on('upgrade', (req, socket) => {
  // `ws.js` n'utilise `res` que dans ses chemins d'erreur (avant l'upgrade).
  // On lui fournit un objet minimal ; en cas d'erreur, on ferme juste le socket.
  const res = {
    statusCode: 200,
    setHeader() {},
    end() { socket.destroy(); },
  };
  wsRelay(req, res);
});

server.listen(PORT, () => {
  console.log(`[dev-server] /api/sessions + /api/ws sur http://localhost:${PORT}`);
});
