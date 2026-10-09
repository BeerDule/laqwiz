// demo/lobby-test.mjs — test local de la signalisation WebSocket (zéro dépendance).
//
// Valide, sans navigateur ni serveur préalable :
//   1. la création de la room (POST /api/sessions → sessionId + hostToken) ;
//   2. l'authentification du host (rôle + jeton) et le refus d'un faux host ;
//   3. la connexion des joueurs (sans jeton) ;
//   4. la présence (player.joined / player.left, comptés sans le host) ;
//   5. le routage en étoile : joueur → host uniquement, host → tous ou ciblé ;
//   6. le refus d'une session inconnue.
//
// Le script démarre lui-même le serveur de signalisation sur un port isolé (3001)
// pour ne pas gêner un `npm run dev-ws` déjà lancé.
//
// Usage : npm run test:lobby    (ou `node demo/lobby-test.mjs` dans nix develop)

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const RELAY_PORT = process.env.TEST_RELAY_PORT || '3001';
const BASE = `http://localhost:${RELAY_PORT}`;
const WS_BASE = `ws://localhost:${RELAY_PORT}`;

const children = [];
let passed = 0;
let failed = 0;

function ok(label) {
  passed += 1;
  console.log(`✓ ${label}`);
}
function fail(label, detail = '') {
  failed += 1;
  console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
}
function assert(cond, label, detail) {
  if (cond) ok(label); else fail(label, detail);
}

function spawnChild(cmd, args, env = {}) {
  const child = spawn(cmd, args, { stdio: 'ignore', env: { ...process.env, ...env } });
  children.push(child);
  return child;
}

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetch(`${BASE}/api/relay/health`);
      return true;
    } catch {
      await sleep(150);
    }
  }
  return false;
}

function connect(sessionId, { role, token } = {}) {
  const url = new URL('/api/ws', WS_BASE);
  url.searchParams.set('sessionId', sessionId);
  if (role) url.searchParams.set('role', role);
  if (token) url.searchParams.set('token', token);
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    const w = waiters.shift();
    if (w) w(msg); else inbox.push(msg);
  });
  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('erreur WebSocket')), { once: true });
  });
  // Attente d'un message, ou `null` passé le délai. Le waiter se retire
  // toujours de la file : pas de fuite vers le message suivant.
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

async function testInvalidSession() {
  const bogus = 'a'.repeat(64);
  const ws = new WebSocket(`${WS_BASE}/api/ws?sessionId=${bogus}`);
  const outcome = await Promise.race([
    new Promise((r) => ws.addEventListener('error', () => r('error'), { once: true })),
    new Promise((r) => ws.addEventListener('open', () => r('open'), { once: true })),
    sleep(3000).then(() => 'timeout'),
  ]);
  assert(outcome === 'error', 'session inconnue refusée (connexion échoue)', `reçu : ${outcome}`);
  try { ws.close(); } catch { /* déjà fermé */ }
}

async function expectRejectedUpgrade(sessionId, role, token) {
  const url = new URL('/api/ws', WS_BASE);
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('role', role);
  url.searchParams.set('token', token);
  const ws = new WebSocket(url);
  const outcome = await Promise.race([
    new Promise((r) => ws.addEventListener('error', () => r('error'), { once: true })),
    new Promise((r) => ws.addEventListener('open', () => r('open'), { once: true })),
    sleep(3000).then(() => 'timeout'),
  ]);
  assert(outcome === 'error', 'host avec mauvais jeton refusé (401)', `reçu : ${outcome}`);
  try { ws.close(); } catch { /* déjà fermé */ }
}

/** Atteste qu'aucun message n'arrive au pair dans la fenêtre `ms`. */
async function expectSilence(peer, ms = 500, label) {
  const m = await peer.wait(ms);
  assert(m == null, label, m ? `message inattendu reçu : ${m.type}` : '');
}

function cleanup(code) {
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch { /* déjà mort */ }
  }
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => cleanup(130));
process.on('SIGTERM', () => cleanup(0));

async function main() {
  console.log('=== Test lobby (signalisation WebSocket P2P) ===\n');

  // 1) Serveur de signalisation isolé.
  spawnChild('node', ['server/relay.mjs'], { PORT: RELAY_PORT });

  const up = await waitForServer();
  assert(up, `serveur de signalisation prêt sur ${BASE}`);
  if (!up) { cleanup(1); return; }

  // 2) Création de la room (sessionId + hostToken).
  const res = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5173' },
  });
  assert(res.status === 201, 'POST /api/sessions → 201', `reçu ${res.status}`);
  assert(res.headers.get('access-control-allow-origin') === '*', 'CORS allow-origin: *');
  const { sessionId, hostToken } = await res.json();
  assert(/^[a-f0-9]{64}$/.test(sessionId), 'sessionId = 64 caractères hex');
  assert(/^[a-f0-9]{48}$/.test(hostToken), 'hostToken = 48 caractères hex');
  console.log(`  sessionId : ${sessionId.slice(0, 16)}…`);

  // 3) Connexion du host (authentifié par jeton).
  const host = connect(sessionId, { role: 'host', token: hostToken });
  await host.open;
  const hostConnected = await host.next();
  assert(hostConnected.type === 'session.connected', 'host : session.connected');
  assert(hostConnected.payload.role === 'host', 'host : rôle host', `reçu : ${hostConnected.payload.role}`);
  const hostId = hostConnected.payload.playerId;
  assert(typeof hostId === 'string' && hostId.startsWith('player-'), 'host : playerId attribué');

  // 3 bis) Un faux host (mauvais jeton) est refusé.
  await expectRejectedUpgrade(sessionId, 'host', 'mauvais-jeton');

  // 4) Connexion de deux joueurs (sans jeton).
  const alice = connect(sessionId);
  await alice.open;
  const aliceConnected = await alice.next();
  assert(aliceConnected.type === 'session.connected', 'alice : session.connected');
  assert(aliceConnected.payload.role === 'player', 'alice : rôle player');
  const aliceId = aliceConnected.payload.playerId;

  const bob = connect(sessionId);
  await bob.open;
  const bobConnected = await bob.next();
  assert(bobConnected.type === 'session.connected', 'bob : session.connected');
  const bobId = bobConnected.payload.playerId;
  assert(aliceId !== bobId && aliceId !== hostId, 'identifiants distincts host / joueurs');

  // 5) Présence côté host (le host n'est pas compté comme joueur).
  const joinedAlice = await host.next();
  assert(joinedAlice.type === 'player.joined', 'host voit player.joined (alice)', `reçu : ${joinedAlice.type}`);
  assert(joinedAlice.payload?.playersCount === 1, 'playersCount = 1 (host exclu)', `reçu : ${joinedAlice.payload?.playersCount}`);
  const joinedBob = await host.next();
  assert(joinedBob.type === 'player.joined', 'host voit player.joined (bob)', `reçu : ${joinedBob.type}`);
  assert(joinedBob.payload?.playersCount === 2, 'playersCount = 2');

  // 6) Routage en étoile : un message d'un joueur ne remonte qu'au host.
  alice.ws.send(JSON.stringify({ type: 'lobby.join', payload: { clientId: 'client-alice', name: 'Alice', emoji: '🦊' } }));
  const join = await host.next();
  assert(join.type === 'lobby.join', 'host reçoit lobby.join', `reçu : ${join.type}`);
  assert(join.senderId === aliceId, 'senderId = id d\'alice', `reçu : ${join.senderId}`);
  assert(
    join.payload?.name === 'Alice' && join.payload?.emoji === '🦊' && join.payload?.clientId === 'client-alice',
    'payload nom + avatar + clientId corrects',
    `reçu : ${JSON.stringify(join.payload)}`,
  );
  await expectSilence(bob, 500, 'bob ne reçoit pas le lobby.join d\'alice (joueur → host)');

  // 7) Broadcast du host (sans targetId) → tous les joueurs.
  host.ws.send(JSON.stringify({ type: 'lobby.roster', payload: { players: [{ id: 'client-alice', name: 'Alice', emoji: '🦊' }] } }));
  const rosterAlice = await alice.next();
  const rosterBob = await bob.next();
  assert(rosterAlice.type === 'lobby.roster', 'alice reçoit lobby.roster', `reçu : ${rosterAlice.type}`);
  assert(rosterBob.type === 'lobby.roster', 'bob reçoit lobby.roster', `reçu : ${rosterBob.type}`);

  // 8) Message ciblé du host (targetId) → un seul joueur.
  host.ws.send(JSON.stringify({ type: 'rtc.offer', targetId: aliceId, payload: { sdp: 'offre-alice' } }));
  const offer = await alice.next();
  assert(offer.type === 'rtc.offer', 'alice reçoit rtc.offer ciblé', `reçu : ${offer.type}`);
  await expectSilence(bob, 500, 'bob ne reçoit pas le rtc.offer ciblé sur alice');

  // 9) Départ d'un joueur.
  alice.ws.close();
  const left = await host.next();
  assert(left.type === 'player.left', 'host voit player.left', `reçu : ${left.type}`);
  assert(left.payload?.playersCount === 1, 'playersCount = 1 après départ d\'alice');

  // 10) Session inconnue refusée.
  await testInvalidSession();

  host.ws.close();
  bob.ws.close();

  console.log(`\n${passed} test(s) OK, ${failed} échec(s).`);
  cleanup(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('Erreur du test :', err);
  cleanup(1);
});