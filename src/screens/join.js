// screens/join.js — vue joueur sur téléphone, ouverte par un lien /join/CODE.
//
// Écran autonome : il n'entre pas dans la machine à états du MJ (state.js) et
// garde son propre état local. Le multijoueur n'a pas encore de backend : la
// session, les joueurs et la question viennent de DEMO ci-dessous, à remplacer
// par les données reçues du serveur.
import { playerChip } from '../components/playerChip.js';
import { DIFFICULTY_LABELS } from '../constants.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ===== Données en dur (à remplacer par le backend) =====
const DEMO = {
  session: { name: 'Soirée du 17 septembre' },
  settings: { targetScore: 15, timePerQuestion: 60, manchesTarget: 3 },
  mancheIndex: 1, // 0-based : manche 2
  players: [
    { id: 'p1', name: 'Kaneda', emoji: '👾', color: '#a855f7', score: 9, manchesWon: 1, taken: false },
    { id: 'p2', name: 'Motoko', emoji: '🤖', color: '#22d3ee', score: 12, manchesWon: 0, taken: true },
    { id: 'p3', name: 'Amuro', emoji: '👻', color: '#f472b6', score: 7, manchesWon: 0, taken: false },
    { id: 'p4', name: 'Deunan', emoji: '🦊', color: '#a3e635', score: 11, manchesWon: 0, taken: false },
  ],
  question: {
    question: 'Dans « Akira », quelle ville est reconstruite après la Troisième Guerre mondiale ?',
    difficulty: 'medium',
    bonus: true,
    options: [
      { key: 'A', text: 'Neo-Osaka' },
      { key: 'B', text: 'Neo-Tokyo' },
      { key: 'C', text: 'Mega-Kyoto' },
      { key: 'D', text: 'Tokyo-3, évidemment' },
    ],
    answer: 'B',
    funnyOption: 'D',
    explanation: 'Neo-Tokyo est bâtie sur la baie de Tokyo en 2019, après la destruction de l’ancienne ville en 1988.',
  },
};

// Étapes de la vue joueur, dans l'ordre de la barre de démo
const STAGES = [
  ['waiting', 'Attente'],
  ['question', 'Question'],
  ['timeup', 'Temps écoulé'],
  ['reveal', 'Révélation'],
  ['eliminated', 'Exclu'],
  ['manche', 'Fin de manche'],
  ['victory', 'Victoire'],
];

let root = null;
let teardown = null;
let view = null;
let timerId = null;

/** Code d'invitation lu dans l'adresse, ou null si ce n'est pas un lien /join/. */
export function parseJoinCode(pathname) {
  const m = /^\/join\/([A-Za-z0-9-]{1,32})\/?$/.exec(pathname);
  return m ? m[1].toUpperCase() : null;
}

const me = () => DEMO.players.find(p => p.id === view.playerId);
const byScore = () => [...DEMO.players].sort((a, b) => b.score - a.score);
const byManches = () => [...DEMO.players].sort((a, b) => b.manchesWon - a.manchesWon || b.score - a.score);

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}

function stopTimer() {
  clearInterval(timerId);
  timerId = null;
}

function paintTimer() {
  const el = root?.querySelector('#join-timer');
  if (!el) return;
  el.textContent = formatTime(view.timeLeft);
  el.classList.toggle('timer--urgent', view.timeLeft > 0 && view.timeLeft <= 10);
  el.classList.toggle('timer--over', view.timeLeft === 0);
}

function startTimer() {
  stopTimer();
  timerId = setInterval(() => {
    view.timeLeft = Math.max(0, view.timeLeft - 1);
    if (view.timeLeft === 0) {
      stopTimer();
      setStage('timeup');
      return;
    }
    paintTimer();
  }, 1000);
}

// ===== Écran 1 : choix du joueur =====

function pickHtml() {
  const cards = DEMO.players.map(p => {
    const selected = view.playerId === p.id;
    return `
      <button type="button" class="arcade-card join-player${selected ? ' arcade-card--active' : ''}"
        data-player="${p.id}" style="--pc:${p.color}" aria-pressed="${selected}" ${p.taken ? 'disabled' : ''}>
        <span class="join-player__emoji" aria-hidden="true">${p.emoji}</span>
        <span class="join-player__name">${escapeHtml(p.name)}</span>
        ${p.taken ? '<span class="join-player__taken">Déjà pris</span>' : ''}
      </button>`;
  }).join('');

  return `
    <header class="arcade__title join-title">
      <h1>Qui es-tu ?</h1>
      <p>${escapeHtml(DEMO.session.name)} · code <strong class="join-code">${escapeHtml(view.code)}</strong></p>
    </header>
    <div class="join-players" role="group" aria-label="Joueurs de la session">${cards}</div>
    <button type="button" id="join-confirm" class="arcade-btn arcade-btn--primary join-confirm" ${view.playerId ? '' : 'disabled'}>
      C'est moi !
    </button>
  `;
}

// ===== Écran 2 : vue joueur =====

function barHtml() {
  const p = me();
  return `
    <header class="arcade__bar join-bar">
      ${playerChip(p, { className: 'arcade-avatar' })}
      <span class="join-bar__name">${escapeHtml(p.name)}</span>
      <span class="join-bar__manche">Manche ${DEMO.mancheIndex + 1}/${DEMO.settings.manchesTarget}</span>
      <span class="join-bar__score">${p.score}<small> / ${DEMO.settings.targetScore}</small></span>
    </header>
  `;
}

function waitingHtml() {
  const others = DEMO.players.filter(p => p.id !== view.playerId);
  return `
    <section class="question-card join-wait" aria-live="polite">
      <div class="loading-dots" aria-hidden="true"><span></span><span></span><span></span></div>
      <h2>En attente de la prochaine question…</h2>
      <p class="join-muted">Le maître du jeu lance la suite. Garde ton téléphone à portée de main.</p>
      <div class="join-roster">
        ${others.map(p => playerChip(p, { className: 'arcade-avatar' })).join('')}
      </div>
    </section>
  `;
}

function questionHtml() {
  const q = DEMO.question;
  const locked = view.stage === 'timeup';
  const buttons = q.options.map(o => {
    const picked = view.answer === o.key;
    return `
      <button type="button" class="option-card join-answer${picked ? ' join-answer--picked' : ''}"
        data-key="${o.key}" aria-pressed="${picked}" ${locked ? 'disabled' : ''}>
        <span class="option-card__row">
          <span class="option-card__key">${o.key}</span>
          <span class="option-card__text">${escapeHtml(o.text)}</span>
          ${picked ? '<span class="join-mine">Ton choix</span>' : ''}
        </span>
      </button>`;
  }).join('');

  let status = '<p class="join-status">Touche ta réponse.</p>';
  if (locked) {
    status = `<p class="join-status join-status--locked">⏱ Temps écoulé${view.answer ? ` : réponse ${view.answer} retenue` : ' : aucune réponse'}.</p>`;
  } else if (view.answer) {
    status = `<p class="join-status join-status--sent">✓ Réponse ${view.answer} envoyée. Tu peux changer d'avis jusqu'à la révélation.</p>`;
  }

  return `
    <article class="question-card join-question" aria-live="polite">
      <div class="question-meta">
        <span class="badge badge--${q.difficulty}">${escapeHtml(DIFFICULTY_LABELS[q.difficulty] || q.difficulty)}</span>
        ${q.bonus ? '<span class="badge badge--bonus">×2 BONUS</span>' : ''}
        <span id="join-timer" class="timer join-timer" role="timer" aria-live="off"></span>
      </div>
      <h2>${escapeHtml(q.question)}</h2>
      <div class="join-answers">${buttons}</div>
      ${status}
    </article>
  `;
}

function revealHtml() {
  const q = DEMO.question;
  const gain = q.bonus ? 2 : 1;
  let result;
  if (!view.answer) {
    result = '<p class="answer-result answer-result--none join-result">— Pas de réponse · +0</p>';
  } else if (view.answer === q.answer) {
    result = `<p class="answer-result answer-result--correct join-result">✓ Bonne réponse · +${gain}</p>`;
  } else {
    result = '<p class="answer-result answer-result--wrong join-result">✗ Raté · −1</p>';
  }

  const options = q.options.map(o => {
    let cls = 'option-card option-card--muted';
    if (o.key === q.answer) cls = 'option-card option-card--correct';
    else if (o.key === q.funnyOption) cls = 'option-card option-card--funny';
    const mine = view.answer === o.key ? '<span class="join-mine">Ta réponse</span>' : '';
    return `
      <div class="${cls}${mine ? ' join-answer--picked' : ''}">
        <div class="option-card__row">
          <span class="option-card__key">${o.key}</span>
          <span class="option-card__text">${escapeHtml(o.text)}</span>
          ${mine}
        </div>
      </div>`;
  }).join('');

  return `
    <article class="question-card join-question" aria-live="polite">
      ${result}
      <h2>${escapeHtml(q.question)}</h2>
      <div class="join-answers">${options}</div>
      <p class="explanation">${escapeHtml(q.explanation)}</p>
    </article>
  `;
}

function eliminatedHtml() {
  return `
    <section class="question-card join-wait join-out" aria-live="polite">
      <span class="join-out__icon" aria-hidden="true">☠</span>
      <h2>Exclu jusqu'à la fin de la manche</h2>
      <p class="join-muted">Trop de fautes en mort subite. Tu ne gagnes ni ne perds plus rien, et tu reviens à la manche suivante.</p>
    </section>
  `;
}

/** `cellOf` rend la dernière cellule de la ligne (score ou pastilles). */
function rankingHtml(rows, cellOf) {
  const medals = ['🥇', '🥈', '🥉'];
  return rows.map((p, i) => `
    <div class="podium__row${i === 0 ? ' podium__row--first' : ''}${p.id === view.playerId ? ' join-me' : ''}">
      <span class="podium__rank" aria-hidden="true">${medals[i] || i + 1}</span>
      <span class="podium__emoji" aria-hidden="true">${p.emoji}</span>
      <span class="answer-card__name">${escapeHtml(p.name)}${p.id === view.playerId ? ' (toi)' : ''}</span>
      ${cellOf(p)}
    </div>`).join('');
}

function mancheHtml() {
  const rows = byScore();
  const rank = rows.findIndex(p => p.id === view.playerId) + 1;
  return `
    <section class="question-card" aria-live="polite">
      <h2>🏅 ${escapeHtml(rows[0].name)} remporte la manche ${DEMO.mancheIndex + 1}</h2>
      <p class="join-muted">Tu termines ${rank === 1 ? '1er' : `${rank}e`} sur ${rows.length}. Prochaine manche dans un instant…</p>
      <div class="podium">${rankingHtml(rows, p => `<span class="answer-card__score">${p.score} pt</span>`)}</div>
    </section>
  `;
}

function victoryHtml() {
  const rows = byManches();
  const winner = rows[0];
  const title = winner.id === view.playerId
    ? '🏆 Tu remportes la partie !'
    : `🏆 ${escapeHtml(winner.name)} remporte la partie`;
  return `
    <section class="question-card" aria-live="polite">
      <h2 class="join-victory">${title}</h2>
      <p class="join-muted">Best-of ${DEMO.settings.manchesTarget} · ${escapeHtml(DEMO.session.name)}</p>
      <div class="podium">${rankingHtml(rows, p => `
        <span class="manche-pips" aria-label="${p.manchesWon} manche${p.manchesWon > 1 ? 's' : ''} gagnée${p.manchesWon > 1 ? 's' : ''}">
          ${Array.from({ length: DEMO.settings.manchesTarget }, (_, i) =>
            `<span class="manche-pip${i < p.manchesWon ? ' manche-pip--won' : ''}"></span>`).join('')}
        </span>`)}</div>
    </section>
  `;
}

const BODIES = {
  waiting: waitingHtml,
  question: questionHtml,
  timeup: questionHtml,
  reveal: revealHtml,
  eliminated: eliminatedHtml,
  manche: mancheHtml,
  victory: victoryHtml,
};

// Barre de démo : absente du build de production
function demoBarHtml() {
  if (!import.meta.env.DEV || !view.playerId || view.step !== 'play') return '';
  return `
    <nav class="join-demo" aria-label="Démo : états de la vue joueur">
      ${STAGES.map(([id, label]) => `
        <button type="button" class="join-demo__btn${view.stage === id ? ' is-active' : ''}" data-stage="${id}">${label}</button>
      `).join('')}
    </nav>
  `;
}

function render() {
  const body = view.step === 'pick'
    ? pickHtml()
    : `${barHtml()}<div class="join-body">${BODIES[view.stage]()}</div>`;
  root.innerHTML = `
    <section class="arcade join-screen screen" data-screen="join" data-step="${view.step}">
      ${body}
    </section>
    ${demoBarHtml()}
  `;
  paintTimer();
}

function setStage(stage) {
  view.stage = stage;
  if (stage === 'question') {
    view.answer = null;
    view.timeLeft = DEMO.settings.timePerQuestion;
    startTimer();
  } else if (stage !== 'timeup') {
    stopTimer();
  }
  if (stage === 'timeup') view.timeLeft = 0;
  render();
}

export function renderJoin(rootEl, code) {
  unmountJoin();
  root = rootEl;
  view = { code, step: 'pick', playerId: null, stage: 'waiting', answer: null, timeLeft: 0 };
  render();

  const cleanup = new AbortController();
  root.addEventListener('click', (e) => {
    const player = e.target.closest('.join-player');
    if (player && !player.disabled) {
      view.playerId = player.dataset.player;
      render();
      return;
    }
    if (e.target.closest('#join-confirm') && view.playerId) {
      view.step = 'play';
      setStage('waiting');
      return;
    }
    const answer = e.target.closest('.join-answer');
    if (answer && !answer.disabled && view.stage === 'question') {
      view.answer = answer.dataset.key;
      render();
      return;
    }
    const demo = e.target.closest('[data-stage]');
    if (demo) setStage(demo.dataset.stage);
  }, { signal: cleanup.signal });

  teardown = () => {
    cleanup.abort();
    stopTimer();
    root = null;
  };
}

export function unmountJoin() {
  if (teardown) { teardown(); teardown = null; }
}
