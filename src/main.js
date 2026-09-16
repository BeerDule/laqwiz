// main.js — bootstrap, routage d'écrans, hydratation (SPEC §9.5, §12.1).
import './styles/theme.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/arcade.css';

import { getState, dispatch, subscribe } from './state.js';
import { loadPlayers, loadSettings, loadStats, savePlayers, saveSettings, loadActiveSessionId, loadLlmConfig, saveLlmConfig } from './storage.js';
import { getSession, listResumes } from './db.js';
import { renderSetup, unmountSetup } from './screens/setup.js';
import { renderGame, unmountGame } from './screens/game.js';
import { renderVictory, unmountVictory } from './screens/victory.js';
import { renderSessions, unmountSessions } from './screens/sessions.js';
import { renderHome, unmountHome } from './screens/home.js';
import { renderSettings, unmountSettings } from './screens/settings.js';
import { initColorTheme, setColorTheme } from './themeSwitcher.js';
import { decodeShareConfig } from './shareConfig.js';
import { loadModes } from './modes.js';
import { initMechaBackdrop } from './mechaBackdrop.js';

// Appliquer le thème de couleurs sauvegardé avant le premier rendu
initColorTheme();
// Fond animé du thème Mecha : s'allume et s'éteint seul selon le thème actif
initMechaBackdrop();

const app = document.getElementById('app');

// --- Navigation persistante (coquille d'app) ---
// Visible uniquement sur les écrans « app » (Accueil / Sessions / Réglages).
// Pendant le réglage, le jeu et la victoire, l'écran est pleine page : la barre
// se retire pour laisser place à l'immersion.
const appNav = document.getElementById('app-nav');
const NAV_PHASES = new Set(['HOME', 'SESSIONS', 'SETTINGS']);
function syncAppNav(phase) {
  if (!appNav) return;
  const visible = NAV_PHASES.has(phase);
  appNav.hidden = !visible;
  document.body.classList.toggle('with-app-nav', visible);
  appNav.querySelectorAll('[data-nav]').forEach((btn) => {
    const active = (btn.dataset.nav === 'home' && phase === 'HOME')
      || (btn.dataset.nav === 'sessions' && phase === 'SESSIONS')
      || (btn.dataset.nav === 'settings' && phase === 'SETTINGS');
    btn.classList.toggle('is-active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
}
appNav?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-nav]');
  if (!btn) return;
  const action = {
    home: 'GOTO_HOME',
    sessions: 'GOTO_SESSIONS',
    settings: 'GOTO_SETTINGS',
    play: 'NEW_GAME',
  }[btn.dataset.nav];
  if (action) dispatch({ type: action });
});
syncAppNav(getState().phase);

// --- Toast (non bloquant, dans #toast-region) ---
function showToast(message, kind = 'info') {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  region.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
document.addEventListener('qc:toast', (e) => {
  showToast(e.detail?.message || '', e.detail?.kind || 'info');
});

// --- Hydratation depuis localStorage ---
const persistedPlayers = loadPlayers();
const persistedSettings = loadSettings();
const persistedStats = loadStats();
const persistedLlm = loadLlmConfig();

if (persistedPlayers) dispatch({ type: 'SET_PLAYERS', players: persistedPlayers });
if (persistedSettings) dispatch({ type: 'SET_SETTINGS', patch: persistedSettings });
if (persistedLlm) dispatch({ type: 'SET_LLM', patch: persistedLlm });
if (persistedStats) getState().stats = persistedStats;

// --- Import d'une configuration partagée (?config=…) ---
// Placé APRÈS l'hydratation localStorage, et c'est voulu : un lien reçu doit
// écraser ce que l'appareil avait déjà, sinon partager sa config à une TV qui a
// déjà servi ne changerait rien.
//
// L'URL est nettoyée immédiatement après : elle contient la clé API en clair, et
// on ne veut la laisser ni dans la barre d'adresse, ni dans l'historique, ni
// dans un signet, ni dans un en-tête `Referer` si le joueur clique un lien.
(function importSharedConfig() {
  const raw = new URLSearchParams(window.location.search).get('config');
  if (!raw) return;
  const shared = decodeShareConfig(raw);
  try {
    const clean = new URL(window.location.href);
    clean.searchParams.delete('config');
    window.history.replaceState({}, '', clean.pathname + clean.search + clean.hash);
  } catch { /* pas d'historique manipulable : on continue quand même */ }
  if (!shared) {
    showToast('Lien de configuration illisible ou périmé.', 'error');
    return;
  }
  if (Object.keys(shared.llm).length) dispatch({ type: 'SET_LLM', patch: shared.llm });
  if (shared.theme) setColorTheme(shared.theme);
  showToast('Configuration importée depuis le lien.', 'info');
})();

// --- Catalogue des modes de jeu (IndexedDB, asynchrone) ---
// Sème les modes fournis à la première ouverture. Hors du chemin de démarrage :
// les réglages s'affichent avec leurs valeurs persistées, les cartes de mode
// apparaissent quand la lecture répond.
loadModes().then(modes => dispatch({ type: 'SET_MODES', modes }));

// --- Reprise de la session active (IndexedDB, asynchrone) ---
// Volontairement hors du chemin de démarrage : la lecture ne doit pas retarder
// le premier rendu. La garde évite d'écraser une partie que l'utilisateur
// aurait lancée avant que la lecture ne réponde.
const activeSessionId = loadActiveSessionId();
if (activeSessionId) {
  getSession(activeSessionId).then((session) => {
    if (!session || session.status !== 'active') return;
    const s = getState();
    if ((s.phase !== 'HOME' && s.phase !== 'SETUP') || s.partie) return;
    const backHome = s.phase === 'HOME';
    dispatch({ type: 'RESUME_SESSION', session });
    // Une partie interrompue ? On ne la relance pas d'office : le MJ décide.
    // getResume est asynchrone comme le reste de l'archive, donc l'accueil se
    // redessine quand la réponse arrive (voir l'abonnement de home.js).
    listResumes(session.id).then((snapshots) => {
      if (snapshots.length) dispatch({ type: 'SET_RESUMABLES', snapshots });
    });
    // RESUME_SESSION ouvre les réglages ; si on attendait encore au menu, on y reste.
    if (backHome) dispatch({ type: 'GOTO_HOME' });
  });
}

// --- Configuration serveur (model / temperature / batchSize via /api/health) ---
async function applyHealthConfig() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return;
    const data = await res.json();
    const patch = {};
    if (typeof data?.model === 'string' && data.model && !getState().llm.model) patch.model = data.model;
    if (typeof data?.temperature === 'number') patch.temperature = data.temperature;
    if (typeof data?.batchSize === 'number') patch.batchSize = data.batchSize;
    if (Object.keys(patch).length) dispatch({ type: 'SET_LLM', patch });
  } catch { /* configuration non critique */ }
}
applyHealthConfig();

// --- Routage des écrans ---
const UNMOUNTERS = {
  HOME: unmountHome,
  SETUP: unmountSetup,
  LOADING: unmountGame,
  QUESTION: unmountGame,
  REVEAL: unmountGame,
  MANCHE_END: unmountGame,
  VICTORY: unmountVictory,
  SESSIONS: unmountSessions,
  SETTINGS: unmountSettings,
};
const MOUNTERS = {
  HOME: renderHome,
  SETUP: renderSetup,
  LOADING: renderGame,
  QUESTION: renderGame,
  REVEAL: renderGame,
  MANCHE_END: renderGame,
  VICTORY: renderVictory,
  SESSIONS: renderSessions,
  SETTINGS: renderSettings,
};
let currentPhase = null;

function mountScreen(phase) {
  if (currentPhase && UNMOUNTERS[currentPhase]) UNMOUNTERS[currentPhase]();
  app.innerHTML = '';
  if (MOUNTERS[phase]) MOUNTERS[phase](app);
  currentPhase = phase;
}

// --- Abonnement principal : persistance + routage ---
subscribe((state) => {
  savePlayers(state.players);
  saveSettings(state.settings);
  saveLlmConfig(state.llm);

  if (state.phase !== currentPhase) {
    mountScreen(state.phase);
  }
  syncAppNav(state.phase);
});

// --- Écouteurs globaux ---
window.addEventListener('online', () => dispatch({ type: 'SET_ONLINE', value: true }));
window.addEventListener('offline', () => dispatch({ type: 'SET_ONLINE', value: false }));

window.addEventListener('error', (e) => {
  console.error('[app] window.onerror', e.error);
  showToast('Une erreur est survenue. Réessayez ou rechargez.', 'error');
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[app] unhandledrejection', e.reason);
  showToast('Une erreur est survenue. Réessayez ou rechargez.', 'error');
});
