// demo/ws-relay-test.mjs — valide le serveur de signalisation en local (zéro dépendance).
//
// Prérequis :
//   1. un serveur de signalisation qui tourne (npm run relay → http://localhost:3000) ;
//   2. `node demo/ws-relay-test.mjs` (Node ≥ 22 : WebSocket natif).
//
// Scénario : crée une room, connecte le host (jeton) puis deux joueurs, vérifie
// le routage en étoile (joueur → host, host → tous ou ciblé), l'absence d'écho
// à l'expéditeur et la présence (player.joined / player.left).

const BASE = process.env.BASE_URL || 'http://localhost:3000';

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function createSession() {
  const res = await fetch(`${BASE}/api/sessions`, { method: 'POST' });
  if (!res.ok) fail(`POST /api/sessions → HTTP ${res.status} : ${await res.text()}`);
  return res.json();
}

function connect(sessionId, { role, token } = {}) {
  const wsUrl = new URL('/api/ws', BASE.replace(/^http/, 'ws'));
  wsUrl.searchParams.set('sessionId', sessionId);
  if (role) wsUrl.searchParams.set('role', role);
  if (token) wsUrl.searchParams.set('token', token);
  const ws = new WebSocket(wsUrl);

  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    const w = waiters.shift();
    if (w) w(msg); else inbox.push(msg);
  });

  const open = new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  const wait = (timeoutMs = 3000) => new Promise((resolve) => {
    if (inbox.length) return resolve(inbox.shift());
    const waiter = (m) => { clearTimeout(t); resolve(m); };
    const t = setTimeout(() => {
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      resolve(null);
    }, timeoutMs);
    waiters.push(waiter);
  });
  const next = (timeoutMs = 3000) => wait(timeoutMs).then((m) => {
    if (m == null) throw new Error('timeout');
    return m;
  });

  return { ws, open, next, wait };
}

const { sessionId, hostToken } = await createSession();
console.log(`✓ room créée : ${sessionId.slice(0, 16)}…`);

// Host authentifié, puis deux joueurs.
const host = connect(sessionId, { role: 'host', token: hostToken });
await host.open;
const hostConnected = await host.next();
if (hostConnected.type !== 'session.connected' || hostConnected.payload.role !== 'host') {
  fail(`host : attendu session.connected role=host, reçu ${hostConnected.type}`);
}
const hostId = hostConnected.payload.playerId;
console.log(`✓ host connecté (playerId ${hostId})`);

const a = connect(sessionId);
await a.open;
const aConnected = await a.next();
if (aConnected.type !== 'session.connected') fail(`A : attendu session.connected, reçu ${aConnected.type}`);
const aId = aConnected.payload.playerId;
console.log(`✓ A connecté (playerId ${aId})`);

const b = connect(sessionId);
await b.open;
const bConnected = await b.next();
if (bConnected.type !== 'session.connected') fail(`B : attendu session.connected, reçu ${bConnected.type}`);
console.log(`✓ B connecté (playerId ${bConnected.payload.playerId})`);

// Présence : le host voit l'arrivée des deux joueurs.
const joinedA = await host.next();
if (joinedA.type !== 'player.joined' || joinedA.payload.playersCount !== 1) {
  fail(`host : attendu player.joined count=1, reçu ${joinedA.type} ${joinedA.payload?.playersCount}`);
}
const joinedB = await host.next();
if (joinedB.type !== 'player.joined' || joinedB.payload.playersCount !== 2) {
  fail(`host : attendu player.joined count=2, reçu ${joinedB.type} ${joinedB.payload?.playersCount}`);
}
console.log('✓ host voit player.joined (playersCount 1 puis 2)');

// Joueur → host : relais avec senderId, sans fuite vers l'autre joueur.
a.ws.send(JSON.stringify({ type: 'lobby.join', payload: { clientId: 'a', name: 'A', emoji: '🦊' } }));
const aJoin = await host.next();
if (aJoin.type !== 'lobby.join' || aJoin.senderId !== aId) {
  fail(`host : attendu lobby.join de A (senderId ${aId}), reçu ${aJoin.type}/${aJoin.senderId}`);
}
const bSilent1 = await b.wait(500);
if (bSilent1 != null) fail(`B : fuite du lobby.join de A (${bSilent1.type})`);
console.log('✓ joueur → host (senderId correct, pas de fuite vers B)');

// Host → tous (sans targetId).
host.ws.send(JSON.stringify({ type: 'game.question', payload: { q: 'coucou' } }));
const aQ = await a.next();
const bQ = await b.next();
if (aQ.type !== 'game.question' || bQ.type !== 'game.question') {
  fail('A/B : attendu game.question broadcast');
}
console.log('✓ host → tous (broadcast atteint A et B)');

// Pas d'écho au host (il ne reçoit pas son propre broadcast).
const hostSilent = await host.wait(500);
if (hostSilent != null) fail(`host : écho inattendu (${hostSilent.type})`);
console.log("✓ pas d'écho au host");

// Host → joueur ciblé (targetId).
host.ws.send(JSON.stringify({ type: 'rtc.offer', targetId: aId, payload: { sdp: 'x' } }));
const aOffer = await a.next();
if (aOffer.type !== 'rtc.offer') fail(`A : attendu rtc.offer, reçu ${aOffer.type}`);
const bSilent2 = await b.wait(500);
if (bSilent2 != null) fail(`B : fuite du rtc.offer ciblé sur A (${bSilent2.type})`);
console.log('✓ host → joueur ciblé (targetId)');

// Départ d'un joueur → présence côté host.
b.ws.close();
const bLeft = await host.next();
if (bLeft.type !== 'player.left') fail(`host : attendu player.left, reçu ${bLeft.type}`);
console.log('✓ host est informé du départ de B');

host.ws.close();
a.ws.close();
console.log('\nServeur de signalisation validé ✅');
process.exit(0);
