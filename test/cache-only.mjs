// test/cache-only.mjs — régression : le mode « cache only » doit fonctionner
// SANS AUCUNE configuration LLM (déploiement BYOK, ou .env sans identifiants).
//
// Démarre le relais sans LLM_BASE_URL / LLM_API_KEY, avec un pool de questions
// seedé dans une base temporaire, puis vérifie qu'une requête `cacheOnly` est
// servie depuis le pool (HTTP 200) au lieu d'échouer en 500 MISSING_LLM_CONFIG.
//
// Usage : npm run test:cache
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.E2E_PORT || '3199';
const BASE = `http://localhost:${PORT}`;
const tmpDir = mkdtempSync(join(tmpdir(), 'qc-cache-'));
const dbFile = join(tmpDir, 'cache.db');

// La base cible doit être connue AVANT le chargement de questionCache.mjs :
// sa constante DB_FILE est résolue à l'import (une seule fois).
process.env.QUESTION_CACHE_DB = dbFile;
const { addQuestions } = await import('../server/questionCache.mjs');

let passed = 0;
let failed = 0;
const ok = (l) => { passed += 1; console.log(`✓ ${l}`); };
const fail = (l, d = '') => { failed += 1; console.error(`✗ ${l}${d ? ' — ' + d : ''}`); };

const question = (n) => ({
  id: `q${n}`,
  theme: 'Culture générale',
  difficulty: 'easy',
  question: `Question de test numéro ${n} ?`,
  options: [
    { key: 'A', text: 'Réponse A' },
    { key: 'B', text: 'Réponse B' },
    { key: 'C', text: 'Réponse C' },
    { key: 'D', text: 'Réponse D' },
  ],
  answer: 'A',
  funnyOption: 'B',
  explanation: 'Explication de test suffisamment longue pour être valide.',
});

// Seed du pool AVANT de démarrer le relais (évite l'accès concurrent au fichier).
const qs = Array.from({ length: 10 }, (_, i) => question(i + 1));
const inserted = addQuestions({ theme: 'Culture générale', difficulty: 'easy', audience: 'general', sourceKey: '' }, qs);
if (inserted < 8) {
  console.error(`✗ seed insuffisant (${inserted} insérées sur 10)`);
  process.exit(1);
}

// Relais SANS configuration LLM : c'est le cas BYOK (aucun .env LLM serveur).
const relay = spawn('node', ['server/relay.mjs'], {
  stdio: 'ignore',
  env: { ...process.env, PORT, QUESTION_CACHE_DB: dbFile, ACCOUNTS_DB: join(tmpDir, 'accounts.db') },
});
const cleanup = () => {
  try { relay.kill(); } catch { /* ignore */ }
  rmSync(tmpDir, { recursive: true, force: true });
};
process.on('exit', cleanup);

let up = false;
for (let i = 0; i < 40; i += 1) {
  try { await fetch(`${BASE}/api/relay/health`); up = true; break; } catch { await sleep(150); }
}
if (!up) { console.error('✗ relais injoignable'); cleanup(); process.exit(1); }

// 1) /api/quiz/themes liste le thème seedé.
try {
  const { themes } = await (await fetch(`${BASE}/api/quiz/themes`)).json();
  ok(`GET /api/quiz/themes renvoie le thème seedé (${JSON.stringify(themes.map(t => t.theme))})`);
} catch (err) {
  fail('GET /api/quiz/themes a échoué', err.message);
}

// 2) Requête cache-only SANS en-têtes LLM → doit servir le pool (200), pas 500.
const res = await fetch(`${BASE}/api/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'cache',
    messages: [{ role: 'user', content: 'ignored' }],
    _quiz: {
      theme: 'Culture générale', difficulty: 'balanced', audience: 'general',
      sourceKey: '', exclude: [], batchSize: 8, cacheOnly: true,
    },
  }),
});
if (res.status !== 200) {
  fail(`cache-only sans LLM doit renvoyer 200, reçu ${res.status}`, await res.text());
} else {
  const envelope = await res.json();
  const content = JSON.parse(envelope.choices[0].message.content);
  const n = content.questions?.length ?? 0;
  if (n >= 8) ok(`cache-only sert ${n} questions depuis le pool (HTTP 200)`);
  else fail(`cache-only devrait servir ≥ 8 questions, reçu ${n}`);
}

// 3) cacheOnly sur un thème absent → 409 CACHE_EXHAUSTED (pas de forward LLM).
const miss = await fetch(`${BASE}/api/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'cache',
    messages: [{ role: 'user', content: 'ignored' }],
    _quiz: {
      theme: 'Thème inexistant', difficulty: 'balanced', audience: 'general',
      sourceKey: '', exclude: [], batchSize: 8, cacheOnly: true,
    },
  }),
});
if (miss.status === 409) ok('thème absent → 409 CACHE_EXHAUSTED (aucun forward LLM)');
else fail(`thème absent devrait renvoyer 409, reçu ${miss.status}`, await miss.text());

cleanup();
console.log(`\n${passed} ok, ${failed} échec(s)`);
process.exit(failed ? 1 : 0);
