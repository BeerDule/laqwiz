// main.js — bootstrap, routage d'écrans, hydratation (SPEC §9.5, §12.1).
import './styles/theme.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/arcade.css';

import { getState, dispatch, subscribe } from './state.js';
import { loadPlayers, loadSettings, loadStats, savePlayers, saveSettings, loadActiveSessionId } from './storage.js';
import { getSession, listResumes } from './db.js';
import { renderSetup, unmountSetup } from './screens/setup.js';
import { renderGame, unmountGame } from './screens/game.js';
import { renderVictory, unmountVictory } from './screens/victory.js';
import { renderSessions, unmountSessions } from './screens/sessions.js';
import { renderHome, unmountHome } from './screens/home.js';
import { initColorTheme } from './themeSwitcher.js';

// Appliquer le thème de couleurs sauvegardé avant le premier rendu
initColorTheme();

const app = document.getElementById('app');

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

if (persistedPlayers) dispatch({ type: 'SET_PLAYERS', players: persistedPlayers });
if (persistedSettings) dispatch({ type: 'SET_SETTINGS', patch: persistedSettings });
if (persistedStats) getState().stats = persistedStats;

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
    if (typeof data?.model === 'string' && data.model && !getState().settings.model) patch.model = data.model;
    if (typeof data?.temperature === 'number') patch.temperature = data.temperature;
    if (typeof data?.batchSize === 'number') patch.batchSize = data.batchSize;
    if (Object.keys(patch).length) dispatch({ type: 'SET_SETTINGS', patch });
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

  if (state.phase !== currentPhase) {
    mountScreen(state.phase);
  }
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
