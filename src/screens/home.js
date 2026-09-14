// screens/home.js — menu principal façon jeu.
// Cet écran garde volontairement l'identité « île » quel que soit le thème
// sélectionné : c'est la porte d'entrée du jeu, pas une surface de contenu.
import { getState, dispatch, subscribe } from '../state.js';
import { renderThemeSelect, wireThemeSelect } from '../themeSwitcher.js';

let teardown = null;
let root = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function menuHtml(s) {
  const session = s.session;
  const roster = s.players.length
    ? s.players.map(p => `<span class="arcade-avatar" title="${escapeHtml(p.name)}">${p.emoji}</span>`).join('')
    : '';

  return `
    <section class="arcade arcade--home screen" data-screen="home">
      <div class="arcade__topbar">${renderThemeSelect()}</div>

      <header class="arcade__title">
        <h1>Quizz Canapé</h1>
        <p>Le savoir. La mauvaise foi. Le canapé.</p>
      </header>

      ${session ? `
        <div class="arcade-plaque">
          <span class="arcade-plaque__label">Session en cours</span>
          <strong class="arcade-plaque__name">${escapeHtml(session.name)}</strong>
          <div class="arcade-plaque__roster">${roster}</div>
        </div>` : ''}

      <nav class="arcade__menu" aria-label="Menu principal">
        ${session
          ? '<button id="btn-continue" class="arcade-btn arcade-btn--primary">Continuer</button>'
          : ''}
        <button id="btn-new-session" class="arcade-btn">Nouvelle session</button>
        <button id="btn-sessions" class="arcade-btn">Sessions</button>
        ${session ? '<button id="btn-settings" class="arcade-btn">Réglages de partie</button>' : ''}
      </nav>
    </section>
  `;
}

function render() {
  const s = getState();
  root.innerHTML = menuHtml(s);

  const cleanup = new AbortController();
  const { signal } = cleanup;
  wireThemeSelect(root);

  const on = (id, fn) => {
    const el = root.querySelector(id);
    if (el) el.addEventListener('click', fn, { signal });
  };
  on('#btn-continue', () => dispatch({ type: 'NEW_GAME' }));
  on('#btn-settings', () => dispatch({ type: 'NEW_GAME' }));
  on('#btn-new-session', () => dispatch({ type: 'NEW_SESSION' }));
  on('#btn-sessions', () => dispatch({ type: 'GOTO_SESSIONS' }));

  return () => cleanup.abort();
}

export function renderHome(rootEl) {
  unmountHome();
  root = rootEl;
  let abort = render();

  // La session peut arriver après coup : sa lecture IndexedDB est asynchrone.
  // On redessine alors le menu pour faire apparaître « Continuer ».
  let lastSessionId = getState().session?.id ?? null;
  const unsub = subscribe((s) => {
    if (!root) return;
    const id = s.session?.id ?? null;
    if (id !== lastSessionId) {
      lastSessionId = id;
      abort();
      abort = render();
    }
  });

  teardown = () => {
    unsub();
    abort();
    root = null;
  };
}

export function unmountHome() {
  if (teardown) { teardown(); teardown = null; }
  root = null;
}
