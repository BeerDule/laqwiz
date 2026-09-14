// screens/game.js — écran GAME (question, saisie, reveal) (SPEC §12.3).
import { getState, dispatch, subscribe, hasVictory, retryGeneration } from '../state.js';
import { DIFFICULTY_LABELS } from '../constants.js';

let teardown = null;
let root = null;
let lastPhase = null;
let lastIndex = -1;
let activePlayerId = null;
let lastErrorTs = null;
let lastOnline = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function dispatchToast(message, kind = 'info') {
  document.dispatchEvent(new CustomEvent('qc:toast', { detail: { message, kind } }));
}

const SHELL = `
  <section class="game-screen screen" data-screen="game">
    <header class="game-header">
      <button id="btn-quit" class="button button--ghost">Quitter</button>
      <div class="progress">
        <span id="question-number"></span>
        <div class="progress-bar"><span id="progress-fill"></span></div>
      </div>
      <div id="leaderboard-mini" class="leaderboard-mini" aria-label="Scores"></div>
    </header>
    <div id="retry-banner" class="retry-banner" hidden>
      <span id="retry-message"></span>
      <button id="btn-retry" class="button button--ghost">Réessayer la génération</button>
    </div>
    <div id="game-body"></div>
  </section>
`;

function loadingHtml() {
  return `
    <div class="loading-panel panel" role="status">
      <p class="loading-spinner" aria-hidden="true"></p>
      <h2>Préparation des questions…</h2>
      <p>Le maître des questions prépare 5 cartes…</p>
    </div>
  `;
}

function questionHtml(s) {
  const q = s.questions[s.currentIndex];
  const difficulty = DIFFICULTY_LABELS[q.difficulty] || q.difficulty;
  const bonus = s.isBonusRound;

  const optionsHtml = q.options.map((o, i) => `
    <div class="option-card" data-key="${o.key}">
      <span class="option-card__key">${o.key}</span>
      <span class="option-card__text">${escapeHtml(o.text)}</span>
      <kbd class="option-card__hint">${i + 1}</kbd>
    </div>
  `).join('');

  const playersHtml = s.players.map(p => `
    <div class="answer-card" data-player="${p.id}">
      <div class="answer-card__head">
        <span aria-hidden="true">${p.emoji}</span>
        <span class="answer-card__name">${escapeHtml(p.name)}</span>
        <span class="answer-card__score">${p.score} pt${p.score > 1 ? 's' : ''}</span>
      </div>
      <div class="answer-card__options" role="group" aria-label="Réponse de ${escapeHtml(p.name)}">
        ${['A', 'B', 'C', 'D'].map(k => `<button type="button" class="answer-card__btn" data-player="${p.id}" data-key="${k}">${k}</button>`).join('')}
      </div>
    </div>
  `).join('');

  return `
    <article id="question-card" class="question-card" data-bonus="${bonus ? 'true' : 'false'}" aria-live="polite">
      <div class="question-meta">
        <span id="difficulty-badge" class="badge badge--${q.difficulty}">${escapeHtml(difficulty)}</span>
        ${bonus ? '<span id="bonus-badge" class="badge badge--bonus">×2 BONUS</span>' : ''}
      </div>
      <h2 id="question-heading">${escapeHtml(q.question)}</h2>
      <div id="options-grid" class="options-grid">${optionsHtml}</div>
    </article>
    <section id="answer-entry" class="answer-entry" aria-labelledby="answer-entry-title">
      <h3 id="answer-entry-title">Réponses des joueurs</h3>
      <div id="player-answer-grid" class="player-answer-grid">${playersHtml}</div>
      <button id="btn-reveal" class="button button--primary button--large" disabled>Révéler la réponse</button>
    </section>
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
    return `<div class="${cls}" data-key="${o.key}"><span class="option-card__key">${o.key}</span><span>${escapeHtml(o.text)}</span>${badge}</div>`;
  }).join('');

  const resultsHtml = s.players.map(p => {
    const ans = s.roundAnswers[p.id];
    let result;
    let cls = 'answer-card';
    if (!ans) {
      result = '<span class="answer-result answer-result--none">— Pas de réponse · +0</span>';
    } else if (ans === q.answer) {
      cls += ' answer-card--correct';
      result = `<span class="answer-result answer-result--correct">✓ +${bonusMult}</span>`;
    } else {
      cls += ' answer-card--wrong';
      result = '<span class="answer-result answer-result--wrong">✕ +0</span>';
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

  const victory = hasVictory(s);
  const actionLabel = victory ? 'Voir le podium' : 'Question suivante';

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
  if (s.phase === 'QUESTION' || s.phase === 'REVEAL') {
    const n = s.currentIndex + 1;
    const prepared = s.questions.length + s.prefetchQueue.length;
    numEl.textContent = `Question ${n} · ${prepared} préparée${prepared > 1 ? 's' : ''}`;
    const pct = Math.min(100, Math.round((n / Math.max(prepared, 1)) * 100));
    fillEl.style.width = `${pct}%`;
  } else {
    numEl.textContent = '';
    fillEl.style.width = '0%';
  }
  renderLeaderboard();
}

function updateRevealButton() {
  const btn = root.querySelector('#btn-reveal');
  if (!btn) return;
  const s = getState();
  const answered = Object.values(s.roundAnswers).some(a => a);
  btn.disabled = !answered;
}

function selectAnswer(playerId, key) {
  const s = getState();
  const current = s.roundAnswers[playerId];
  if (current === key) {
    dispatch({ type: 'CLEAR_PLAYER_ANSWER', playerId });
    const btn = root.querySelector(`.answer-card__btn[data-player="${playerId}"][data-key="${key}"]`);
    if (btn) btn.classList.remove('is-active');
  } else {
    dispatch({ type: 'PLAYER_ANSWER', playerId, optionKey: key });
    const card = root.querySelector(`.answer-card[data-player="${playerId}"]`);
    if (card) {
      card.querySelectorAll('.answer-card__btn').forEach(b => {
        b.classList.toggle('is-active', b.dataset.key === key);
      });
    }
  }
  updateRevealButton();
}

function confirmQuit() {
  if (window.confirm('Quitter la partie et revenir aux réglages ?')) {
    dispatch({ type: 'NEW_GAME' });
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') {
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
  const grid = body.querySelector('#player-answer-grid');
  const revealBtn = body.querySelector('#btn-reveal');

  grid.addEventListener('focusin', (e) => {
    const btn = e.target.closest('.answer-card__btn');
    if (btn) activePlayerId = btn.dataset.player;
  }, { signal });

  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.answer-card__btn');
    if (!btn) return;
    selectAnswer(btn.dataset.player, btn.dataset.key);
    btn.focus();
  }, { signal });

  revealBtn.addEventListener('click', () => {
    dispatch({ type: 'REVEAL_ANSWER' });
  }, { signal });
}

function wireRevealBody(body) {
  body.querySelector('#btn-next').addEventListener('click', () => {
    const s = getState();
    if (hasVictory(s)) {
      dispatch({ type: 'GOTO_VICTORY' });
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

function renderBody() {
  const s = getState();
  const body = root.querySelector('#game-body');
  if (s.phase === 'LOADING') {
    body.innerHTML = loadingHtml();
  } else if (s.phase === 'QUESTION') {
    body.innerHTML = questionHtml(s);
    wireQuestionBody(body);
    for (const p of s.players) {
      const key = s.roundAnswers[p.id];
      if (key) {
        const btn = body.querySelector(`.answer-card__btn[data-player="${p.id}"][data-key="${key}"]`);
        if (btn) btn.classList.add('is-active');
      }
    }
    updateRevealButton();
  } else if (s.phase === 'REVEAL') {
    body.innerHTML = revealHtml(s);
    wireRevealBody(body);
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
  lastOnline = getState().ui.isOnline;

  root.innerHTML = SHELL;

  const cleanup = new AbortController();
  signal = cleanup.signal;

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



