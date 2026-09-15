// screens/game.js — écran GAME (question, saisie, reveal) (SPEC §12.3).
import { getState, dispatch, subscribe, hasMancheWinner, manchesNeeded, retryGeneration } from '../state.js';
import { DIFFICULTY_LABELS } from '../constants.js';
import { renderThemeSelect, wireThemeSelect } from '../themeSwitcher.js';

let teardown = null;
let root = null;
let lastPhase = null;
let lastIndex = -1;
let activePlayerId = null;
let picker = null; // menu radial de sélection des joueurs (ouvert sur une carte)
let lastErrorTs = null;
let lastOnline = null;
let timerId = null;
let timeLeft = 0;
let timeUp = false;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function dispatchToast(message, kind = 'info') {
  document.dispatchEvent(new CustomEvent('qc:toast', { detail: { message, kind } }));
}

// --- Chronomètre (mode chrono) ---
// Le décompte reste local : passer par dispatch() écrirait dans localStorage
// à chaque tick (voir l'abonnement de main.js).

function stopTimer() {
  if (timerId) { clearInterval(timerId); timerId = null; }
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const rest = sec % 60;
  return m > 0 ? `${m}:${String(rest).padStart(2, '0')}` : `${rest} s`;
}

function paintTimer() {
  const el = root?.querySelector('#question-timer');
  if (!el) return;
  el.textContent = timeUp ? 'Temps écoulé' : formatTime(timeLeft);
  el.classList.toggle('timer--urgent', !timeUp && timeLeft <= 10);
  el.classList.toggle('timer--over', timeUp);
}

function expireTimer() {
  stopTimer();
  timeUp = true;
  timeLeft = 0;
  closePlayerPicker();
  activePlayerId = null;
  paintTimer();
  updateRevealButton();
  dispatchToast('Temps écoulé — saisie verrouillée.', 'error');
}

function startTimer() {
  stopTimer();
  timeUp = false;
  const s = getState();
  if (!s.settings.timerEnabled) return;
  // On vise une échéance plutôt que de décrémenter : setInterval dérive et se
  // fait brider quand l'onglet passe en arrière-plan.
  const deadline = Date.now() + (s.settings.timePerQuestion || 60) * 1000;
  timeLeft = Math.ceil((deadline - Date.now()) / 1000);
  paintTimer();
  timerId = setInterval(() => {
    timeLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (timeLeft === 0) expireTimer();
    else paintTimer();
  }, 500);
}

const SHELL = `
  <section class="game-screen screen" data-screen="game">
    <header class="game-header">
      <button id="btn-quit" class="button button--ghost">Quitter</button>
      <div class="progress">
        <div class="progress-text">
          <span id="question-number"></span>
          <span id="question-theme" class="question-theme"></span>
        </div>
        <div class="progress-bar"><span id="progress-fill"></span></div>
      </div>
      ${renderThemeSelect()}
    </header>
    <div id="leaderboard-mini" class="leaderboard-mini" aria-label="Scores"></div>
    <div id="retry-banner" class="retry-banner" hidden>
      <span id="retry-message"></span>
      <button id="btn-retry" class="button button--ghost">Réessayer la génération</button>
    </div>
    <div id="game-body"></div>
  </section>
`;

function loadingHtml() {
  return `
    <div class="loading-panel" role="status">
      <div class="loading-dots" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
      <h2>Préparation des questions…</h2>
      <p>Le maître des questions prépare 5 cartes…</p>
    </div>
  `;
}

function boardHtml(s) {
  const q = s.questions[s.currentIndex];

  // Cartes de réponse : chacune contient, en bas, les avatars des joueurs
  // qui l'ont choisie. Un clic sur la carte ouvre le menu radial des joueurs.
  const optionsHtml = q.options.map((o, i) => {
    const pickers = s.players.filter(p => s.roundAnswers[p.id] === o.key);
    const team = pickers.map(p => `
      <span class="team-avatar" style="--pc:${p.color || 'var(--color-accent-primary)'}" title="${escapeHtml((p.name || '').trim() || 'Joueur')}">
        <span aria-hidden="true">${p.emoji}</span>
      </span>
    `).join('');
    return `
      <div class="option-card" data-key="${o.key}">
        <div class="option-card__row">
          <span class="option-card__key">${o.key}</span>
          <span class="option-card__text">${escapeHtml(o.text)}</span>
          <kbd class="option-card__hint">${i + 1}</kbd>
        </div>
        <div class="option-card__team">${team || '<span class="option-card__team-empty">Aucun joueur</span>'}</div>
      </div>
    `;
  }).join('');

  return `
    <div class="options-grid" id="options-grid">${optionsHtml}</div>
  `;
}

function questionHtml(s) {
  const q = s.questions[s.currentIndex];
  const difficulty = DIFFICULTY_LABELS[q.difficulty] || q.difficulty;
  const bonus = s.isBonusRound;

  return `
    <article id="question-card" class="question-card" data-bonus="${bonus ? 'true' : 'false'}" aria-live="polite">
      <div class="question-meta">
        <span id="difficulty-badge" class="badge badge--${q.difficulty}">${escapeHtml(difficulty)}</span>
        ${bonus ? '<span id="bonus-badge" class="badge badge--bonus">×2 BONUS</span>' : ''}
        ${s.settings.timerEnabled ? '<span id="question-timer" class="timer" role="timer" aria-live="off"></span>' : ''}
      </div>
      <h2 id="question-heading">${escapeHtml(q.question)}</h2>
      <div id="answer-board" class="answer-board">${boardHtml(s)}</div>
      <button id="btn-reveal" class="button button--primary button--large" disabled>Révéler la réponse</button>
    </article>
  `;
}

function mancheEndHtml(s) {
  const last = s.partie.manches[s.partie.manches.length - 1];
  const winner = s.players.find(p => p.id === last?.winnerId);
  const needed = manchesNeeded(s);

  const tally = s.players.map(p => {
    const won = s.partie.manchesWon[p.id] || 0;
    const pips = Array.from({ length: s.partie.manchesTarget }, (_, i) =>
      `<span class="manche-pip${i < won ? ' manche-pip--won' : ''}"></span>`).join('');
    return `
      <div class="podium__row${p.id === last?.winnerId ? ' podium__row--first' : ''}">
        <span aria-hidden="true">${p.emoji}</span>
        <span class="answer-card__name">${escapeHtml(p.name)}</span>
        <span class="manche-pips" aria-label="${won} manche${won > 1 ? 's' : ''} gagnée${won > 1 ? 's' : ''}">${pips}</span>
        <span class="answer-card__score">${last?.scores?.[p.id] ?? 0} pt</span>
      </div>`;
  }).join('');

  return `
    <article class="question-card" aria-live="polite">
      <h2>${winner ? `🏅 ${escapeHtml(winner.name)} remporte la manche ${s.partie.mancheIndex + 1}` : `Manche ${s.partie.mancheIndex + 1} terminée`}</h2>
      <p class="gap-msg">Première personne à ${needed} manche${needed > 1 ? 's' : ''} remporte la partie.</p>
      <div class="podium">${tally}</div>
      <button id="btn-next-manche" class="button button--primary button--large">Manche suivante</button>
    </article>
  `;
}

function revealHtml(s) {
  const q = s.questions[s.currentIndex];
  const bonusMult = s.isBonusRound ? 2 : 1;

  const optionsHtml = q.options.map(o => {
    let cls = 'option-card';
    let badge = '';
    if (o.key === q.answer) {
      cls += ' option-card--correct';
      badge = '<span class="badge badge--easy">Bonne réponse</span>';
    } else if (o.key === q.funnyOption) {
      cls += ' option-card--funny';
      badge = '<span class="badge badge--funny">Option drôle</span>';
    } else {
      cls += ' option-card--muted';
    }
    return `<div class="${cls}" data-key="${o.key}"><div class="option-card__row"><span class="option-card__key">${o.key}</span><span>${escapeHtml(o.text)}</span></div>${badge}</div>`;
  }).join('');

  const resultsHtml = s.players.map(p => {
    const ans = s.roundAnswers[p.id];
    let result;
    let cls = 'answer-card';
    if (p.eliminated) {
      cls += ' answer-card--out';
      result = '<span class="answer-result answer-result--none">☠ Exclu de la manche · +0</span>';
    } else if (!ans) {
      const lost = s.roundPenalties[p.id] || 0;
      if (lost > 0) {
        cls += ' answer-card--wrong';
        result = `<span class="answer-result answer-result--wrong">— Pas de réponse · −${lost}</span>`;
      } else {
        result = '<span class="answer-result answer-result--none">— Pas de réponse · +0</span>';
      }
    } else if (ans === q.answer) {
      cls += ' answer-card--correct';
      result = `<span class="answer-result answer-result--correct">✓ +${bonusMult}</span>`;
    } else {
      cls += ' answer-card--wrong';
      const lost = s.roundPenalties[p.id] || 0;
      result = lost > 0
        ? `<span class="answer-result answer-result--wrong">✕ −${lost}</span>`
        : '<span class="answer-result answer-result--wrong">✕ +0</span>';
    }
    return `
      <div class="${cls}">
        <div class="answer-card__head">
          <span aria-hidden="true">${p.emoji}</span>
          <span class="answer-card__name">${escapeHtml(p.name)}</span>
          <span class="answer-card__score">${p.score} pt${p.score > 1 ? 's' : ''}</span>
        </div>
        <div class="answer-result-line">
          <span>Choix : <strong>${ans || '—'}</strong></span>
          ${result}
        </div>
      </div>
    `;
  }).join('');

  const victory = hasMancheWinner(s);
  const actionLabel = victory ? 'Fin de la manche' : 'Question suivante';

  let gapMsg = '';
  if (!victory && s.settings.twoPointLead) {
    const ranked = [...s.players].sort((a, b) => b.score - a.score);
    const leader = ranked[0];
    const second = ranked[1];
    if (leader && leader.score >= s.settings.targetScore && second) {
      const gapNeeded = 2 - (leader.score - second.score);
      if (gapNeeded > 0) gapMsg = `<p class="gap-msg">Encore ${gapNeeded} point(s) d'écart requis.</p>`;
    }
  }

  return `
    <article id="question-card" class="question-card" data-bonus="${s.isBonusRound ? 'true' : 'false'}">
      <div class="question-meta">
        <span class="badge badge--${q.difficulty}">${DIFFICULTY_LABELS[q.difficulty] || q.difficulty}</span>
        ${s.isBonusRound ? '<span class="badge badge--bonus">×2 BONUS</span>' : ''}
      </div>
      <h2>${escapeHtml(q.question)}</h2>
      <div class="options-grid">${optionsHtml}</div>
      <div class="explanation">${escapeHtml(q.explanation)}</div>
    </article>
    <section class="answer-entry">
      <h3>Résultats</h3>
      <div class="player-answer-grid">${resultsHtml}</div>
      ${gapMsg}
      <button id="btn-next" class="button button--primary button--large">${actionLabel}</button>
    </section>
  `;
}

let signal = null;

function renderLeaderboard() {
  const el = root.querySelector('#leaderboard-mini');
  if (!el) return;
  const s = getState();
  const ranked = [...s.players].sort((a, b) => b.score - a.score);
  const leaderId = ranked[0]?.id;
  el.innerHTML = ranked.map(p => `
    <span class="leaderboard-mini__item ${p.id === leaderId ? 'leaderboard-mini__item--leader' : ''}">
      <span aria-hidden="true">${p.emoji}</span>${escapeHtml(p.name)} · ${p.score}
    </span>
  `).join('');
}

function updateHeader() {
  const s = getState();
  const numEl = root.querySelector('#question-number');
  const fillEl = root.querySelector('#progress-fill');
  const themeEl = root.querySelector('#question-theme');
  if (s.phase === 'QUESTION' || s.phase === 'REVEAL') {
    const q = s.questions[s.currentIndex];
    const n = s.currentIndex + 1;
    const prepared = s.questions.length + s.prefetchQueue.length;
    const manche = s.partie
      ? `Manche ${s.partie.mancheIndex + 1}/${s.partie.manchesTarget} · `
      : '';
    numEl.textContent = `${manche}Question ${n} · ${prepared} préparée${prepared > 1 ? 's' : ''}`;
    themeEl.textContent = q?.theme || '';
    const pct = Math.min(100, Math.round((n / Math.max(prepared, 1)) * 100));
    fillEl.style.width = `${pct}%`;
  } else {
    numEl.textContent = '';
    themeEl.textContent = '';
    fillEl.style.width = '0%';
  }
  renderLeaderboard();
}

function updateRevealButton() {
  const btn = root.querySelector('#btn-reveal');
  if (!btn) return;
  const s = getState();
  const answered = Object.values(s.roundAnswers).some(a => a);
  // Sans ce `|| timeUp`, un temps écoulé sans aucune réponse bloquerait le MJ.
  btn.disabled = !answered && !timeUp;
}

/**
 * Ouvre un menu radial de joueurs autour du point cliqué (x, y), pour
 * attribuer la réponse `key`. Un clic sur un avatar bascule l'affectation ;
 * on peut en sélectionner plusieurs pour la même réponse.
 */
function openPlayerPicker(key, x, y) {
  closePlayerPicker();
  const s = getState();
  const players = s.players;
  const n = players.length;
  const radius = Math.max(88, Math.min(132, n * 26));
  const plate = radius + 36;

  // On rabat le centre dans la fenêtre pour que le cercle reste visible.
  const pad = plate + 8;
  const cx = Math.min(Math.max(x, pad), window.innerWidth - pad);
  const cy = Math.min(Math.max(y, pad), window.innerHeight - pad);

  const menu = document.createElement('div');
  menu.className = 'player-picker';
  menu.style.left = `${cx}px`;
  menu.style.top = `${cy}px`;
  menu.innerHTML = `
    <span class="player-picker__plate" style="width:${plate * 2}px; height:${plate * 2}px; left:${-plate}px; top:${-plate}px" aria-hidden="true"></span>
    <span class="player-picker__answer" aria-hidden="true">${key}</span>
    ${players.map((p, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const px = Math.cos(angle) * radius;
      const py = Math.sin(angle) * radius;
      const active = s.roundAnswers[p.id] === key;
      const name = (p.name || '').trim() || 'Joueur';
      return `
        <button type="button" class="player-picker__item${active ? ' is-active' : ''}${p.eliminated ? ' is-out' : ''}"
          data-player="${p.id}" style="left:${(px - 24).toFixed(1)}px; top:${(py - 24).toFixed(1)}px; --pc:${p.color || 'var(--color-accent-primary)'}; animation-delay:${30 + i * 24}ms"
          ${p.eliminated ? 'disabled' : ''} aria-pressed="${active}" aria-label="${escapeHtml(name)} : réponse ${key}">
          <span aria-hidden="true">${p.emoji}</span>
        </button>
      `;
    }).join('')}
  `;

  document.body.appendChild(menu);

  // Ferme sur clic extérieur, sans voile plein écran.
  const outside = (e) => {
    if (e.target.closest('.player-picker')) return;
    closePlayerPicker();
  };
  document.addEventListener('click', outside, true);
  picker = { menu, key, outside };

  menu.addEventListener('focusin', (e) => {
    const item = e.target.closest('.player-picker__item');
    if (item) activePlayerId = item.dataset.player;
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.player-picker__item');
    if (!item) return;
    selectAnswer(item.dataset.player, key);
    const now = getState().roundAnswers[item.dataset.player] === key;
    item.classList.toggle('is-active', now);
    item.setAttribute('aria-pressed', String(now));
  });
}

function closePlayerPicker() {
  if (!picker) return;
  if (picker.outside) document.removeEventListener('click', picker.outside, true);
  picker.menu?.remove();
  picker = null;
}

/**
 * Met à jour, sans re-rendre la question ni le chrono : les avatars posés dans
 * chaque carte de réponse.
 */
function syncBoard() {
  const s = getState();
  const board = root.querySelector('#answer-board');
  if (!board) return;

  const q = s.questions[s.currentIndex];
  q.options.forEach((o) => {
    const teamEl = board.querySelector(`.option-card[data-key="${o.key}"] .option-card__team`);
    if (!teamEl) return;
    const pickers = s.players.filter(p => s.roundAnswers[p.id] === o.key);
    teamEl.innerHTML = pickers.map(p => `
      <span class="team-avatar" style="--pc:${p.color || 'var(--color-accent-primary)'}" title="${escapeHtml((p.name || '').trim() || 'Joueur')}">
        <span aria-hidden="true">${p.emoji}</span>
      </span>
    `).join('') || '<span class="option-card__team-empty">Aucun joueur</span>';
  });

  updateRevealButton();
}

function selectAnswer(playerId, key) {
  if (timeUp) return;
  const s = getState();
  // Garde en plus du `disabled` : le clavier et un clic programmatique
  // contournent un attribut posé au rendu.
  if (s.players.find(x => x.id === playerId)?.eliminated) return;
  const current = s.roundAnswers[playerId];
  if (current === key) dispatch({ type: 'CLEAR_PLAYER_ANSWER', playerId });
  else dispatch({ type: 'PLAYER_ANSWER', playerId, optionKey: key });
  syncBoard();
}

function confirmQuit() {
  if (window.confirm('Quitter la partie et revenir aux réglages ?')) {
    dispatch({ type: 'NEW_GAME' });
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    if (picker) { closePlayerPicker(); return; }
    confirmQuit();
    return;
  }
  if (['1', '2', '3', '4'].includes(e.key)) {
    const s = getState();
    if (s.phase !== 'QUESTION' || !activePlayerId) return;
    const key = ['A', 'B', 'C', 'D'][parseInt(e.key, 10) - 1];
    selectAnswer(activePlayerId, key);
    e.preventDefault();
  }
}

function handleError(s) {
  const banner = root.querySelector('#retry-banner');
  const err = s.ui.lastError;
  if (err && err.ts !== lastErrorTs) {
    lastErrorTs = err.ts;
    dispatchToast(err.message, 'error');
  }
  if (!err) lastErrorTs = null;

  if (banner) {
    if (err && (s.phase === 'QUESTION' || s.phase === 'REVEAL')) {
      banner.hidden = false;
      banner.querySelector('#retry-message').textContent = err.message;
    } else {
      banner.hidden = true;
    }
  }
}

function wireQuestionBody(body) {
  const board = body.querySelector('#answer-board');
  const revealBtn = body.querySelector('#btn-reveal');

  board.addEventListener('click', (e) => {
    const card = e.target.closest('.option-card');
    if (!card || timeUp) return;
    // Ouvre le menu radial des joueurs autour du point cliqué.
    openPlayerPicker(card.dataset.key, e.clientX, e.clientY);
  }, { signal });

  revealBtn.addEventListener('click', () => {
    dispatch({ type: 'REVEAL_ANSWER' });
  }, { signal });
}

function wireRevealBody(body) {
  body.querySelector('#btn-next').addEventListener('click', () => {
    const s = getState();
    if (hasMancheWinner(s)) {
      dispatch({ type: 'END_MANCHE' });
    } else if (s.prefetchQueue.length === 0) {
      dispatch({
        type: 'SET_ERROR',
        error: { code: 'EMPTY_QUEUE', message: 'Génération en cours : réessayez dans un instant.' },
      });
      retryGeneration();
    } else {
      dispatch({ type: 'SHOW_NEXT_QUESTION' });
    }
  }, { signal });
}

function wireMancheEndBody(body) {
  body.querySelector('#btn-next-manche').addEventListener('click', () => {
    dispatch({ type: 'START_MANCHE' });
    dispatch({ type: 'SHOW_NEXT_QUESTION' }); // sans effet si la file est vide
    if (getState().phase === 'LOADING') retryGeneration();
  }, { signal });
}

function renderBody() {
  const s = getState();
  const body = root.querySelector('#game-body');
  stopTimer();
  closePlayerPicker();
  if (s.phase === 'LOADING') {
    body.innerHTML = loadingHtml();
  } else if (s.phase === 'QUESTION') {
    body.innerHTML = questionHtml(s);
    wireQuestionBody(body);
    startTimer();
    updateRevealButton();
  } else if (s.phase === 'REVEAL') {
    body.innerHTML = revealHtml(s);
    wireRevealBody(body);
  } else if (s.phase === 'MANCHE_END') {
    body.innerHTML = mancheEndHtml(s);
    wireMancheEndBody(body);
  }
  updateHeader();
}

export function renderGame(rootEl) {
  unmountGame();
  root = rootEl;
  lastPhase = null;
  lastIndex = -1;
  activePlayerId = null;
  lastErrorTs = null;
  timeUp = false;
  lastOnline = getState().ui.isOnline;

  root.innerHTML = SHELL;

  const cleanup = new AbortController();
  signal = cleanup.signal;

  wireThemeSelect(root);
  root.querySelector('#btn-quit').addEventListener('click', () => confirmQuit(), { signal });
  root.querySelector('#btn-retry').addEventListener('click', () => retryGeneration(), { signal });
  document.addEventListener('keydown', onKeydown, { signal });

  const unsub = subscribe(() => {
    if (!root) return;
    const s = getState();
    const changed = s.phase !== lastPhase || s.currentIndex !== lastIndex;
    if (changed) {
      lastPhase = s.phase;
      lastIndex = s.currentIndex;
      renderBody();
      if (s.phase === 'REVEAL') {
        const next = root.querySelector('#btn-next');
        if (next) next.focus();
      }
    } else {
      if (s.phase === 'QUESTION') updateRevealButton();
      updateHeader();
    }
    handleError(s);
    if (lastOnline !== s.ui.isOnline) {
      dispatchToast(
        s.ui.isOnline
          ? 'Connexion rétablie.'
          : 'Hors connexion : les cartes déjà chargées restent disponibles.',
        s.ui.isOnline ? 'info' : 'error'
      );
      lastOnline = s.ui.isOnline;
    }
  });

  teardown = () => {
    stopTimer();
    closePlayerPicker();
    unsub();
    cleanup.abort();
    signal = null;
    root = null;
  };
}

export function unmountGame() {
  if (teardown) { teardown(); teardown = null; }
  root = null;
}



