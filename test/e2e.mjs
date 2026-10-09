// test/e2e.mjs — validation navigateur du transport P2P (WebRTC DataChannel).
//
// Démarre le serveur de signalisation (qui sert aussi dist/), lance Chromium via
// puppeteer-core, puis déroule le flux réel : le host crée un lobby, un joueur
// rejoint via le lien, et on vérifie que le canal direct s'ouvre — le joueur
// n'atteint l'écran « connecté » qu'à la réception du roster par le DataChannel.
//
// Prérequis :
//   - un Chromium accessible (CHROME_BIN, ou `chromium` dans le PATH — fourni
//     par `nix develop` via flake.nix) ;
//   - puppeteer-core installé (`npm install`).
//
// Usage : npm run test:e2e

import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';

const PORT = process.env.E2E_PORT || '3100';
const BASE = `http://localhost:${PORT}`;

let passed = 0;
function ok(label) { passed += 1; console.log(`✓ ${label}`); }
function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} a quitté (code ${code})`))));
  });
}

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  try { return execFileSync('which', ['chromium']).toString().trim(); } catch { return 'chromium'; }
}

// --- 0) Build : le lobby ne doit pas exiger de config LLM (elle n'est requise
//        qu'au moment de générer les questions, pas pour ouvrir le lobby). ---
await run('npm', ['run', 'build'], { LLM_CONFIG_REQUIRED: 'false' });

// --- 1) Serveur de signalisation (sert dist/ + /api + WS). ---
const relay = spawn('node', ['server/relay.mjs'], { stdio: 'ignore', env: { ...process.env, PORT } });
process.on('exit', () => { try { relay.kill(); } catch {} });

let up = false;
for (let i = 0; i < 50; i += 1) {
  try { await fetch(`${BASE}/api/relay/health`); up = true; break; } catch { await sleep(150); }
}
if (!up) { relay.kill(); fail('serveur de signalisation injoignable'); }

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

try {
  // Clic natif (el.click()) : contourne le contrôle de cliquabilité de Puppeteer,
  // inopérant sur les inputs radio stylés/recouverts par le thème.
  const clickEl = async (page, selector) => {
    await page.waitForSelector(selector, { timeout: 15000 });
    await page.$eval(selector, (el) => el.click());
  };

  // --- 2) Host : créer le lobby. ---
  const host = await browser.newPage();
  await host.goto(BASE, { waitUntil: 'domcontentloaded' });
  await clickEl(host, '#btn-new-session');
  await clickEl(host, 'input[name="gameMode"][value="lobby"]');
  await host.waitForSelector('#btn-start:not([disabled])', { timeout: 10000 });
  await clickEl(host, '#btn-start');
  await host.waitForSelector('#lobby-link', { timeout: 15000 });
  const shareUrl = await host.$eval('#lobby-link', (el) => el.value);
  if (!shareUrl.includes('#join=')) fail("lien d'invitation introuvable");
  ok('host : lobby créé, lien d\'invitation présent');

  // --- 3) Player : rejoindre via le lien. ---
  const player = await browser.newPage();
  await player.goto(shareUrl, { waitUntil: 'domcontentloaded' });
  await player.waitForSelector('#player-name', { timeout: 15000 });
  await player.type('#player-name', 'Alice');
  await clickEl(player, '#btn-join');
  // L'écran « connecté » n'apparaît qu'à la réception du roster par le DataChannel.
  await player.waitForFunction(
    () => document.querySelector('#question-number')?.textContent.includes('En attente'),
    { timeout: 20000 },
  );
  ok('player : écran « connecté » atteint (roster reçu via le DataChannel)');

  // --- 4) Host : voit la joueuse dans le roster. ---
  await host.waitForFunction(
    () => document.querySelector('.arcade-plaque__name')?.textContent.includes('1 /'),
    { timeout: 10000 },
  );
  ok('host : le roster compte la joueuse (1 / 42)');
} catch (err) {
  console.error('✗ échec du test E2E :', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  relay.kill();
}

if (!process.exitCode) console.log(`\n${passed} test(s) OK.`);
