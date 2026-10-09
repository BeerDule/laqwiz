// test/e2e-prod.mjs — validation E2E du DÉPLOIEMENT EN LIGNE (quiz.wagu.lu).
//
// Contrairement à test/e2e.mjs (qui monte un relais + mock LLM locaux), ce
// fichier teste le site de production : signalisation réelle, DataChannel via
// les ICE configurés (STUN/TURN), ping de latence réel. Aucune génération de
// questions (donc aucun appel LLM) : on s'arrête au lobby, avant « Démarrer ».
//
// Usage : npm run test:e2e:prod   (puppeteer-core + Chromium via flake.nix)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';

const BASE = process.env.E2E_PROD_URL || 'https://quiz.wagu.lu';

let passed = 0;
let failed = 0;
const ok = (l) => { passed += 1; console.log(`✓ ${l}`); };
const fail = (l, d = '') => { failed += 1; console.error(`✗ ${l}${d ? ' — ' + d : ''}`); };

const findChrome = () => process.env.CHROME_BIN
  || (() => { try { return execFileSync('which', ['chromium']).toString().trim(); } catch { return 'chromium'; } })();

const clickEl = async (page, sel) => { await page.waitForSelector(sel, { timeout: 20000 }); await page.$eval(sel, (el) => el.click()); };
const newCtx = async () => browser.createBrowserContext();
const closeCtx = (c) => c.close().catch(() => {});

// Lit la config LLM du .env local (clé réelle) pour les scénarios qui génèrent
// de vraies questions. Repli sur une config factice si absent (scénarios lobby).
function loadLocalEnv() {
  const out = {};
  try {
    const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* pas de .env : config factice */ }
  return out;
}
const LOCAL_ENV = loadLocalEnv();

const LLM_SEED = {
  baseUrl: LOCAL_ENV.LLM_BASE_URL || 'https://api.mammouth.ai/v1',
  apiKey: LOCAL_ENV.LLM_API_KEY || 'dummy-e2e-prod',
  model: LOCAL_ENV.LLM_MODEL || 'gpt-4.1-mini',
  temperature: Number(LOCAL_ENV.LLM_TEMPERATURE) || 0.9,
  batchSize: Number(LOCAL_ENV.LLM_BATCH_SIZE) || 8,
};
function seedLlm(page) {
  return page.evaluateOnNewDocument((cfg) => {
    localStorage.setItem('quizz-canape:llm', JSON.stringify(cfg));
  }, LLM_SEED);
}

async function hostCreateLobby() {
  const ctx = await newCtx();
  const host = await ctx.newPage();
  await seedLlm(host);
  await trackNet(host);
  await host.goto(BASE, { waitUntil: 'domcontentloaded' });
  await clickEl(host, '#btn-new-session');
  await clickEl(host, 'input[name="gameMode"][value="lobby"]');
  await host.waitForSelector('#btn-start:not([disabled])', { timeout: 15000 });
  await clickEl(host, '#btn-start');
  await host.waitForSelector('#lobby-link', { timeout: 20000 });
  const shareUrl = await host.$eval('#lobby-link', (el) => el.value);
  return { ctx, host, shareUrl };
}

async function playerJoin(shareUrl, name) {
  const ctx = await newCtx();
  const player = await ctx.newPage();
  await trackNet(player);
  await player.goto(shareUrl, { waitUntil: 'domcontentloaded' });
  await player.waitForSelector('#player-name', { timeout: 15000 });
  await player.type('#player-name', name);
  await clickEl(player, '#btn-join');
  await player.waitForFunction(
    () => document.querySelector('#question-number')?.textContent.includes('En attente'),
    { timeout: 25000 },
  );
  return { ctx, player };
}

async function waitPlayerCount(host, count, timeout = 20000) {
  await host.waitForFunction((n) => document.body.textContent.includes(`${n} / 42`), { timeout }, count);
}

async function waitForPing(page, timeout = 15000) {
  await page.waitForFunction(
    () => /Ping \d+ ms/.test(document.querySelector('#conn-indicator')?.textContent || ''),
    { timeout },
  );
}

// Traque les WebSocket et RTCPeerConnection créés par la page, pour pouvoir les
// fermer de force : `setOfflineMode` ne ferme PAS les connexions existantes dans
// Chrome. On simule ainsi une vraie coupure réseau (le module reconnecte seul).
async function trackNet(page) {
  await page.evaluateOnNewDocument(() => {
    window.__qcSockets = [];
    window.__qcPeers = [];
    const OrigWS = window.WebSocket;
    function TWS(url, protocols) { const ws = new OrigWS(url, protocols); window.__qcSockets.push(ws); return ws; }
    TWS.prototype = OrigWS.prototype;
    // Préserve les constantes statiques (OPEN/…) : l'app compare `readyState === WebSocket.OPEN`.
    for (const k of ['OPEN', 'CONNECTING', 'CLOSING', 'CLOSED']) TWS[k] = OrigWS[k];
    window.WebSocket = TWS;
    const OrigRTC = window.RTCPeerConnection;
    function TRTC(...args) { const pc = new OrigRTC(...args); window.__qcPeers.push(pc); return pc; }
    TRTC.prototype = OrigRTC.prototype;
    window.RTCPeerConnection = TRTC;
  });
}

// Ferme WS + DataChannel : coupure réseau brutale (le module reconnecte seul).
async function dropNet(page) {
  await page.evaluate(() => {
    for (const ws of window.__qcSockets || []) { try { ws.close(); } catch { /* ignore */ } }
    for (const pc of window.__qcPeers || []) { try { pc.close(); } catch { /* ignore */ } }
  });
}

// Ferme seulement les DataChannels (RTCPeerConnection), en gardant le WS vivant.
async function dropPeers(page) {
  await page.evaluate(() => {
    for (const pc of window.__qcPeers || []) { try { pc.close(); } catch { /* ignore */ } }
  });
}

// Attend que l'indicateur affiche « Reconnexion… » (WS effectivement tombé).
async function waitForReconnecting(page, timeout = 10000) {
  await page.waitForFunction(
    () => document.querySelector('#conn-indicator')?.textContent.includes('Reconnexion'),
    { timeout },
  );
}

// Bonne réponse de la question courante (côté host), via le hook de test.
async function hostAnswer(host) {
  return host.evaluate(() => {
    const s = window.__QC_STATE__.getState();
    return s.questions[s.currentIndex]?.answer || null;
  });
}

const run = async (name, fn) => {
  try { await fn(); }
  catch (e) { fail(name, (e.message || String(e)).slice(0, 160)); }
};

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: process.env.E2E_HEADLESS !== 'false' && process.env.E2E_HEADLESS !== '0',
  slowMo: Number(process.env.E2E_SLOWMO || 0),
  defaultViewport: { width: 1280, height: 800 },
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

// 1) Site + relais en santé.
await run('S1 : site + relais en santé', async () => {
  const home = await fetch(BASE);
  const health = await fetch(`${BASE}/api/relay/health`).then((r) => r.json());
  if (home.ok && health.ok) ok(`S1 : site + relais en santé (${BASE})`);
  else fail('S1', `home=${home.status} health=${JSON.stringify(health)}`);
});

// 2) Le host crée un lobby (lien d'invitation).
await run('S2 : le host crée un lobby', async () => {
  const h = await hostCreateLobby();
  if (h.shareUrl.includes('#join=')) ok('S2 : le host crée un lobby (lien + QR)');
  else fail('S2', `shareUrl=${h.shareUrl}`);
  closeCtx(h.ctx);
});

// 3) Un joueur rejoint via le lien → DataChannel ouvert.
await run('S3 : un joueur rejoint via le lien', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  ok('S3 : un joueur rejoint via le lien (DataChannel ouvert)');
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 4) Le roster s'enrichit (2 joueurs).
await run('S4 : le roster atteint 2 joueurs', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  const b = await playerJoin(h.shareUrl, 'Bob');
  await waitPlayerCount(h.host, 2);
  ok('S4 : le roster atteint 2 joueurs');
  closeCtx(h.ctx); closeCtx(a.ctx); closeCtx(b.ctx);
});

// 5) Le ping affiche une latence réelle en ms (host et joueur).
await run('S5 : ping de latence réel', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitForPing(h.host);
  await waitForPing(a.player);
  const label = await h.host.$eval('#conn-indicator', (el) => el.textContent);
  ok(`S5 : ping de latence réel (${label})`);
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 6) Prénom déjà pris → rejet ciblé.
await run('S6 : prénom déjà pris', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  const bCtx = await newCtx();
  const b = await bCtx.newPage();
  await b.goto(h.shareUrl, { waitUntil: 'domcontentloaded' });
  await b.waitForSelector('#player-name', { timeout: 15000 });
  await b.type('#player-name', 'Alice');
  await clickEl(b, '#btn-join');
  await b.waitForSelector('#player-error:not([hidden])', { timeout: 15000 });
  const err = await b.$eval('#player-error', (el) => el.textContent);
  if (err.includes('pris')) ok('S6 : prénom déjà pris → rejet ciblé');
  else fail('S6', `message=${err}`);
  closeCtx(h.ctx); closeCtx(a.ctx); closeCtx(bCtx);
});

// 7) Déconnexion d'un joueur → siège libéré.
await run("S7 : déconnexion d'un joueur", async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await a.player.close();
  await waitPlayerCount(h.host, 0);
  ok('S7 : siège libéré à la déconnexion');
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 8) Rejoin d'un joueur (rechargement, identité persistée).
await run("S8 : rejoin d'un joueur", async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await a.player.reload({ waitUntil: 'domcontentloaded' });
  await a.player.waitForFunction(
    () => document.querySelector('#question-number')?.textContent.includes('En attente'),
    { timeout: 25000 },
  );
  ok("S8 : rejoin d'un joueur (identité persistée)");
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 9) Le MJ joue aussi (siège local).
await run('S9 : le MJ joue aussi', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await clickEl(h.host, '#btn-host-join');
  await h.host.type('#host-name', 'Marc');
  await clickEl(h.host, '#btn-host-confirm');
  await waitPlayerCount(h.host, 2);
  ok('S9 : le MJ joue aussi (siège local)');
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 10) Reprise du host après F5 (lobby restauré, joueur re-connecté).
await run('S10 : reprise du host après F5', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await h.host.reload({ waitUntil: 'domcontentloaded' });
  await h.host.waitForSelector('#lobby-link', { timeout: 20000 });
  await waitPlayerCount(h.host, 1);
  ok('S10 : reprise du host après F5 (lobby restauré, joueur re-connecté)');
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// ============ Déconnexion inopinée (coupures réseau) ============

// 11) Host coupure réseau → reconnexion → le ping revient (WS rétabli).
await run('S11 : host coupure réseau → reconnexion WS', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await dropNet(h.host);
  await waitForReconnecting(h.host);
  await waitForPing(h.host);
  ok('S11 : host coupure réseau → reconnexion WS (ping rétabli)');
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 12) Joueur coupure réseau → siège libéré puis rejoint automatiquement.
await run('S12 : joueur coupure réseau → rejoin auto', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await dropNet(a.player);
  await waitPlayerCount(h.host, 0); // pendant offline : siège libéré
  await waitPlayerCount(h.host, 1); // rejoin automatique
  ok('S12 : joueur coupure réseau → siège libéré puis rejoin auto');
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 13) Après reconnexion du host, un nouveau joueur peut rejoindre.
await run('S13 : host reconnecté → nouveau joueur accepté', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await dropNet(h.host);
  await waitForPing(h.host);
  const b = await playerJoin(h.shareUrl, 'Bob');
  await waitPlayerCount(h.host, 2);
  ok('S13 : host reconnecté → nouveau joueur accepté');
  closeCtx(h.ctx); closeCtx(a.ctx); closeCtx(b.ctx);
});

// 14) Rejoin après coupure → pas de doublon dans le roster.
await run('S14 : rejoin sans doublon', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await dropNet(a.player);
  await waitPlayerCount(h.host, 0); // siège libéré
  await waitPlayerCount(h.host, 1); // rejoin automatique
  await sleep(1000);
  const n = await h.host.evaluate(() => window.__QC_STATE__.getState().players.length);
  if (n === 1) ok('S14 : rejoin sans doublon (1 joueur)');
  else fail('S14', `players=${n}`);
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 15) Coupure simultanée host + joueur → les deux récupèrent.
await run('S15 : coupure simultanée host + joueur', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await dropNet(h.host);
  await dropNet(a.player);
  await waitPlayerCount(h.host, 1);
  ok('S15 : coupure simultanée host + joueur → récupération');
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 16) Double coupure rapide du joueur → récupération.
await run('S16 : double coupure rapide du joueur', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await dropNet(a.player);
  await dropNet(a.player);
  await waitPlayerCount(h.host, 1);
  ok('S16 : double coupure rapide du joueur → récupération');
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 17) Joueur coupure pendant que le host est offline (course).
await run('S17 : coupure joueur pendant host offline', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await dropNet(h.host);
  await dropNet(a.player);
  await waitPlayerCount(h.host, 1);
  ok('S17 : coupure joueur pendant host offline → récupération');
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 18) Le lien d'invitation reste identique après reconnexion du host.
await run('S18 : lien stable après reconnexion', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await dropNet(h.host);
  await waitForPing(h.host);
  const url = await h.host.$eval('#lobby-link', (el) => el.value);
  if (url === h.shareUrl) ok("S18 : lien d'invitation stable après reconnexion");
  else fail('S18', `url=${url}`);
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 19) L'identité du joueur survit à une coupure réseau.
await run('S19 : identité du joueur préservée', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await dropNet(a.player);
  await waitPlayerCount(h.host, 1);
  const text = await a.player.evaluate(() => document.querySelector('#game-body')?.textContent || '');
  if (text.includes('Alice')) ok("S19 : identité du joueur préservée (Alice)");
  else fail('S19', `body=${text.slice(0, 80)}`);
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 20) Deux joueurs coupés → le roster revient à 2.
await run('S20 : deux joueurs coupés → roster restauré', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  const b = await playerJoin(h.shareUrl, 'Bob');
  await waitPlayerCount(h.host, 2);
  await dropNet(a.player);
  await dropNet(b.player);
  await waitPlayerCount(h.host, 2);
  ok('S20 : deux joueurs coupés → roster restauré à 2');
  closeCtx(h.ctx); closeCtx(a.ctx); closeCtx(b.ctx);
});

// ============ Cas limites & robustesse supplémentaires ============

// 21) Le host quitte le lobby → room.closed → les joueurs voient « terminée ».
await run('S21 : host quitte → room.closed', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await clickEl(h.host, '#btn-quit');
  await a.player.waitForFunction(
    () => document.querySelector('#game-body')?.textContent.includes('terminée'),
    { timeout: 15000 },
  );
  ok('S21 : host quitte → les joueurs voient « partie terminée »');
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 22) Le joueur se déconnecte (bouton) → siège libéré.
await run("S22 : joueur se déconnecte (bouton)", async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await clickEl(a.player, '#btn-disconnect');
  await waitPlayerCount(h.host, 0);
  ok('S22 : joueur se déconnecte (bouton) → siège libéré');
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 23) Coupure du canal direct seul (DataChannel) → le host re-propose (reprise).
await run('S23 : coupure DataChannel seule → reprise', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await dropPeers(h.host); // ferme le DataChannel, garde le WS
  await sleep(2000); // laisse le re-offer (schedulePeerRestart) aboutir
  await waitForPing(h.host); // WS intact
  await waitPlayerCount(h.host, 1); // siège conservé
  ok('S23 : coupure DataChannel seule → reprise (WS + siège conservés)');
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 24) Charge moyenne : 6 joueurs.
await run('S24 : 6 joueurs (charge moyenne)', async () => {
  const h = await hostCreateLobby();
  const players = [];
  for (let i = 0; i < 6; i += 1) players.push(await playerJoin(h.shareUrl, `P${i + 1}`));
  await waitPlayerCount(h.host, 6, 30000);
  ok('S24 : 6 joueurs connectés (6 / 42)');
  closeCtx(h.ctx);
  players.forEach((p) => closeCtx(p.ctx));
});

// 25) Nom avec HTML → échappé (pas d'injection).
await run('S25 : nom avec HTML échappé', async () => {
  const h = await hostCreateLobby();
  const aCtx = await newCtx();
  const a = await aCtx.newPage();
  await trackNet(a);
  await a.goto(h.shareUrl, { waitUntil: 'domcontentloaded' });
  await a.waitForSelector('#player-name', { timeout: 15000 });
  await a.$eval('#player-name', (el) => { el.value = '<b>x</b>'; });
  await clickEl(a, '#btn-join');
  await waitPlayerCount(h.host, 1);
  const injected = await h.host.evaluate(() => !!document.querySelector('.lobby-roster b'));
  if (!injected) ok("S25 : nom avec HTML échappé (pas d'injection)");
  else fail('S25', 'balise <b> injectée dans le roster');
  closeCtx(h.ctx); closeCtx(aCtx);
});

// 26) Nom vide → erreur côté joueur.
await run('S26 : nom vide → erreur', async () => {
  const h = await hostCreateLobby();
  const aCtx = await newCtx();
  const a = await aCtx.newPage();
  await a.goto(h.shareUrl, { waitUntil: 'domcontentloaded' });
  await a.waitForSelector('#player-name', { timeout: 15000 });
  await clickEl(a, '#btn-join');
  await a.waitForSelector('#player-error:not([hidden])', { timeout: 10000 });
  const err = await a.$eval('#player-error', (el) => el.textContent);
  if (err.includes('prénom')) ok('S26 : nom vide → erreur côté joueur');
  else fail('S26', `message=${err}`);
  closeCtx(h.ctx); closeCtx(aCtx);
});

// 27) Changement d'identité (nom/avatar).
await run("S27 : changement d'identité", async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await clickEl(a.player, '#btn-change-identity');
  await a.player.waitForSelector('#player-name', { timeout: 15000 });
  await a.player.type('#player-name', 'Bob');
  await clickEl(a.player, '#btn-join');
  await waitPlayerCount(h.host, 1);
  const names = await h.host.evaluate(() => window.__QC_STATE__.getState().players.map((p) => p.name));
  if (names.includes('Bob') && !names.includes('Alice')) ok("S27 : changement d'identité (Alice → Bob)");
  else fail('S27', `names=${JSON.stringify(names)}`);
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 28) Le MJ se retire du siège local.
await run('S28 : le MJ se retire du siège local', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await clickEl(h.host, '#btn-host-join');
  await h.host.type('#host-name', 'Marc');
  await clickEl(h.host, '#btn-host-confirm');
  await waitPlayerCount(h.host, 2);
  await clickEl(h.host, '#btn-host-leave');
  await waitPlayerCount(h.host, 1);
  ok('S28 : le MJ se retire du siège local (retour à 1 joueur)');
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 29) Ping raisonnable (< 1000 ms).
await run('S29 : ping raisonnable (< 1000 ms)', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitForPing(h.host);
  const label = await h.host.$eval('#conn-indicator', (el) => el.textContent);
  const m = /Ping (\d+) ms/.exec(label);
  const ms = m ? Number(m[1]) : NaN;
  if (Number.isFinite(ms) && ms > 0 && ms < 1000) ok(`S29 : ping raisonnable (${label})`);
  else fail('S29', `label=${label}`);
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// 30) Stress : multiples reconnexions.
await run('S30 : multiples reconnexions (stress)', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  for (let i = 0; i < 4; i += 1) {
    await dropNet(a.player);
    await sleep(1500);
  }
  await waitPlayerCount(h.host, 1);
  const n = await h.host.evaluate(() => window.__QC_STATE__.getState().players.length);
  if (n === 1) ok('S30 : multiples reconnexions (4 coupures) → 1 joueur');
  else fail('S30', `players=${n}`);
  closeCtx(h.ctx); closeCtx(a.ctx);
});

// ============ Questions réelles + déconnexion/reconnexion en pleine partie ============

// 31) Le jeu démarre avec de vraies questions (LLM du .env).
await run('S31 : le jeu démarre (question générée)', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  const b = await playerJoin(h.shareUrl, 'Bob');
  await waitPlayerCount(h.host, 2);
  await clickEl(h.host, '#btn-start');
  await h.host.waitForSelector('#btn-reveal', { timeout: 30000 });
  await a.player.waitForSelector('#player-options', { timeout: 30000 });
  ok('S31 : le jeu démarre (question générée côté host et joueur)');
  closeCtx(h.ctx); closeCtx(a.ctx); closeCtx(b.ctx);
});

// 32) Réponse puis coupure host → question + réponse préservées.
await run('S32 : réponse + coupure host → réponse préservée', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  const b = await playerJoin(h.shareUrl, 'Bob');
  await waitPlayerCount(h.host, 2);
  await clickEl(h.host, '#btn-start');
  await a.player.waitForSelector('#player-options', { timeout: 30000 });
  const answer = await hostAnswer(h.host);
  await clickEl(a.player, `#player-options .option-card[data-key="${answer}"]`);
  await sleep(500);
  await dropNet(h.host);
  await waitForReconnecting(h.host);
  await waitForPing(h.host);
  const round = await h.host.evaluate(() => window.__QC_STATE__.getState().roundAnswers);
  const aliceId = await h.host.evaluate(() => window.__QC_STATE__.getState().players.find((p) => p.name === 'Alice')?.id);
  if (aliceId && round[aliceId] === answer) ok('S32 : réponse préservée après coupure host');
  else fail('S32', `roundAnswers=${JSON.stringify(round)}`);
  closeCtx(h.ctx); closeCtx(a.ctx); closeCtx(b.ctx);
});

// 33) Réponse puis coupure joueur → sélection restaurée.
await run('S33 : réponse + coupure joueur → sélection restaurée', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  const b = await playerJoin(h.shareUrl, 'Bob');
  await waitPlayerCount(h.host, 2);
  await clickEl(h.host, '#btn-start');
  await a.player.waitForSelector('#player-options', { timeout: 30000 });
  const answer = await hostAnswer(h.host);
  await clickEl(a.player, `#player-options .option-card[data-key="${answer}"]`);
  await sleep(500);
  await dropNet(a.player);
  await sleep(1500); // rejoin automatique (backoff)
  await a.player.waitForSelector(`#player-options .option-card[data-key="${answer}"].is-selected`, { timeout: 30000 });
  ok('S33 : sélection restaurée après coupure joueur');
  closeCtx(h.ctx); closeCtx(a.ctx); closeCtx(b.ctx);
});

// 34) Révélation puis coupure host → phase préservée.
await run('S34 : révélation + coupure host → phase préservée', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  const b = await playerJoin(h.shareUrl, 'Bob');
  await waitPlayerCount(h.host, 2);
  await clickEl(h.host, '#btn-start');
  await a.player.waitForSelector('#player-options', { timeout: 30000 });
  const answer = await hostAnswer(h.host);
  await clickEl(a.player, `#player-options .option-card[data-key="${answer}"]`);
  await clickEl(b.player, `#player-options .option-card[data-key="${answer}"]`);
  await h.host.waitForSelector('#btn-reveal:not([disabled])', { timeout: 15000 });
  await clickEl(h.host, '#btn-reveal');
  await h.host.waitForSelector('#btn-next', { timeout: 15000 });
  await dropNet(h.host);
  await waitForReconnecting(h.host);
  await waitForPing(h.host);
  const phase = await h.host.evaluate(() => window.__QC_STATE__.getState().phase);
  if (phase === 'REVEAL') ok('S34 : phase REVEAL préservée après coupure host');
  else fail('S34', `phase=${phase}`);
  closeCtx(h.ctx); closeCtx(a.ctx); closeCtx(b.ctx);
});

// 35) Révélation puis coupure joueur → le joueur re-connecte.
await run('S35 : révélation + coupure joueur → rejoin', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  const b = await playerJoin(h.shareUrl, 'Bob');
  await waitPlayerCount(h.host, 2);
  await clickEl(h.host, '#btn-start');
  await a.player.waitForSelector('#player-options', { timeout: 30000 });
  const answer = await hostAnswer(h.host);
  await clickEl(a.player, `#player-options .option-card[data-key="${answer}"]`);
  await clickEl(b.player, `#player-options .option-card[data-key="${answer}"]`);
  await h.host.waitForSelector('#btn-reveal:not([disabled])', { timeout: 15000 });
  await clickEl(h.host, '#btn-reveal');
  await h.host.waitForSelector('#btn-next', { timeout: 15000 });
  await dropNet(a.player);
  await sleep(1500);
  await waitForPing(a.player);
  const phase = await h.host.evaluate(() => window.__QC_STATE__.getState().phase);
  if (phase === 'REVEAL') ok('S35 : rejoin joueur pendant la révélation (phase REVEAL)');
  else fail('S35', `phase=${phase}`);
  closeCtx(h.ctx); closeCtx(a.ctx); closeCtx(b.ctx);
});

// 36) Coupure joueur avant réponse → réponse acceptée après rejoin.
await run('S36 : coupure avant réponse → réponse après rejoin', async () => {
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  const b = await playerJoin(h.shareUrl, 'Bob');
  await waitPlayerCount(h.host, 2);
  await clickEl(h.host, '#btn-start');
  await a.player.waitForSelector('#player-options', { timeout: 30000 });
  await dropNet(a.player);
  await sleep(1500);
  await a.player.waitForSelector('#player-options', { timeout: 30000 });
  const answer = await hostAnswer(h.host);
  await clickEl(a.player, `#player-options .option-card[data-key="${answer}"]`);
  await sleep(500);
  const round = await h.host.evaluate(() => window.__QC_STATE__.getState().roundAnswers);
  const aliceId = await h.host.evaluate(() => window.__QC_STATE__.getState().players.find((p) => p.name === 'Alice')?.id);
  if (aliceId && round[aliceId] === answer) ok('S36 : réponse acceptée après rejoin');
  else fail('S36', `roundAnswers=${JSON.stringify(round)}`);
  closeCtx(h.ctx); closeCtx(a.ctx); closeCtx(b.ctx);
});

await browser.close();
console.log(`\n${passed} test(s) OK, ${failed} échec(s).`);
process.exit(failed ? 1 : 0);
