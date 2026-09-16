// demo/lobby-test.mjs — test local de bout en bout du lobby (zéro dépendance).
//
// Valide, sans navigateur ni serveur préalable :
//   1. la création du lobby (POST /api/sessions) ;
//   2. la connexion du host au relais WebSocket ;
//   3. la connexion d'un AUTRE client (le joueur) ;
//   4. la présence (player.joined) et le `lobby.join` (nom + avatar) ;
//   5. le départ (player.left) ;
//   6. le refus d'une session inconnue.
//
// Le script démarre lui-même un Redis + le relais sur des ports isolés
// (6381 / 3001) pour ne pas gêner un `npm run dev-ws` déjà lancé.
//
// Usage : npm run test:lobby    (ou `node demo/lobby-test.mjs` dans nix develop)

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const RELAY_PORT = process.env.TEST_RELAY_PORT || '3001';
const REDIS_PORT = process.env.TEST_REDIS_PORT || '6381';
const BASE = `http://localhost:${RELAY_PORT}`;
const WS_BASE = `ws://localhost:${RELAY_PORT}`;
const REDIS_URL = `redis://localhost:${REDIS_PORT}`;

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
      await fetch(`${BASE}/api/sessions`);
      return true;
    } catch {
      await sleep(150);
    }
  }
  return false;
}

function connect(sessionId) {
  const url = new URL('/api/ws', WS_BASE);
  url.searchParams.set('sessionId', sessionId);
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
  const next = (timeoutMs = 3000) => new Promise((resolve, reject) => {
    if (inbox.length) return resolve(inbox.shift());
    const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    waiters.push((m) => { clearTimeout(t); resolve(m); });
  });
  return { ws, open, next };
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

function cleanup(code) {
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch { /* déjà mort */ }
  }
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => cleanup(130));
process.on('SIGTERM', () => cleanup(0));

async function main() {
  console.log('=== Test lobby (relais WebSocket) ===\n');

  // 1) Redis + relais isolés.
  spawnChild('redis-server', ['--port', REDIS_PORT, '--save', '', '--appendonly', 'no']);
  await sleep(600);
  spawnChild('node', ['demo/dev-server.mjs'], { REDIS_URL, PORT: RELAY_PORT });

  const up = await waitForServer();
  assert(up, `relais prêt sur ${BASE}`);
  if (!up) { cleanup(1); return; }

  // 2) Création du lobby.
  const res = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5173' },
  });
  assert(res.status === 201, 'POST /api/sessions → 201', `reçu ${res.status}`);
  assert(res.headers.get('access-control-allow-origin') === '*', 'CORS allow-origin: *');
  const { sessionId, shareUrl } = await res.json();
  assert(/^[a-f0-9]{64}$/.test(sessionId), 'sessionId = 64 caractères hex');
  assert(typeof shareUrl === 'string' && shareUrl.includes(sessionId), 'shareUrl contient le sessionId');
  console.log(`  sessionId : ${sessionId.slice(0, 16)}…`);

  // 3) Connexion du host.
  const host = connect(sessionId);
  await host.open;
  const hostConnected = await host.next();
  assert(hostConnected.type === 'session.connected', 'host : session.connected');
  const hostId = hostConnected.payload.playerId;
  assert(typeof hostId === 'string' && hostId.startsWith('player-'), 'host : playerId attribué');

  // 4) Connexion d'un AUTRE client (le joueur).
  const player = connect(sessionId);
  await player.open;
  const playerConnected = await player.next();
  assert(playerConnected.type === 'session.connected', 'joueur : session.connected');
  const playerId = playerConnected.payload.playerId;
  assert(playerId !== hostId, 'identifiants distincts host / joueur');

  // 5) Présence côté host.
  const joined = await host.next();
  assert(joined.type === 'player.joined', 'host voit player.joined', `reçu : ${joined.type}`);
  assert(joined.payload?.playersCount === 2, 'playersCount = 2', `reçu : ${joined.payload?.playersCount}`);

  // 6) Le joueur annonce son identité (lobby.join).
  player.ws.send(JSON.stringify({ type: 'lobby.join', payload: { name: 'Alice', emoji: '🦊' } }));
  const join = await host.next();
  assert(join.type === 'lobby.join', 'host reçoit lobby.join', `reçu : ${join.type}`);
  assert(join.senderId === playerId, 'senderId = id du joueur', `reçu : ${join.senderId}`);
  assert(
    join.payload?.name === 'Alice' && join.payload?.emoji === '🦊',
    'payload nom + avatar corrects',
    `reçu : ${JSON.stringify(join.payload)}`,
  );

  // 6 bis) Broadcasts host → joueur : roster (acceptation), rejet ciblé, démarrage.
  host.ws.send(JSON.stringify({ type: 'lobby.roster', payload: { players: [{ id: playerId, name: 'Alice', emoji: '🦊' }] } }));
  const roster = await player.next();
  assert(roster.type === 'lobby.roster', 'joueur reçoit lobby.roster', `reçu : ${roster.type}`);
  assert(roster.payload?.players?.[0]?.id === playerId, "roster porte l'id du joueur");

  host.ws.send(JSON.stringify({ type: 'lobby.join.rejected', payload: { targetId: playerId, reason: 'name-taken' } }));
  const rejected = await player.next();
  assert(rejected.type === 'lobby.join.rejected', 'joueur reçoit lobby.join.rejected', `reçu : ${rejected.type}`);
  assert(
    rejected.payload?.targetId === playerId && rejected.payload?.reason === 'name-taken',
    'rejet ciblé + raison corrects',
    `reçu : ${JSON.stringify(rejected.payload)}`,
  );

  host.ws.send(JSON.stringify({ type: 'game.start', payload: {} }));
  const started = await player.next();
  assert(started.type === 'game.start', 'joueur reçoit game.start', `reçu : ${started.type}`);

  // 7) Départ du joueur.
  player.ws.close();
  const left = await host.next();
  assert(left.type === 'player.left', 'host voit player.left', `reçu : ${left.type}`);

  // 8) Session inconnue refusée.
  await testInvalidSession();

  host.ws.close();

  console.log(`\n${passed} test(s) OK, ${failed} échec(s).`);
  cleanup(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('Erreur du test :', err);
  cleanup(1);
});