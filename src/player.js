// player.js — point d'entrée « joueur » (multijoueur en ligne, WS.md §18).
//
// Ouvert via /game/<sessionId>. Écran de connexion minimal : un prénom, un
// avatar choisi dans une frise défilante, puis l'attente du début de partie.
// La réception des questions arrive à l'étape suivante.

import { PLAYER_EMOJIS, PLAYER_EMOJI_LABELS, NAME_MAX_LENGTH, DIFFICULTY_LABELS } from './constants.js';
import { relayWsUrl } from './relay.js';
import { renderThemeSelect, wireThemeSelect } from './themeSwitcher.js';
import { connIndicatorHtml, wireConnIndicator } from './connIndicator.js';

const PLAYER_STORAGE_KEY = 'quizz-canape:player';

let socket = null;
let clientId = null;
let myName = '';
let myEmoji = '';
let lastQuestion = null;
let playerTimerId = null;
// Contexte de la question courante (thème, manche, numéro) pour l'en-tête.
let meta = null;
let currentSessionId = null;
let lastPingAt = 0;
let reconnectAttempts = 0;
let reconnectTimer = null;
let connState = 'connecting'; // connecting | connected | reconnecting | offline
let deliberateClose = false;
let hasConnected = false;

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

export function mountPlayer(rootEl, sessionId) {
  const identity = loadPlayerIdentity();
  clientId = identity?.clientId || newClientId();
  let selectedEmoji = (identity?.emoji && PLAYER_EMOJIS.includes(identity.emoji))
    ? identity.emoji
    : PLAYER_EMOJIS[0];

  rootEl.innerHTML = `
    <section class="game-screen screen" data-screen="join">
      <header class="game-header">
        <button id="btn-disconnect" class="button button--ghost" hidden>Se déconnecter</button>
        <div class="progress">
          <div class="progress-text">
            <span id="question-number">Rejoindre la partie</span>
            <span id="question-theme" class="question-theme"></span>
          </div>
          <div class="progress-bar"><span id="progress-fill"></span></div>
        </div>
        ${connIndicatorHtml()}
        ${renderThemeSelect()}
      </header>
      <div id="game-body">${joinHtml()}</div>
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

  rootEl.querySelector('#btn-disconnect').addEventListener('click', leave);
  wireThemeSelect(rootEl);
  wireConnIndicator(rootEl, () => ({ state: connState, lastPingAt }));

  // Connexion au relais + reconnexion automatique.
  openSocket(sessionId);

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
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Connexion…';
  }
  sendJoin();
}

/** Envoie le `lobby.join` avec l'identité courante (rejoint + rejoin). */
function sendJoin() {
  if (!myName || !myEmoji) return;
  const payload = JSON.stringify({ type: 'lobby.join', payload: { name: myName, emoji: myEmoji, clientId } });
  if (socket?.readyState === WebSocket.OPEN) socket.send(payload);
  else if (socket) socket.addEventListener('open', () => socket.send(payload), { once: true });
}

/**
 * Ouvre (ou rouvre) la connexion au relais. À chaque `session.connected`, si
 * le joueur a déjà une identité, on re-postule : le host ré-associe la
 * connexion et renvoie l'état courant (rejoin, WS.md §18.7).
 */
function openSocket(sessionId) {
  currentSessionId = sessionId;
  connState = 'connecting';
  socket = new WebSocket(relayWsUrl(sessionId));
  socket.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'session.connected') {
      hasConnected = true;
      connState = 'connected';
      reconnectAttempts = 0;
      lastPingAt = Date.now();
      sendJoin();
    } else if (msg.type === 'ping') {
      lastPingAt = Date.now();
    } else {
      handleMessage(msg);
    }
  });
  socket.addEventListener('error', () => {
    // L'échec initial (session invalide) seul mérite un message : les erreurs
    // de reconnexion sont silencieuses (le `close` relance la tentative).
    if (!hasConnected) {
      showError('Impossible de rejoindre la partie (session inexistante ou expirée ?).');
      resetSubmit();
    }
  });
  socket.addEventListener('close', () => {
    socket = null;
    const deliberate = deliberateClose;
    deliberateClose = false;
    if (deliberate || !currentSessionId) { connState = 'offline'; return; }
    connState = 'reconnecting';
    scheduleReconnect();
  });
}

/** Reconnexion avec recul exponentiel (1 s → 10 s max). */
function scheduleReconnect() {
  if (reconnectTimer || !currentSessionId) return;
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 10000);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!currentSessionId) return;
    openSocket(currentSessionId);
  }, delay);
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
      // L'hôte a fermé la room : plus de reconnexion, on reste sur l'écran final.
      currentSessionId = null;
      connState = 'offline';
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

function joinHtml() {
  return `
    <form id="player-form" class="join__body" novalidate>
      <label class="join__label" for="player-name">Ton prénom</label>
      <input id="player-name" class="join__name" type="text" maxlength="${NAME_MAX_LENGTH}"
        placeholder="Ex. Alice" autocomplete="off" autocapitalize="words" spellcheck="false" />
      <span class="join__label" id="avatar-label">Choisis ton avatar</span>
      <div id="player-emojis" class="avatar-strip" role="radiogroup" aria-labelledby="avatar-label"></div>
      <p id="player-error" class="form-error" role="alert" hidden></p>
      <button id="btn-join" class="button button--primary button--large join__submit" type="submit">Rejoindre</button>
    </form>
  `;
}

function setHeader(text, theme, pct) {
  const num = document.querySelector('#question-number');
  const themeEl = document.querySelector('#question-theme');
  const fill = document.querySelector('#progress-fill');
  if (num) num.textContent = text;
  if (themeEl) themeEl.textContent = theme || '';
  if (fill) fill.style.width = `${pct || 0}%`;
}

function progressPct(m) {
  if (!m?.index || !m?.total) return 0;
  return Math.min(100, Math.round((m.index / Math.max(m.total, 1)) * 100));
}

function setHeaderFromMeta() {
  if (!meta) { setHeader('Révélation', '', 100); return; }
  const manche = meta.manche ? `Manche ${meta.manche}/${meta.manchesTarget} · ` : '';
  setHeader(`${manche}Question ${meta.index || ''}`, meta.theme, progressPct(meta));
}

function showDisconnect(on) {
  const btn = document.querySelector('#btn-disconnect');
  if (btn) btn.hidden = !on;
}

function renderWaiting(players) {
  showDisconnect(true);
  setHeader('En attente du début…', '', 0);
  const list = players.map(p => `${p.emoji} ${escapeHtml(p.name)}`).join(' · ');
  document.querySelector('#game-body').innerHTML = `
    <article class="question-card">
      <div class="loading-panel">
        <div class="join-emoji" aria-hidden="true">${myEmoji}</div>
        <h2>${escapeHtml(myName)}, tu es connecté·e&nbsp;!</h2>
        <p>Joueurs connectés : ${players.length}${list ? ` — ${list}` : ''}</p>
        <p>En attente du début de la partie…</p>
        <button id="btn-change-identity" class="button button--ghost" type="button">Changer de nom / avatar</button>
      </div>
    </article>
  `;
  document.querySelector('#btn-change-identity').addEventListener('click', leave);
}

function leave() {
  // Départ : on prévient l'hôte (libère le siège), on oublie l'identité
  // persistée, on coupe, puis on recharge — l'écran de connexion réapparaît
  // avec une identité neuve.
  deliberateClose = true;
  currentSessionId = null;
  connState = 'offline';
  if (socket?.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify({ type: 'lobby.leave', payload: {} })); } catch { /* ignore */ }
  }
  try { localStorage.removeItem(PLAYER_STORAGE_KEY); } catch { /* ignore */ }
  if (socket) {
    try { socket.close(); } catch { /* ignore */ }
    socket = null;
  }
  location.reload();
}

function renderStarted() {
  showDisconnect(true);
  setHeader('La partie commence…', '', 0);
  document.querySelector('#game-body').innerHTML = `
    <article class="question-card">
      <div class="loading-panel">
        <div class="join-emoji" aria-hidden="true">${myEmoji}</div>
        <h2>La partie commence&nbsp;!</h2>
        <p>Les questions vont arriver…</p>
      </div>
    </article>
  `;
}

function renderQuestion(payload) {
  lastQuestion = payload;
  meta = payload;
  showDisconnect(true);
  const manche = payload.manche ? `Manche ${payload.manche}/${payload.manchesTarget} · ` : '';
  setHeader(`${manche}Question ${payload.index || ''}`, payload.theme, progressPct(payload));
  const options = (payload.options || []).map((o, i) => `
    <button type="button" class="option-card" data-key="${escapeHtml(o.key)}" aria-pressed="false">
      <div class="option-card__row">
        <span class="option-card__key">${escapeHtml(o.key)}</span>
        <span class="option-card__text">${escapeHtml(o.text)}</span>
        <kbd class="option-card__hint">${i + 1}</kbd>
      </div>
    </button>
  `).join('');
  document.querySelector('#game-body').innerHTML = `
    <article id="question-card" class="question-card" data-bonus="${payload.isBonus ? 'true' : 'false'}" aria-live="polite">
      <div class="question-meta">
        ${payload.difficulty ? `<span class="badge badge--${escapeHtml(payload.difficulty)}">${escapeHtml(DIFFICULTY_LABELS[payload.difficulty] || payload.difficulty)}</span>` : ''}
        ${payload.isBonus ? '<span class="badge badge--bonus">×2 BONUS</span>' : ''}
        ${payload.deadline ? '<span id="player-timer" class="timer" role="timer" aria-live="off"></span>' : ''}
      </div>
      <h2>${escapeHtml(payload.question)}</h2>
      <div class="options-grid" id="player-options">${options}</div>
    </article>
  `;

  wirePlayerOptions(payload.deadline);
  // Rejoin : on restaure la réponse déjà envoyée (elle survit au rechargement
  // de la connexion, sans quoi le joueur croirait l'avoir perdue).
  if (payload.myAnswer) {
    const btn = document.querySelector(`#player-options .option-card[data-key="${payload.myAnswer}"]`);
    if (btn) {
      btn.classList.add('is-selected');
      btn.setAttribute('aria-pressed', 'true');
    }
  }
}

function wirePlayerOptions(deadline) {
  const grid = document.querySelector('#player-options');
  if (!grid) return;
  grid.querySelectorAll('.option-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      grid.querySelectorAll('.option-card').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('is-selected', on);
        b.setAttribute('aria-pressed', String(on));
      });
      socket.send(JSON.stringify({ type: 'game.answer', payload: { optionKey: key } }));
    });
  });
  if (deadline) startPlayerTimer(deadline);
}

function startPlayerTimer(deadline) {
  clearInterval(playerTimerId);
  const tick = () => {
    const el = document.querySelector('#player-timer');
    if (!el) { clearInterval(playerTimerId); return; }
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    el.textContent = left > 0 ? `${left} s` : 'Temps écoulé';
    el.classList.toggle('timer--urgent', left > 0 && left <= 10);
    el.classList.toggle('timer--over', left === 0);
  };
  tick();
  playerTimerId = setInterval(tick, 500);
}

function renderPlayerReveal(payload) {
  showDisconnect(true);
  setHeaderFromMeta();
  const options = (payload.options || lastQuestion?.options || []).map(o => {
    let cls = 'option-card';
    let badge = '';
    if (o.key === payload.answer) {
      cls += ' option-card--correct';
      badge = '<span class="badge badge--easy">Bonne réponse</span>';
    } else if (o.key === payload.funnyOption) {
      cls += ' option-card--funny';
      badge = '<span class="badge badge--funny">Option drôle</span>';
    } else {
      cls += ' option-card--muted';
    }
    return `<div class="${cls}"><div class="option-card__row"><span class="option-card__key">${escapeHtml(o.key)}</span><span class="option-card__text">${escapeHtml(o.text)}</span></div>${badge}</div>`;
  }).join('');

  const mine = (payload.results || []).find(r => r.id === clientId);
  const correct = mine && mine.answered === payload.answer;
  const penalty = mine?.penalty || 0;
  let result;
  if (mine?.eliminated) result = '<span class="answer-result answer-result--none">☠ Exclu de la manche · +0</span>';
  else if (!mine?.answered) result = penalty > 0
    ? `<span class="answer-result answer-result--wrong">— Pas de réponse · −${penalty}</span>`
    : '<span class="answer-result answer-result--none">— Pas de réponse · +0</span>';
  else if (correct) result = '<span class="answer-result answer-result--correct">✓ Bonne réponse</span>';
  else result = penalty > 0
    ? `<span class="answer-result answer-result--wrong">✕ −${penalty}</span>`
    : '<span class="answer-result answer-result--wrong">✕ Raté</span>';

  const myCard = mine ? `
    <div class="answer-card${correct ? ' answer-card--correct' : (mine.answered ? ' answer-card--wrong' : '')}">
      <div class="answer-card__head">
        <span aria-hidden="true">${mine.emoji}</span>
        <span class="answer-card__name">${escapeHtml(mine.name)}</span>
        <span class="answer-card__score">${mine.score} pt${mine.score > 1 ? 's' : ''}</span>
      </div>
      <div class="answer-result-line">
        <span>Choix : <strong>${mine.answered || '—'}</strong></span>
        ${result}
      </div>
    </div>
  ` : '';

  document.querySelector('#game-body').innerHTML = `
    <article id="question-card" class="question-card" aria-live="polite">
      <div class="question-meta">
        ${payload.difficulty ? `<span class="badge badge--${escapeHtml(payload.difficulty)}">${escapeHtml(DIFFICULTY_LABELS[payload.difficulty] || payload.difficulty)}</span>` : ''}
      </div>
      <h2>${escapeHtml(payload.question || lastQuestion?.question || '')}</h2>
      <div class="options-grid">${options}</div>
      ${payload.explanation ? `<div class="explanation">${escapeHtml(payload.explanation)}</div>` : ''}
    </article>
    <section class="answer-entry">
      <h3>Résultat</h3>
      <div class="player-answer-grid">${myCard}</div>
    </section>
  `;
}

function renderMancheEnd(payload) {
  showDisconnect(true);
  setHeader('Fin de manche', '', 100);
  const winner = (payload.players || []).find(p => p.id === payload.winnerId);
  const rows = [...(payload.players || [])]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .map((p) => {
      const won = p.manchesWon || 0;
      const pips = Array.from({ length: payload.manchesTarget || 1 }, (_, i) =>
        `<span class="manche-pip${i < won ? ' manche-pip--won' : ''}"></span>`).join('');
      return `
        <div class="podium__row${p.id === payload.winnerId ? ' podium__row--first' : ''}">
          <span aria-hidden="true">${p.emoji}</span>
          <span class="answer-card__name">${escapeHtml(p.name)}</span>
          <span class="manche-pips" aria-label="${won} manche${won > 1 ? 's' : ''} gagnée${won > 1 ? 's' : ''}">${pips}</span>
          <span class="answer-card__score">${p.score ?? 0} pt</span>
        </div>
      `;
    }).join('');
  document.querySelector('#game-body').innerHTML = `
    <article class="question-card" aria-live="polite">
      <h2>${winner ? `🏅 ${escapeHtml(winner.name)} remporte la manche&nbsp;!` : 'Manche terminée'}</h2>
      <div class="podium">${rows}</div>
      <p class="gap-msg">Prochaine manche à venir…</p>
    </article>
  `;
}

function renderVictory(payload) {
  showDisconnect(true);
  setHeader('Partie terminée', '', 100);
  const winner = (payload.players || []).find(p => p.id === payload.winnerId);
  const ranked = [...(payload.players || [])]
    .sort((a, b) => (b.manchesWon || 0) - (a.manchesWon || 0) || (b.score || 0) - (a.score || 0));
  const maxWon = Math.max(1, ...(payload.players || []).map(p => p.manchesWon || 0));
  const medals = ['🥇', '🥈', '🥉'];
  const podiumHtml = ranked.slice(0, 3).map((p, i) => `
    <div class="podium__row ${i === 0 ? 'podium__row--first' : ''}">
      <span class="podium__rank" aria-hidden="true">${medals[i] || `${i + 1}`}</span>
      <span class="podium__emoji" aria-hidden="true">${p.emoji}</span>
      <div class="podium__info">
        <div class="answer-card__name">${escapeHtml(p.name)}</div>
        <div class="podium__bar"><span style="width:${Math.round(((p.manchesWon || 0) / maxWon) * 100)}%"></span></div>
      </div>
      <span class="answer-card__score">${p.manchesWon || 0} manche${(p.manchesWon || 0) > 1 ? 's' : ''}</span>
    </div>
  `).join('');
  document.querySelector('#game-body').innerHTML = `
    <article class="question-card" aria-live="polite">
      <div class="victory-header">
        <h1 class="winner-title">${winner ? `🏆 ${escapeHtml(winner.name)} gagne la partie&nbsp;!` : 'Partie terminée&nbsp;!'}</h1>
        <p>Merci d'avoir joué&nbsp;!</p>
      </div>
      <div class="podium" aria-label="Classement">${podiumHtml}</div>
    </article>
  `;
}

function renderWaitingForGame() {
  showDisconnect(true);
  setHeader('En attente…', '', 0);
  document.querySelector('#game-body').innerHTML = `
    <article class="question-card">
      <div class="loading-panel">
        <div class="join-emoji" aria-hidden="true">${myEmoji}</div>
        <h2>Reconnecté·e&nbsp;!</h2>
        <p>En attente de la prochaine question…</p>
      </div>
    </article>
  `;
}

function renderRoomClosed() {
  showDisconnect(false);
  setHeader('Partie terminée', '', 100);
  document.querySelector('#game-body').innerHTML = `
    <article class="question-card">
      <div class="loading-panel">
        <div class="join-emoji" aria-hidden="true">👋</div>
        <h2>La partie est terminée.</h2>
        <p>L'hôte a fermé la partie. Merci d'avoir joué&nbsp;!</p>
      </div>
    </article>
  `;
}
