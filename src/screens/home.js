// screens/home.js — menu principal façon jeu.
// Cet écran garde volontairement l'identité « île » quel que soit le thème
// sélectionné : c'est la porte d'entrée du jeu, pas une surface de contenu.
import { getState, dispatch, subscribe } from '../state.js';
import { renderThemeSelect, wireThemeSelect } from '../themeSwitcher.js';
import { playerChips } from '../components/playerChip.js';

let teardown = null;
let root = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** Résume l'instantané en une ligne, pour que le MJ sache ce qu'il reprend. */
function resumeLabel(r) {
  const manche = (r.partie?.mancheIndex ?? 0) + 1;
  const total = r.partie?.manchesTarget ?? '?';
  const scores = (r.players || [])
    .map(p => `${p.emoji} ${p.score ?? 0}`)
    .join(' · ');
  let quand = '';
  try {
    quand = new Date(r.savedAt).toLocaleString('fr-FR', {
      weekday: 'long', hour: '2-digit', minute: '2-digit',
    });
  } catch { /* horodatage illisible : on s'en passe */ }
  return `Manche ${manche}/${total} — ${scores}${quand ? ` · interrompue ${quand}` : ''}`;
}

function menuHtml(s) {
  const session = s.session;
  const resumables = s.ui.resumables || [];
  const resumable = resumables[0] || null; // la plus récente
  const roster = playerChips(s.players, { className: 'arcade-avatar' });

  return `
    <section class="arcade arcade--home screen" data-screen="home">
      <div class="arcade__topbar">${renderThemeSelect()}</div>

      <header class="arcade__title">
        <h1>Canap' QuiZZ</h1>
        <p>Le savoir. La mauvaise foi. Le canapé.</p>
      </header>

      ${session ? `
        <div class="arcade-plaque">
          <span class="arcade-plaque__label">Session en cours</span>
          <strong class="arcade-plaque__name">${escapeHtml(session.name)}</strong>
          <div class="arcade-plaque__roster">${roster}</div>
        </div>` : ''}

      <nav class="arcade__menu" aria-label="Menu principal">
        ${resumable ? `
          <button id="btn-resume" class="arcade-btn arcade-btn--primary">
            Reprendre la partie
          </button>
          <p class="arcade-resume-hint">${escapeHtml(resumeLabel(resumable))}</p>` : ''}
        ${session
          ? `<button id="btn-continue" class="arcade-btn${resumable ? '' : ' arcade-btn--primary'}">${resumable ? 'Nouvelle partie' : 'Continuer'}</button>`
          : ''}
        <button id="btn-new-session" class="arcade-btn">Nouvelle session</button>
        <button id="btn-sessions" class="arcade-btn">Sessions</button>
        <button id="btn-app-settings" class="arcade-btn">Paramètres</button>
        ${session ? '<button id="btn-settings" class="arcade-btn">Réglages de partie</button>' : ''}
      </nav>

      <!-- Version visible : sur un déploiement, c'est le seul moyen de savoir
           quel commit tourne réellement quand un bug est signalé. -->
      <p class="arcade__version">${escapeHtml(__APP_VERSION__)}</p>
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
  on('#btn-resume', () => dispatch({ type: 'RESUME_PARTIE', snapshot: getState().ui.resumables[0] }));
  on('#btn-continue', () => dispatch({ type: 'NEW_GAME' }));
  on('#btn-settings', () => dispatch({ type: 'NEW_GAME' }));
  on('#btn-new-session', () => dispatch({ type: 'NEW_SESSION' }));
  on('#btn-sessions', () => dispatch({ type: 'GOTO_SESSIONS' }));
  on('#btn-app-settings', () => dispatch({ type: 'GOTO_SETTINGS' }));

  return () => cleanup.abort();
}

export function renderHome(rootEl) {
  unmountHome();
  root = rootEl;
  let abort = render();

  // La session peut arriver après coup : sa lecture IndexedDB est asynchrone.
  // On redessine alors le menu pour faire apparaître « Continuer ».
  let lastSessionId = getState().session?.id ?? null;
  let lastResumable = getState().ui.resumables?.length ?? 0;
  const unsub = subscribe((s) => {
    if (!root) return;
    const id = s.session?.id ?? null;
    const res = s.ui.resumables?.length ?? 0;
    if (id !== lastSessionId || res !== lastResumable) {
      lastSessionId = id;
      lastResumable = res;
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
