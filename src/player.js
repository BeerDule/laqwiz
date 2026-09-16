// player.js — point d'entrée « joueur » (multijoueur en ligne, WS.md §18).
//
// Ouvert via /game/<sessionId>. Écran de connexion minimal : un prénom, un
// avatar choisi dans une frise défilante, puis l'attente du début de partie.
// La réception des questions arrive à l'étape suivante.

import { PLAYER_EMOJIS, PLAYER_EMOJI_LABELS, NAME_MAX_LENGTH } from './constants.js';
import { relayWsUrl } from './relay.js';

const PLAYER_STORAGE_KEY = 'quizz-canape:player';

let socket = null;
let clientId = null;
let myName = '';
let myEmoji = '';
let lastQuestion = null;

function loadPlayerIdentity() {
  try {
    const raw = localStorage.getItem(PLAYER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function savePlayerIdentity() {
  try {
    localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify({ clientId, name: myName, emoji: myEmoji }));
  } catch { /* quota / navigation privée */ }
}

function newClientId() {
  // crypto.randomUUID exige un contexte sécurisé (https/localhost) — absent en
  // LAN http://192.168.x.x. On retombe sur un identifiant suffisant pour un jeu.
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function dispatchToast(message, kind = 'info') {
  document.dispatchEvent(new CustomEvent('qc:toast', { detail: { message, kind } }));
}

export function mountPlayer(rootEl, sessionId) {
  const identity = loadPlayerIdentity();
  clientId = identity?.clientId || newClientId();
  let selectedEmoji = (identity?.emoji && PLAYER_EMOJIS.includes(identity.emoji))
    ? identity.emoji
    : PLAYER_EMOJIS[0];

  rootEl.innerHTML = `
    <section class="arcade arcade--join screen" data-screen="join">
      <header class="join__header">
        <p class="join__eyebrow">Canap' QuiZZ</p>
        <h1 class="join__title">Rejoindre la partie</h1>
      </header>

      <form id="player-form" class="join__body" novalidate>
        <label class="join__label" for="player-name">Ton prénom</label>
        <input id="player-name" class="join__name" type="text" maxlength="${NAME_MAX_LENGTH}"
          placeholder="Ex. Alice" autocomplete="off" autocapitalize="words" spellcheck="false" />

        <span class="join__label" id="avatar-label">Choisis ton avatar</span>
        <div id="player-emojis" class="avatar-strip" role="radiogroup" aria-labelledby="avatar-label"></div>

        <p id="player-error" class="form-error" role="alert" hidden></p>
        <button id="btn-join" class="button button--primary button--large join__submit" type="submit">Rejoindre</button>
      </form>
    </section>
  `;

  const strip = rootEl.querySelector('#player-emojis');
  strip.innerHTML = PLAYER_EMOJIS.map(e => `
    <button type="button" role="radio" aria-checked="${e === selectedEmoji}"
      aria-label="${escapeHtml(PLAYER_EMOJI_LABELS[e] || 'Avatar')}" data-emoji="${e}"
      class="${e === selectedEmoji ? 'is-selected' : ''}">${e}</button>
  `).join('');

  strip.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-emoji]');
    if (!btn) return;
    selectedEmoji = btn.dataset.emoji;
    strip.querySelectorAll('button').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-checked', String(on));
    });
    btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  });

  if (identity?.name) {
    rootEl.querySelector('#player-name').value = identity.name;
  }

  rootEl.querySelector('#player-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = rootEl.querySelector('#player-name').value.trim();
    if (!name) {
      showError('Indique ton prénom pour rejoindre.');
      return;
    }
    showError('');
    submitJoin(name, selectedEmoji);
  });

  // Connexion au relais, une seule fois pour tout l'écran.
  socket = new WebSocket(relayWsUrl(sessionId));
  socket.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    // session.connected : l'identité du relais ne nous sert pas — notre
    // identité stable est notre clientId local.
    if (msg.type !== 'session.connected') handleMessage(msg);
  });
  socket.addEventListener('error', () => {
    showError('Impossible de rejoindre la partie (session inexistante ou expirée ?).');
    resetSubmit();
  });
  socket.addEventListener('close', () => {
    if (document.querySelector('#btn-join')) {
      showError('Connexion perdue.');
      resetSubmit();
    } else {
      dispatchToast('Connexion perdue.', 'error');
    }
  });

  // Rechargement : on rejoint automatiquement avec l'identité persistée.
  if (identity?.name && identity.emoji) {
    submitJoin(identity.name, selectedEmoji);
  }
}

function showError(msg) {
  const el = document.querySelector('#player-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
}

function submitJoin(name, emoji) {
  myName = name;
  myEmoji = emoji;
  const btn = document.querySelector('#btn-join');
  btn.disabled = true;
  btn.textContent = 'Connexion…';

  const send = () => socket.send(JSON.stringify({ type: 'lobby.join', payload: { name, emoji, clientId } }));
  if (socket?.readyState === WebSocket.OPEN) {
    send();
  } else {
    socket.addEventListener('open', send, { once: true });
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'lobby.join.rejected':
      if (msg.payload?.targetId === clientId) {
        showError(reasonMessage(msg.payload.reason));
        resetSubmit();
      }
      break;
    case 'lobby.roster': {
      const players = msg.payload?.players || [];
      // On n'est « connecté » que si NOTRE identité (clientId) figure dans le
      // roster : les broadcasts liés aux autres joueurs ne doivent pas nous
      // faire quitter le formulaire avant notre propre acceptation.
      if (players.some(p => p.id === clientId)) {
        savePlayerIdentity();
        renderWaiting(players);
      }
      break;
    }
    case 'game.start':
      renderStarted();
      break;
    case 'game.question':
      renderQuestion(msg.payload);
      break;
    case 'game.reveal':
      renderPlayerReveal(msg.payload);
      break;
    case 'game.manche_end':
      renderMancheEnd(msg.payload);
      break;
    case 'game.victory':
      renderVictory(msg.payload);
      break;
    case 'game.state': {
      const p = msg.payload || {};
      if (p.targetId !== clientId) break;
      if (p.question) renderQuestion(p.question);
      else if (p.reveal) renderPlayerReveal(p.reveal);
      else if (p.mancheEnd) renderMancheEnd(p.mancheEnd);
      else if (p.victory) renderVictory(p.victory);
      else if (p.waiting) renderWaitingForGame();
      break;
    }
    case 'room.closed':
      renderRoomClosed();
      break;
    // game.question / game.reveal arriveront à l'étape suivante.
  }
}

function reasonMessage(reason) {
  switch (reason) {
    case 'name-taken': return 'Ce prénom est déjà pris, choisis-en un autre.';
    case 'emoji-taken': return 'Cet avatar est déjà pris, choisis-en un autre.';
    case 'started': return 'La partie a déjà commencé.';
    default: return 'Impossible de rejoindre.';
  }
}

function resetSubmit() {
  const btn = document.querySelector('#btn-join');
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = 'Rejoindre';
}

function renderWaiting(players) {
  const body = document.querySelector('.join__body');
  const list = players.map(p => `${p.emoji} ${escapeHtml(p.name)}`).join(' · ');
  body.innerHTML = `
    <p class="join-waiting__emoji" aria-hidden="true">${myEmoji}</p>
    <p class="join-waiting">${escapeHtml(myName)}, tu es connecté·e&nbsp;!</p>
    <p class="join-waiting-hint">Joueurs connectés : ${players.length}${list ? ` — ${list}` : ''}</p>
    <p class="join-waiting-hint">En attente du début de la partie…</p>
    <button id="btn-change-identity" class="player-change" type="button">Changer de nom / avatar</button>
  `;
  body.querySelector('#btn-change-identity').addEventListener('click', resetIdentity);
}

function resetIdentity() {
  // On oublie l'identité persistée puis on recharge : l'écran de connexion
  // réapparaît (nouveau clientId).
  try { localStorage.removeItem(PLAYER_STORAGE_KEY); } catch { /* ignore */ }
  location.reload();
}

function renderStarted() {
  const body = document.querySelector('.join__body');
  body.innerHTML = `
    <p class="join-waiting__emoji" aria-hidden="true">${myEmoji}</p>
    <p class="join-waiting">La partie commence&nbsp;!</p>
    <p class="join-waiting-hint">Les questions vont arriver…</p>
  `;
}

function renderQuestion(payload) {
  lastQuestion = payload;
  const body = document.querySelector('.join__body');
  const options = (payload.options || []).map(o => `
    <button type="button" class="option-card" data-key="${escapeHtml(o.key)}">
      <span class="option-card__key">${escapeHtml(o.key)}</span>
      <span class="option-card__text">${escapeHtml(o.text)}</span>
    </button>
  `).join('');
  body.innerHTML = `
    <div class="question-meta">
      ${payload.isBonus ? '<span class="badge badge--bonus">×2 BONUS</span>' : ''}
      ${payload.deadline ? '<span class="timer" id="player-timer" role="timer"></span>' : ''}
    </div>
    <h2 class="player-question">${escapeHtml(payload.question)}</h2>
    <div class="options-grid" id="player-options">${options}</div>
  `;

  wirePlayerOptions(payload.deadline);
}

function wirePlayerOptions(deadline) {
  const grid = document.querySelector('#player-options');
  if (!grid) return;
  grid.querySelectorAll('.option-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      grid.querySelectorAll('.option-card').forEach((b) => b.classList.toggle('is-selected', b === btn));
      socket.send(JSON.stringify({ type: 'game.answer', payload: { optionKey: key } }));
    });
  });
  if (deadline) startPlayerTimer(deadline);
}

let playerTimerId = null;
function startPlayerTimer(deadline) {
  clearInterval(playerTimerId);
  const tick = () => {
    const el = document.querySelector('#player-timer');
    if (!el) { clearInterval(playerTimerId); return; }
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    el.textContent = left > 0 ? `${left} s` : 'Temps écoulé';
  };
  tick();
  playerTimerId = setInterval(tick, 500);
}

function renderPlayerReveal(payload) {
  const body = document.querySelector('.join__body');
  const answerText = payload.answerText || lastQuestion?.options?.find(o => o.key === payload.answer)?.text || payload.answer;
  const funnyText = payload.funnyText || lastQuestion?.options?.find(o => o.key === payload.funnyOption)?.text || '';
  const mine = (payload.results || []).find(r => r.id === clientId);
  const correct = mine && mine.answered === payload.answer;
  const penalty = mine?.penalty || 0;

  body.innerHTML = `
    <div class="question-meta">
      <span class="badge badge--${correct ? 'easy' : 'hard'}">${correct ? '✔ Bonne réponse' : '✕ Raté'}</span>
      ${penalty > 0 ? `<span class="badge badge--hard">−${penalty}</span>` : ''}
      ${mine?.eliminated ? '<span class="badge badge--hard">☠ Éliminé</span>' : ''}
    </div>
    <h2 class="player-question">Bonne réponse&nbsp;: ${escapeHtml(answerText)}</h2>
    ${funnyText && funnyText !== answerText ? `<p class="player-reveal">😄 L'option drôle&nbsp;: ${escapeHtml(funnyText)}</p>` : ''}
    ${payload.explanation ? `<p class="player-reveal">${escapeHtml(payload.explanation)}</p>` : ''}
    <ul class="player-leaderboard">${leaderboardHtml(payload.results || [], 'score')}</ul>
  `;
}

function renderMancheEnd(payload) {
  const body = document.querySelector('.join__body');
  const winner = (payload.players || []).find(p => p.id === payload.winnerId);
  body.innerHTML = `
    <p class="join-waiting__emoji" aria-hidden="true">${winner ? winner.emoji : '🏅'}</p>
    <p class="join-waiting">${winner ? `${escapeHtml(winner.name)} remporte la manche&nbsp;!` : 'Manche terminée'}</p>
    <ul class="player-leaderboard">${leaderboardHtml(payload.players || [], 'score')}</ul>
    <p class="join-waiting-hint">Prochaine question à venir…</p>
  `;
}

function renderVictory(payload) {
  const body = document.querySelector('.join__body');
  const winner = (payload.players || []).find(p => p.id === payload.winnerId);
  body.innerHTML = `
    <p class="join-waiting__emoji" aria-hidden="true">🏆</p>
    <p class="join-waiting">${winner ? `${escapeHtml(winner.name)} gagne la partie&nbsp;!` : 'Partie terminée'}</p>
    <ul class="player-leaderboard">${leaderboardHtml(payload.players || [], 'manchesWon')}</ul>
    <p class="join-waiting-hint">Merci d'avoir joué&nbsp;!</p>
  `;
}

function renderWaitingForGame() {
  const body = document.querySelector('.join__body');
  body.innerHTML = `
    <p class="join-waiting__emoji" aria-hidden="true">${myEmoji}</p>
    <p class="join-waiting">Reconnecté·e&nbsp;!</p>
    <p class="join-waiting-hint">En attente de la prochaine question…</p>
  `;
}

function renderRoomClosed() {
  const body = document.querySelector('.join__body');
  body.innerHTML = `
    <p class="join-waiting__emoji" aria-hidden="true">👋</p>
    <p class="join-waiting">La partie est terminée.</p>
    <p class="join-waiting-hint">L'hôte a fermé la partie. Merci d'avoir joué&nbsp;!</p>
  `;
}

function leaderboardHtml(players, sortBy) {
  return [...players]
    .sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0) || (b.score || 0) - (a.score || 0))
    .map((p, i) => {
      const me = p.id === clientId;
      const manches = p.manchesWon != null ? (p.manchesWon > 0 ? '🏆'.repeat(Math.min(p.manchesWon, 5)) : '·') : '';
      return `
        <li class="player-row${me ? ' player-row--me' : ''}">
          <span class="player-row__rank">${i + 1}</span>
          <span class="player-row__emoji" aria-hidden="true">${p.emoji}</span>
          <span class="player-row__name">${escapeHtml(p.name)}${me ? ' · toi' : ''}</span>
          ${manches ? `<span class="player-row__manches" aria-label="${p.manchesWon} manche(s) gagnée(s)">${manches}</span>` : ''}
          <span class="player-row__score">${p.score ?? 0} pt</span>
        </li>
      `;
    })
    .join('');
}
