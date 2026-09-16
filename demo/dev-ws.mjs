// demo/dev-ws.mjs — démarre tout le nécessaire pour développer le multijoueur :
//   Redis (local, éphémère) + relais WS (/api sur :3000) + front Vite (:5173).
//
// Usage : npm run dev-ws        (Ctrl+C pour tout arrêter)
//
// - Si REDIS_URL est définie, on réutilise ce Redis au lieu d'en lancer un.
// - Sinon on lance un `redis-server` local sur REDIS_PORT (défaut : 6380).
//   `redis-server` doit être dans le PATH (fourni par `nix develop`).

import { spawn } from 'node:child_process';

const REDIS_PORT = process.env.REDIS_PORT || '6380';
const REDIS_URL = process.env.REDIS_URL || `redis://localhost:${REDIS_PORT}`;

const children = [];
let shuttingDown = false;

function start(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: opts.quiet ? 'ignore' : 'inherit',
    env: { ...process.env, ...(opts.env || {}) },
  });
  children.push(child);
  child.on('error', (err) => {
    if (!shuttingDown) console.error(`[dev-ws] impossible de lancer « ${cmd} » : ${err.message}`);
  });
  child.on('exit', (code) => {
    if (!shuttingDown && (code ?? 0) !== 0) {
      console.error(`[dev-ws] « ${cmd} ${args.join(' ')} » a quitté (code ${code}).`);
    }
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[dev-ws] arrêt…');
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// 1) Redis local, sauf si une REDIS_URL est déjà fournie.
if (!process.env.REDIS_URL) {
  console.log(`[dev-ws] Redis local sur :${REDIS_PORT} (éphémère).`);
  start('redis-server', ['--port', REDIS_PORT, '--save', '', '--appendonly', 'no'], { quiet: true });
} else {
  console.log(`[dev-ws] Redis existant : ${REDIS_URL}`);
}

// 2) Relais WS (/api) sur :3000.
start('node', ['demo/dev-server.mjs'], { env: { REDIS_URL } });

// 3) Front (Vite) sur :5173.
start('npm', ['run', 'dev']);

console.log('[dev-ws] relais WS → http://localhost:3000 · front Vite → http://localhost:5173');
console.log('[dev-ws] Ctrl+C pour tout arrêter.');
