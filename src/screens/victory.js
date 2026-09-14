// screens/victory.js — écran VICTORY (podium, confettis, rejouer) (SPEC §12.4).
import { getState, dispatch, computeWinner } from '../state.js';
import { launchConfetti, stopConfetti } from '../confetti.js';

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
  const winner = computeWinner(s);

  const ranked = [...s.players].sort((a, b) => {
    const d = b.score - a.score;
    if (d !== 0) return d;
    return s.players.indexOf(a) - s.players.indexOf(b);
  });
  const top = ranked.slice(0, 3);
  const maxScore = Math.max(1, ...s.players.map(p => p.score));
  const medals = ['🥇', '🥈', '🥉'];

  const podiumHtml = top.map((p, i) => {
    const tied = i > 0 && p.score === ranked[i - 1].score;
    const rankLabel = tied ? '=' : (medals[i] || `${i + 1}`);
    return `
      <div class="podium__row ${i === 0 ? 'podium__row--first' : ''}">
        <span class="podium__rank" aria-hidden="true">${rankLabel}</span>
        <span class="podium__emoji" aria-hidden="true">${p.emoji}</span>
        <div class="podium__info">
          <div class="answer-card__name">${escapeHtml(p.name)}</div>
          <div class="podium__bar"><span style="width:${Math.round((p.score / maxScore) * 100)}%"></span></div>
        </div>
        <span class="answer-card__score">${p.score} pt${p.score > 1 ? 's' : ''}</span>
      </div>
    `;
  }).join('');

  const title = winner ? `🏆 ${escapeHtml(winner.name)} gagne !` : 'Partie terminée !';
  const subtitle = winner
    ? `${winner.score} point${winner.score > 1 ? 's' : ''} · score cible : ${s.settings.targetScore}`
    : `Score cible : ${s.settings.targetScore}`;

  root.innerHTML = `
    <section class="victory-screen screen" data-screen="victory" aria-labelledby="victory-title">
      <header class="victory-header">
        <h1 id="victory-title" class="winner-title">${title}</h1>
        <p>${subtitle}</p>
      </header>
      <div class="podium" aria-label="Classement">${podiumHtml}</div>
      <div class="panel recap">
        <h3>Récapitulatif</h3>
        <ul>
          <li>Thème : <strong>${escapeHtml(s.settings.theme)}</strong></li>
          <li>Questions posées : <strong>${s.questions.length}</strong></li>
          <li>Bonnes réponses cumulées : <strong>${s.stats.correctAnswers}</strong></li>
        </ul>
      </div>
      <div class="victory-actions">
        <button id="btn-replay" class="button button--primary button--large">Rejouer</button>
        <button id="btn-settings" class="button button--ghost">Changer les réglages</button>
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

  root.querySelector('#btn-replay').addEventListener('click', () => dispatch({ type: 'NEW_GAME' }), { signal });
  root.querySelector('#btn-settings').addEventListener('click', () => dispatch({ type: 'NEW_GAME' }), { signal });

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
