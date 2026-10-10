// test/paid-mode.mjs — le gate « compte + crédits » du serveur.
//
// Démarre le relais avec ACCOUNT_GATED=1 + un mock LLM, puis vérifie que la clé
// serveur n'est servie qu'à un compte authentifié ayant consommé un crédit :
//   - sans cookie                       → 401 AUTH_REQUIRED ;
//   - cookie mais sans game token       → 402 PAYMENT_REQUIRED ;
//   - cookie + game token               → 200 (forward au mock) ;
//   - clé BYOK client                   → bypass du gate (200) ;
//   - 3 gratuites consommées puis 402   → comptage mensuel ;
//   - webhook Stripe signé              → +20 crédits achetés.
//
// Le flux OAuth Google (échange de code) n'est pas simulé : on crée le compte et
// la session directement via accounts.mjs, partageant la même base.
//
// Usage : npm run test:paid
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const RELAY_PORT = '3201';
const MOCK_PORT = '3202';
const BASE = `http://localhost:${RELAY_PORT}`;
const WEBHOOK_SECRET = 'whsec_test';
const tmpDir = mkdtempSync(join(tmpdir(), 'qc-paid-'));
const accountsDb = join(tmpDir, 'accounts.db');
const cacheDb = join(tmpDir, 'cache.db');

// Base connue AVANT l'import de accounts.mjs (DB_FILE résolu une seule fois).
process.env.ACCOUNTS_DB = accountsDb;
process.env.QUESTION_CACHE_DB = cacheDb;
const accounts = await import('../server/accounts.mjs');
const cache = await import('../server/questionCache.mjs');

// Seed du cache AVANT de démarrer le relais (pour les routes admin « themes »).
cache.addQuestions({ theme: 'Culture générale', difficulty: 'balanced', audience: 'general', sourceKey: '' }, [
  { question: 'Question de cache 1 ?', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }, { key: 'C', text: 'c' }, { key: 'D', text: 'd' }], difficulty: 'easy' },
  { question: 'Question de cache 2 ?', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }, { key: 'C', text: 'c' }, { key: 'D', text: 'd' }], difficulty: 'medium' },
]);

let passed = 0;
let failed = 0;
const ok = (l) => { passed += 1; console.log(`✓ ${l}`); };
const fail = (l, d = '') => { failed += 1; console.error(`✗ ${l}${d ? ' — ' + d : ''}`); };

// Compte + session créés AVANT de démarrer le relais (évite l'accès concurrent).
const userId = accounts.getOrCreateUser({ sub: 'google-123', email: 'mj@example.com', name: 'Le MJ' });
const sessionToken = accounts.createSession(userId);
const otherUserId = accounts.getOrCreateUser({ sub: 'google-456', email: 'autre@example.com', name: 'Autre' });
const otherSession = accounts.createSession(otherUserId);

const mock = spawn('node', ['demo/mock-llm.mjs'], {
  stdio: 'ignore',
  env: { ...process.env, PORT: MOCK_PORT, LATENCY_MS: '10' },
});
const relay = spawn('node', ['server/relay.mjs'], {
  stdio: 'ignore',
  env: {
    ...process.env,
    PORT: RELAY_PORT,
    QUESTION_CACHE_DB: cacheDb,
    ACCOUNTS_DB: accountsDb,
    ACCOUNT_GATED: '1',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ADMIN_USER_EMAIL: 'mj@example.com',
    LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    LLM_API_KEY: 'server-key',
    LLM_MODEL: 'mock',
  },
});
const cleanup = () => {
  try { relay.kill(); } catch { /* ignore */ }
  try { mock.kill(); } catch { /* ignore */ }
  rmSync(tmpDir, { recursive: true, force: true });
};
process.on('exit', cleanup);

let up = false;
for (let i = 0; i < 40; i += 1) {
  try { await fetch(`${BASE}/api/relay/health`); up = true; break; } catch { await sleep(150); }
}
if (!up) { console.error('✗ relais injoignable'); cleanup(); process.exit(1); }

const chat = (headers = {}) =>
  fetch(`${BASE}/api/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'question' }] }),
  });

// 1) Le serveur s'annonce en mode payant.
const health = await (await fetch(`${BASE}/api/health`)).json();
if (health.accountGated === true && health.freeGamesPerMonth === 3) {
  ok('GET /api/health annonce accountGated + 3 parties gratuites');
} else {
  fail('GET /api/health devrait annoncer accountGated=true et freeGamesPerMonth=3', JSON.stringify(health));
}

// 2) Sans cookie → 401 AUTH_REQUIRED.
const r1 = await chat();
if (r1.status === 401 && (await r1.json()).error?.code === 'AUTH_REQUIRED') {
  ok('clé serveur sans compte → 401 AUTH_REQUIRED');
} else {
  fail(`clé serveur sans compte devrait renvoyer 401, reçu ${r1.status}`, await r1.text());
}

// 3) Cookie mais sans game token → 402 PAYMENT_REQUIRED.
const r2 = await chat({ Cookie: `qc_session=${sessionToken}` });
if (r2.status === 402 && (await r2.json()).error?.code === 'PAYMENT_REQUIRED') {
  ok('compte sans partie en cours → 402 PAYMENT_REQUIRED');
} else {
  fail(`compte sans partie devrait renvoyer 402, reçu ${r2.status}`, await r2.text());
}

// 4) BYOK (clé client) → le gate est contourné (200, forward au mock).
const r3 = await chat({ 'X-LLM-Api-Key': 'ma-cle-client' });
if (r3.status === 200) ok('BYOK contourne le gate (HTTP 200)');
else fail(`BYOK devrait renvoyer 200, reçu ${r3.status}`, await r3.text());

// 5) Consomme un crédit → game token + 2 gratuites restantes.
const consume = async () => {
  const res = await fetch(`${BASE}/api/account/games`, { method: 'POST', headers: { Cookie: `qc_session=${sessionToken}` } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const c1 = await consume();
if (c1.status === 200 && c1.data.gameToken && c1.data.freeRemaining === 2) {
  ok(`POST /api/account/games rend un game token (gratuites restantes : ${c1.data.freeRemaining})`);
} else {
  fail('POST /api/account/games devrait rendre un token et 2 gratuites restantes', JSON.stringify(c1));
}

// 6) Cookie + game token → 200.
const r4 = await chat({ Cookie: `qc_session=${sessionToken}`, 'X-Game-Token': c1.data.gameToken });
if (r4.status === 200) ok('compte + game token → clé serveur servie (HTTP 200)');
else fail(`compte + game token devrait renvoyer 200, reçu ${r4.status}`, await r4.text());

// 7) Épuise les 2 gratuites restantes, puis la 4e consommation → 402.
await consume();
await consume();
const c4 = await consume();
if (c4.status === 402 && c4.data.error?.code === 'NO_CREDITS') {
  ok('après 3 gratuites consommées → 402 NO_CREDITS');
} else {
  fail('la 4e consommation devrait renvoyer 402 NO_CREDITS', JSON.stringify(c4));
}

// 8) Webhook Stripe signé → +20 crédits achetés.
const payload = JSON.stringify({
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_test_123', client_reference_id: String(userId), metadata: { credits: '20' } } },
});
const t = Math.floor(Date.now() / 1000);
const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
const w = await fetch(`${BASE}/api/account/webhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${v1}` },
  body: payload,
});
if (w.status === 200) ok('webhook Stripe signé accepté (HTTP 200)');
else fail(`webhook devrait renvoyer 200, reçu ${w.status}`, await w.text());

// 9) Le compte reflète les 20 crédits achetés + le statut admin.
const me = await (await fetch(`${BASE}/api/account/me`, { headers: { Cookie: `qc_session=${sessionToken}` } })).json();
if (me.signedIn && me.purchasedRemaining === 20 && me.isAdmin === true) {
  ok(`GET /api/account/me : connecté + admin, ${me.purchasedRemaining} parties achetées`);
} else {
  fail('GET /api/account/me devrait renvoyer 20 parties achetées et isAdmin=true', JSON.stringify(me));
}

// 10) Une consommation suivante puise dans les achetés.
const c5 = await consume();
if (c5.status === 200 && c5.data.source === 'purchased' && c5.data.purchasedRemaining === 19) {
  ok('la consommation suivante puise dans les achetés (source=purchased)');
} else {
  fail('la consommation après achat devrait puiser dans les achetés', JSON.stringify(c5));
}

// 11) L'administrateur liste les comptes.
const adminList = await fetch(`${BASE}/api/admin/users`, { headers: { Cookie: `qc_session=${sessionToken}` } });
if (adminList.status === 200) {
  const { users } = await adminList.json();
  ok(`GET /api/admin/users : ${users.length} compte(s)`);
} else {
  fail('GET /api/admin/users devrait renvoyer 200 pour l\'admin', await adminList.text());
}

// 12) Un non-admin est refusé.
const forbidden = await fetch(`${BASE}/api/admin/users`, { headers: { Cookie: `qc_session=${otherSession}` } });
if (forbidden.status === 403) ok('GET /api/admin/users pour un non-admin → 403');
else fail(`un non-admin devrait recevoir 403, reçu ${forbidden.status}`, await forbidden.text());

// 13) L'administrateur fixe les crédits achetés d'un compte.
const upd = await fetch(`${BASE}/api/admin/users/${userId}/credits`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: `qc_session=${sessionToken}` },
  body: JSON.stringify({ credits: 42 }),
});
const updData = await upd.json().catch(() => ({}));
if (upd.status === 200 && updData.user?.purchasedRemaining === 42) {
  ok('POST /api/admin/users/:id/credits fixe le solde acheté (42)');
} else {
  fail('la modification des crédits admin a échoué', await upd.text());
}

// 14) L'administrateur liste les thèmes du cache.
const themesList = await fetch(`${BASE}/api/admin/themes`, { headers: { Cookie: `qc_session=${sessionToken}` } });
if (themesList.status === 200) {
  const { themes } = await themesList.json();
  ok(`GET /api/admin/themes : ${themes.length} thème(s)`);
} else {
  fail('GET /api/admin/themes devrait renvoyer 200 pour l\'admin', await themesList.text());
}

// 15) Un non-admin ne peut pas lister les thèmes.
const themesForbidden = await fetch(`${BASE}/api/admin/themes`, { headers: { Cookie: `qc_session=${otherSession}` } });
if (themesForbidden.status === 403) ok('GET /api/admin/themes pour un non-admin → 403');
else fail(`un non-admin devrait recevoir 403 sur /api/admin/themes, reçu ${themesForbidden.status}`, await themesForbidden.text());

// 16) L'administrateur supprime un thème du cache.
const del = await fetch(`${BASE}/api/admin/themes/delete`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: `qc_session=${sessionToken}` },
  body: JSON.stringify({ theme: 'Culture générale' }),
});
const delData = await del.json().catch(() => ({}));
if (del.status === 200 && delData.removed > 0) {
  ok(`POST /api/admin/themes/delete supprime un thème (${delData.removed} question(s))`);
} else {
  fail('la suppression d\'un thème a échoué', await del.text());
}

cleanup();
console.log(`\n${passed} ok, ${failed} échec(s)`);
process.exit(failed ? 1 : 0);
