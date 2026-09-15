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

  // Les marches restent des `.podium__row` en position 1/2/3 : Paper Quest et
  // Bubble Island accrochent leurs sprites de médaille sur
  // `.podium__row:nth-child(n) .podium__rank`. Changer la structure les aurait
  // décrochés SANS la moindre erreur — c'est le CSS qui aurait cessé de
  // s'appliquer, sur les deux thèmes les plus travaillés.
  const podiumHtml = top.map((p, i) => {
    const tied = i > 0 && won(p.id) === won(ranked[i - 1].id);
    const rankLabel = tied ? '=' : (medals[i] || `${i + 1}`);
    return `
      <li class="podium__row ${i === 0 ? 'podium__row--first' : ''}" style="--step:${i}">
        <span class="podium__rank" aria-hidden="true">${rankLabel}</span>
        <span class="podium__emoji" aria-hidden="true">${p.emoji}</span>
        <div class="podium__info">
          <div class="answer-card__name">${escapeHtml(p.name)}</div>
          <div class="podium__bar"><span style="width:${Math.round((won(p.id) / maxWon) * 100)}%"></span></div>
        </div>
        <span class="answer-card__score">${won(p.id)} manche${won(p.id) > 1 ? 's' : ''}</span>
      </li>
    `;
  }).join('');

  // Au-delà de la troisième place, personne n'était affiché : une partie à six
  // laissait la moitié du roster hors de l'écran final.
  const restHtml = ranked.slice(3).map((p, i) => `
    <li class="podium-rest__row">
      <span class="podium-rest__rank">${i + 4}</span>
      <span aria-hidden="true">${p.emoji}</span>
      <span class="podium-rest__name">${escapeHtml(p.name)}</span>
      <span class="podium-rest__score">${won(p.id)} manche${won(p.id) > 1 ? 's' : ''}</span>
    </li>`).join('');

  // Détail manche par manche (DAVINCI §14) : qui a remporté quoi.
  const manchesHtml = (s.partie?.manches || []).map((m, i) => {
    const g = s.players.find(p => p.id === m.winnerId);
    return `<li>Manche ${i + 1} — <strong>${g ? escapeHtml(g.name) : 'sans vainqueur'}</strong></li>`;
  }).join('');

  // Durée approximative, à partir de partie.startedAt.
  let duree = '';
  if (s.partie?.startedAt) {
    const min = Math.max(1, Math.round((Date.now() - s.partie.startedAt) / 60000));
    duree = min >= 60
      ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`
      : `${min} min`;
  }

  const played = s.partie?.manches?.length || 0;
  const target = s.partie?.manchesTarget || s.settings.manchesTarget;
  const title = winner ? `${escapeHtml(winner.name)} gagne la partie !` : 'Partie terminée !';
  const subtitle = winner
    ? `${won(winner.id)} manche${won(winner.id) > 1 ? 's' : ''} sur ${target} · ${played} manche${played > 1 ? 's' : ''} jouée${played > 1 ? 's' : ''}`
    : `Best-of ${target}`;

  root.innerHTML = `
    <section class="victory-screen screen" data-screen="victory" aria-labelledby="victory-title">
      <header class="victory-header">
        <div class="victory-theme">${renderThemeSelect()}</div>
        ${winner ? `<span class="victory-winner-token" aria-hidden="true">${winner.emoji}</span>` : ''}
        <h1 id="victory-title" class="winner-title">${title}</h1>
        <p>${subtitle}</p>
      </header>
      <ol class="podium podium--steps" aria-label="Classement sur les manches gagnées">${podiumHtml}</ol>
      ${restHtml ? `<ol class="podium-rest" aria-label="Suite du classement">${restHtml}</ol>` : ''}
      <div class="panel recap">
        <h3>Récapitulatif</h3>
        <ul>
          <li>Session : <strong>${escapeHtml(s.session?.name || '—')}</strong></li>
          <li>Format : <strong>best-of ${target}</strong> · score cible ${s.settings.targetScore}</li>
          <li>Thème : <strong>${escapeHtml(s.settings.theme)}</strong></li>
          <li>Bonnes réponses cumulées : <strong>${s.stats.correctAnswers}</strong></li>
          ${duree ? `<li>Durée de la partie : <strong>${duree}</strong></li>` : ''}
        </ul>
        ${manchesHtml ? `<h3 class="recap__subtitle">Détail des manches</h3><ul>${manchesHtml}</ul>` : ''}
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
