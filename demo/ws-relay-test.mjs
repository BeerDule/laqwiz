// demo/ws-relay-test.mjs — valide le relais WebSocket en local (zéro dépendance).
//
// Prérequis :
//   1. un relais auto-hébergé qui tourne (npm run relay → http://localhost:3000) ;
//   2. `node demo/ws-relay-test.mjs` (Node ≥ 22 : WebSocket natif).
//
// Scénario : crée une session, connecte A puis B, vérifie que le message de A
// parvient à B avec `senderId`, que le sens inverse marche, qu'il n'y a pas
// d'écho, et que les événements de présence circulent.

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

function connect(sessionId) {
  const wsUrl = new URL('/api/ws', BASE.replace(/^http/, 'ws'));
  wsUrl.searchParams.set('sessionId', sessionId);
  const ws = new WebSocket(wsUrl);

  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    const w = waiters.shift();
    if (w) w(msg); else inbox.push(msg);
  });

  const open = new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  const next = () => new Promise((resolve) => {
    if (inbox.length) resolve(inbox.shift());
    else waiters.push(resolve);
  });

  return { ws, open, next };
}

const { sessionId, shareUrl } = await createSession();
console.log(`✓ session créée : ${sessionId}`);
console.log(`  shareUrl : ${shareUrl}`);

const a = connect(sessionId);
await a.open;
const aConnected = await a.next();
if (aConnected.type !== 'session.connected') fail(`A : attendu session.connected, reçu ${aConnected.type}`);
console.log(`✓ A connecté (playerId ${aConnected.payload.playerId})`);

const b = connect(sessionId);
await b.open;
const bConnected = await b.next();
if (bConnected.type !== 'session.connected') fail(`B : attendu session.connected, reçu ${bConnected.type}`);
console.log(`✓ B connecté (playerId ${bConnected.payload.playerId})`);

const aSeesB = await a.next();
if (aSeesB.type !== 'player.joined') fail(`A : attendu player.joined, reçu ${aSeesB.type}`);
console.log(`✓ A voit l'arrivée de B (playersCount ${aSeesB.payload.playersCount})`);

// A → B : message relayé avec senderId ajouté par le serveur.
a.ws.send(JSON.stringify({ type: 'game.move', payload: { position: 4 } }));
const bGot = await b.next();
if (bGot.type !== 'game.move' || bGot.payload.position !== 4) fail('B : relais incorrect');
if (bGot.senderId !== aConnected.payload.playerId) fail(`B : senderId incorrect (${bGot.senderId})`);
console.log(`✓ B reçoit le message de A (senderId ${bGot.senderId})`);

// B → A (sens inverse).
b.ws.send(JSON.stringify({ type: 'game.chat', payload: { message: 'coucou' } }));
const aGot = await a.next();
if (aGot.type !== 'game.chat' || aGot.senderId !== bConnected.payload.playerId) fail('A : relais inverse incorrect');
console.log('✓ A reçoit la réponse de B (sens inverse OK)');

// Pas d'écho : B ne reçoit pas son propre message.
const noEcho = await Promise.race([
  b.next().then((m) => ({ echo: true, m })),
  new Promise((r) => setTimeout(() => r({ echo: false }), 500)),
]);
if (noEcho.echo) fail(`B : écho inattendu de son propre message (${noEcho.m.type})`);
console.log("✓ pas d'écho à l'expéditeur");

b.ws.close();
const bLeft = await a.next();
if (bLeft.type !== 'player.left') fail(`A : attendu player.left, reçu ${bLeft.type}`);
console.log('✓ A est informé du départ de B');

a.ws.close();
console.log('\nRelais WebSocket validé ✅');
process.exit(0);
