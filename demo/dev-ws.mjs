// demo/dev-ws.mjs — démarre le relais WS auto-hébergé (server/relay.mjs sur
// :3000) + le front Vite (:5173). Plus de Redis : le relais tient les rooms en
// mémoire.
//
// Usage : npm run dev-ws        (Ctrl+C pour tout arrêter)

import { spawn } from 'node:child_process';

const children = [];
let shuttingDown = false;

function start(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
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

// 1) Relais WS auto-hébergé sur :3000.
start('node', ['server/relay.mjs']);

// 2) Front (Vite) sur :5173.
start('npm', ['run', 'dev']);

console.log('[dev-ws] relais WS → http://localhost:3000 · front Vite → http://localhost:5173');
console.log('[dev-ws] Ctrl+C pour tout arrêter.');
