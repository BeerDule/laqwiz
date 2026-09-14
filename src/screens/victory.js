// screens/victory.js — écran VICTORY (podium, confettis, rejouer) (SPEC §12.4).
import { getState, dispatch, computePartieWinner } from '../state.js';
import { launchConfetti, stopConfetti } from '../confetti.js';
import { renderThemeSelect, wireThemeSelect } from '../themeSwitcher.js';

let teardown = null;
let root = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function renderVictory(rootEl) {
  unmountVictory();
  root = rootEl;
  const s = getState();
  const winner = computePartieWinner(s);

  // La partie se gagne au best-of : on classe sur les manches remportées, pas
  // sur les points — ceux-ci n'appartiennent qu'à la dernière manche jouée.
  const won = id => (s.partie?.manchesWon?.[id] || 0);
  const ranked = [...s.players].sort((a, b) => {
    const d = won(b.id) - won(a.id);
    if (d !== 0) return d;
    return s.players.indexOf(a) - s.players.indexOf(b);
  });
  const top = ranked.slice(0, 3);
  const maxWon = Math.max(1, ...s.players.map(p => won(p.id)));
  const medals = ['🥇', '🥈', '🥉'];

  const podiumHtml = top.map((p, i) => {
    const tied = i > 0 && won(p.id) === won(ranked[i - 1].id);
    const rankLabel = tied ? '=' : (medals[i] || `${i + 1}`);
    return `
      <div class="podium__row ${i === 0 ? 'podium__row--first' : ''}">
        <span class="podium__rank" aria-hidden="true">${rankLabel}</span>
        <span class="podium__emoji" aria-hidden="true">${p.emoji}</span>
        <div class="podium__info">
          <div class="answer-card__name">${escapeHtml(p.name)}</div>
          <div class="podium__bar"><span style="width:${Math.round((won(p.id) / maxWon) * 100)}%"></span></div>
        </div>
        <span class="answer-card__score">${won(p.id)} manche${won(p.id) > 1 ? 's' : ''}</span>
      </div>
    `;
  }).join('');

  const played = s.partie?.manches?.length || 0;
  const target = s.partie?.manchesTarget || s.settings.manchesTarget;
  const title = winner ? `🏆 ${escapeHtml(winner.name)} gagne la partie !` : 'Partie terminée !';
  const subtitle = winner
    ? `${won(winner.id)} manche${won(winner.id) > 1 ? 's' : ''} sur ${target} · ${played} manche${played > 1 ? 's' : ''} jouée${played > 1 ? 's' : ''}`
    : `Best-of ${target}`;

  root.innerHTML = `
    <section class="victory-screen screen" data-screen="victory" aria-labelledby="victory-title">
      <header class="victory-header">
        <h1 id="victory-title" class="winner-title">${title}</h1>
        <p>${subtitle}</p>
        <div class="victory-theme">${renderThemeSelect()}</div>
      </header>
      <div class="podium" aria-label="Classement">${podiumHtml}</div>
      <div class="panel recap">
        <h3>Récapitulatif</h3>
        <ul>
          <li>Session : <strong>${escapeHtml(s.session?.name || '—')}</strong></li>
          <li>Format : <strong>best-of ${target}</strong> · score cible ${s.settings.targetScore}</li>
          <li>Thème : <strong>${escapeHtml(s.settings.theme)}</strong></li>
          <li>Bonnes réponses cumulées : <strong>${s.stats.correctAnswers}</strong></li>
        </ul>
      </div>
      <div class="victory-actions">
        <button id="btn-replay" class="button button--primary button--large">Nouvelle partie</button>
        <button id="btn-sessions" class="button button--ghost">Sessions</button>
        <button id="btn-close-session" class="button button--ghost">Terminer la session</button>
        <button id="btn-clear" class="button button--danger button--ghost">Effacer les données locales</button>
      </div>
      <dialog id="confirm-dialog">
        <p>Effacer définitivement les joueurs, réglages et statistiques ?</p>
        <form method="dialog">
          <button value="cancel" class="button button--ghost">Annuler</button>
          <button value="confirm" class="button button--primary">Effacer</button>
        </form>
      </dialog>
    </section>
  `;

  const cleanup = new AbortController();
  const { signal } = cleanup;

  wireThemeSelect(root);
  // « Nouvelle partie » reste dans la session : le roster et l'anti-doublon survivent.
  root.querySelector('#btn-replay').addEventListener('click', () => dispatch({ type: 'NEW_GAME' }), { signal });
  root.querySelector('#btn-sessions').addEventListener('click', () => dispatch({ type: 'GOTO_SESSIONS' }), { signal });
  root.querySelector('#btn-close-session').addEventListener('click', () => {
    if (window.confirm('Terminer cette session ? Les parties restent consultables dans l\'historique.')) {
      dispatch({ type: 'CLOSE_SESSION' });
    }
  }, { signal });

  const dialog = root.querySelector('#confirm-dialog');
  root.querySelector('#btn-clear').addEventListener('click', () => dialog.showModal(), { signal });
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'confirm') {
      dispatch({ type: 'RESET_ALL' });
    }
  }, { signal });

  launchConfetti();

  teardown = () => {
    cleanup.abort();
    stopConfetti();
    root = null;
  };
}

export function unmountVictory() {
  if (teardown) { teardown(); teardown = null; }
  root = null;
}
