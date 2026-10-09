// test/e2e.mjs — validation navigateur complète du mode en ligne (P2P).
//
// Démarre le serveur de signalisation (sert dist/), un mock LLM (questions
// pré-écrites, réponse toujours « A »), puis déroule 4 scénarios :
//   1. partie complète (lobby → question → révélation → victoire) ;
//   2. déconnexion d'un joueur en lobby (siège libéré) ;
//   3. rejoin en pleine partie (réponse restaurée) ;
//   4. mini test de charge (8 joueurs simultanés).
//
// Usage : npm run test:e2e   (puppeteer-core + Chromium via flake.nix)

import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';

const PORT = process.env.E2E_PORT || '3100';
const BASE = `http://localhost:${PORT}`;
const MOCK_PORT = '8788';

let passed = 0;
let failed = 0;
const ok = (l) => { passed += 1; console.log(`✓ ${l}`); };
const fail = (l, d = '') => { failed += 1; console.error(`✗ ${l}${d ? ' — ' + d : ''}`); };

const run = (cmd, args, env = {}) => new Promise((res, rej) => {
  const c = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  c.on('error', rej);
  c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exit ${code}`))));
});
const findChrome = () => process.env.CHROME_BIN
  || (() => { try { return execFileSync('which', ['chromium']).toString().trim(); } catch { return 'chromium'; } })();

// --- Boot : build + mock LLM + serveur de signalisation ---
await run('npm', ['run', 'build'], { LLM_CONFIG_REQUIRED: 'false' });
const kids = [];
kids.push(spawn('node', ['demo/mock-llm.mjs'], { stdio: 'ignore', env: { ...process.env, PORT: MOCK_PORT, LATENCY_MS: '120' } }));
kids.push(spawn('node', ['server/relay.mjs'], { stdio: 'ignore', env: {
  ...process.env, PORT,
  LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, LLM_API_KEY: 'test', LLM_MODEL: 'mock',
} }));
process.on('exit', () => kids.forEach((k) => { try { k.kill(); } catch {} }));

let up = false;
for (let i = 0; i < 60; i += 1) {
  try { await fetch(`${BASE}/api/relay/health`); up = true; break; } catch { await sleep(150); }
}
if (!up) { console.error('✗ serveur de signalisation injoignable'); process.exit(1); }

const headless = process.env.E2E_HEADLESS !== 'false' && process.env.E2E_HEADLESS !== '0';
const slowMo = Number(process.env.E2E_SLOWMO || 0);
const browser = await puppeteer.launch({
  executablePath: findChrome(), headless, slowMo,
  defaultViewport: { width: 1280, height: 800 },
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const clickEl = async (page, sel) => { await page.waitForSelector(sel, { timeout: 15000 }); await page.$eval(sel, (el) => el.click()); };
const newCtx = async () => browser.createBrowserContext(); // stockage isolé (clientId unique)
const closeCtx = (c) => c.close().catch(() => {});

async function hostCreateLobby() {
  const ctx = await newCtx();
  const host = await ctx.newPage();
  await host.goto(BASE, { waitUntil: 'domcontentloaded' });
  await clickEl(host, '#btn-new-session');
  await clickEl(host, 'input[name="gameMode"][value="lobby"]');
  // Score cible bas : la victoire arrive vite (5 bonnes réponses).
  await host.$eval('#target-score', (el) => { el.value = '5'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await host.waitForSelector('#btn-start:not([disabled])', { timeout: 10000 });
  await clickEl(host, '#btn-start');
  await host.waitForSelector('#lobby-link', { timeout: 15000 });
  const shareUrl = await host.$eval('#lobby-link', (el) => el.value);
  return { ctx, host, shareUrl };
}

async function playerJoin(shareUrl, name) {
  const ctx = await newCtx();
  const player = await ctx.newPage();
  await player.goto(shareUrl, { waitUntil: 'domcontentloaded' });
  await player.waitForSelector('#player-name', { timeout: 15000 });
  await player.type('#player-name', name);
  await clickEl(player, '#btn-join');
  await player.waitForFunction(
    () => document.querySelector('#question-number')?.textContent.includes('En attente'),
    { timeout: 20000 },
  );
  return { ctx, player };
}

// Bonne réponse de la question courante (côté host), via le hook de test.
async function hostAnswer(host) {
  return host.evaluate(() => {
    const s = window.__QC_STATE__.getState();
    return s.questions[s.currentIndex]?.answer || null;
  });
}

// Attend que le roster du host affiche « count / 42 ».
async function waitPlayerCount(host, count, timeout = 15000) {
  await host.waitForFunction(
    (n) => document.body.textContent.includes(`${n} / 42`),
    { timeout },
    count,
  );
}

async function startGame(host, count) {
  await sleep(500); // laisser retomber les re-rendus du lobby
  await waitPlayerCount(host, count, 20000);
  await clickEl(host, '#btn-start'); // « Démarrer la partie »
}

// ============ Scénario 1 : partie complète jusqu'à la victoire ============
{
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  const b = await playerJoin(h.shareUrl, 'Bob');
  await startGame(h.host, 2);
  ok('S1 : partie démarrée (lobby → chargement → question)');

  // Scoreboard côté joueur : 2 joueurs, « moi » mis en évidence.
  await a.player.waitForSelector('.player-scoreboard .player-scoreboard__item.is-me', { timeout: 10000 });
  const sbItems = await a.player.evaluate(() => document.querySelectorAll('.player-scoreboard__item').length);
  if (sbItems === 2) ok('S1 : scoreboard côté joueur (2 joueurs)');
  else fail('S1 : scoreboard', `items=${sbItems}`);

  // Scoreboard côté host (mode lobby) : les mêmes scores, classés.
  await h.host.waitForSelector('#leaderboard-mini .player-scoreboard__item', { timeout: 10000 });
  const hostSbItems = await h.host.evaluate(() => document.querySelectorAll('#leaderboard-mini .player-scoreboard__item').length);
  if (hostSbItems === 2) ok('S1 : scoreboard côté host (2 joueurs)');
  else fail('S1 : scoreboard host', `items=${hostSbItems}`);

  let ended = false;
  for (let i = 0; i < 15 && !ended; i += 1) {
    await a.player.waitForSelector('#player-options', { timeout: 20000 });
    const answer = await hostAnswer(h.host);
    await clickEl(a.player, `#player-options .option-card[data-key="${answer}"]`);
    await clickEl(b.player, `#player-options .option-card[data-key="${answer}"]`);
    await h.host.waitForSelector('#btn-reveal:not([disabled])', { timeout: 10000 });
    await clickEl(h.host, '#btn-reveal');
    await h.host.waitForSelector('#btn-next', { timeout: 10000 });
    await clickEl(h.host, '#btn-next');
    await sleep(400);
    const st = await h.host.evaluate(() =>
      document.querySelector('#btn-next-manche') ? 'MANCHE_END'
        : document.querySelector('.victory-screen') ? 'VICTORY' : 'QUESTION');
    if (st === 'MANCHE_END') { await clickEl(h.host, '#btn-next-manche'); ended = true; }
    else if (st === 'VICTORY') { ended = true; }
  }
  try {
    await h.host.waitForSelector('.victory-screen', { timeout: 10000 });
    ok("S1 : partie complète jusqu'à la victoire");
  } catch (e) {
    const diag = await h.host.evaluate(() => ({
      header: document.querySelector('#question-number')?.textContent,
      body: document.querySelector('#game-body')?.textContent?.slice(0, 200),
      scores: [...document.querySelectorAll('.leaderboard-mini__score')].map((el) => el.textContent),
    }));
    fail('S1', `pas de victoire — ${JSON.stringify(diag)}`);
  }
  closeCtx(h.ctx); closeCtx(a.ctx); closeCtx(b.ctx);
}

// ============ Scénario 2 : déconnexion en lobby ============
{
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  await a.player.close(); // l'onglet du joueur se ferme
  await waitPlayerCount(h.host, 0);
  ok('S2 : siège libéré à la déconnexion en lobby (0 / 42)');
  closeCtx(h.ctx); closeCtx(a.ctx);
}

// ============ Scénario 3 : rejoin en pleine partie ============
{
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  const b = await playerJoin(h.shareUrl, 'Bob');
  await startGame(h.host, 2);
  await a.player.waitForSelector('#player-options', { timeout: 20000 });
  await clickEl(a.player, '#player-options .option-card[data-key="A"]');
  // Alice recharge : rejoin + projection (sa réponse survit au rechargement).
  await a.player.reload({ waitUntil: 'domcontentloaded' });
  await a.player.waitForSelector('#player-options', { timeout: 20000 });
  const restored = await a.player.$eval('#player-options .option-card[data-key="A"]', (el) => el.classList.contains('is-selected'));
  if (restored) ok('S3 : rejoin en pleine partie (réponse restaurée)');
  else fail('S3', 'réponse non restaurée après rejoin');
  closeCtx(h.ctx); closeCtx(a.ctx); closeCtx(b.ctx);
}

// ============ Scénario 4 : test de charge (8 joueurs) ============
{
  const h = await hostCreateLobby();
  const players = [];
  for (let i = 0; i < 8; i += 1) players.push(await playerJoin(h.shareUrl, `J${i + 1}`));
  await waitPlayerCount(h.host, 8, 30000);
  ok('S4 : 8 joueurs connectés simultanément (8 / 42)');
  closeCtx(h.ctx);
  players.forEach((p) => closeCtx(p.ctx));
}

// ============ Scénario 5 : reprise du host après rechargement (F5) ============
{
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  const b = await playerJoin(h.shareUrl, 'Bob');
  await startGame(h.host, 2);
  await a.player.waitForSelector('#player-options', { timeout: 20000 });
  // Alice répond, puis le host recharge : room et état doivent survivre.
  await clickEl(a.player, '#player-options .option-card[data-key="A"]');
  // La réponse transite par le DataChannel puis est persistée (IndexedDB). Sans
  // cette attente, le rechargement pouvait partir avant l'arrivée de la réponse :
  // elle était perdue avec le canal. On attend son arrivée, puis un court délai
  // pour l'écriture de l'instantané.
  await h.host.waitForFunction(
    () => Object.values(window.__QC_STATE__.getState().roundAnswers).some(Boolean),
    { timeout: 10000 },
  );
  await sleep(300);
  await h.host.reload({ waitUntil: 'domcontentloaded' });
  // La phase QUESTION est restaurée : l'écran de jeu réapparaît côté host.
  await h.host.waitForSelector('#btn-reveal', { timeout: 20000 });
  const round = await h.host.evaluate(() => window.__QC_STATE__.getState().roundAnswers);
  const aliceId = await h.host.evaluate(() =>
    window.__QC_STATE__.getState().players.find((p) => p.name === 'Alice')?.id);
  if (aliceId && round[aliceId] === 'A') ok("S5 : reprise du host après F5 (réponse d'Alice restaurée)");
  else fail('S5', `roundAnswers = ${JSON.stringify(round)}`);
  closeCtx(h.ctx); closeCtx(a.ctx); closeCtx(b.ctx);
}

// ============ Scénario 6 : prénom déjà pris (rejet ciblé) ============
{
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
  else fail('S6', `message inattendu : ${err}`);
  closeCtx(h.ctx); closeCtx(a.ctx); closeCtx(bCtx);
}


// ============ Scénario 7 : le MJ joue aussi (siège local) ============
{
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  await waitPlayerCount(h.host, 1);
  // Le MJ rejoint sa propre partie : siège local sur son écran.
  await clickEl(h.host, '#btn-host-join');
  await h.host.type('#host-name', 'Marc');
  await clickEl(h.host, '#btn-host-confirm');
  await startGame(h.host, 2);
  await a.player.waitForSelector('#player-options', { timeout: 20000 });
  const answer = await hostAnswer(h.host);
  // Le MJ répond sur son propre écran, Alice sur le sien.
  await clickEl(h.host, `#answer-board .option-card[data-key="${answer}"]`);
  await clickEl(a.player, `#player-options .option-card[data-key="${answer}"]`);
  await h.host.waitForSelector('#btn-reveal:not([disabled])', { timeout: 10000 });
  await clickEl(h.host, '#btn-reveal');
  await h.host.waitForSelector('#btn-next', { timeout: 10000 });
  const marcScored = await h.host.evaluate(() => {
    const s = window.__QC_STATE__.getState();
    const marc = s.players.find((p) => p.name === 'Marc');
    return !!marc && marc.score > 0;
  });
  if (marcScored) ok('S7 : le MJ joue depuis son écran (réponse + score)');
  else fail('S7', 'score du MJ absent après révélation');
  closeCtx(h.ctx); closeCtx(a.ctx);
}

// ============ Scénario 8 : pause (quitter) puis reprise reconnecte les joueurs ============
{
  const h = await hostCreateLobby();
  const a = await playerJoin(h.shareUrl, 'Alice');
  const b = await playerJoin(h.shareUrl, 'Bob');
  await startGame(h.host, 2);
  await a.player.waitForSelector('#player-options', { timeout: 20000 });
  // Alice répond, puis le host « quitte » : en ligne, cela met la partie en pause.
  await clickEl(a.player, '#player-options .option-card[data-key="A"]');
  await clickEl(h.host, '#btn-quit');
  await clickEl(h.host, '.modal button[value="confirm"]');
  // Retour aux réglages : la reprise est proposée (room conservée, roster intact).
  await h.host.waitForSelector('#resume-banner:not([hidden])', { timeout: 15000 });
  await clickEl(h.host, 'button[data-resume-action="resume"]');
  // La partie est restaurée et la room reconnectée : le host revoit l'écran de jeu.
  await h.host.waitForSelector('#btn-reveal', { timeout: 20000 });
  const state = await h.host.evaluate(() => {
    const s = window.__QC_STATE__.getState();
    return { room: !!s.room, phase: s.phase, round: s.roundAnswers };
  });
  const aliceId = await h.host.evaluate(() =>
    window.__QC_STATE__.getState().players.find((p) => p.name === 'Alice')?.id);
  if (state.room && state.phase === 'QUESTION' && aliceId && state.round[aliceId] === 'A') {
    ok("S8 : pause puis reprise reconnecte la room (réponse d'Alice restaurée)");
  } else {
    fail('S8', `room=${state.room} phase=${state.phase} round=${JSON.stringify(state.round)}`);
  }
  closeCtx(h.ctx); closeCtx(a.ctx); closeCtx(b.ctx);
}

// ============ Scénario 9 : hors-ligne, le mode lobby est grisé ============
{
  const ctx = await newCtx();
  const host = await ctx.newPage();
  await host.goto(BASE, { waitUntil: 'domcontentloaded' });
  await clickEl(host, '#btn-new-session');
  // Coupure réseau : l'option « Lobby en ligne » devient indisponible.
  await host.setOfflineMode(true);
  await host.waitForFunction(
    () => document.querySelector('input[name="gameMode"][value="lobby"]')?.disabled === true,
    { timeout: 10000 },
  );
  // Retour en ligne : l'option redevient sélectionnable.
  await host.setOfflineMode(false);
  await host.waitForFunction(
    () => document.querySelector('input[name="gameMode"][value="lobby"]')?.disabled === false,
    { timeout: 10000 },
  );
  ok('S9 : hors-ligne → lobby grisé, puis dégrisé en ligne');
  closeCtx(ctx);
}

await browser.close();
kids.forEach((k) => { try { k.kill(); } catch {} });
console.log(`\n${passed} test(s) OK, ${failed} échec(s).`);
process.exit(failed ? 1 : 0);
