// player.js — point d'entrée « joueur » (multijoueur en ligne, WS.md §18).
//
// Ouvert via /game/<sessionId>. Ne charge AUCUN état host : juste un écran de
// connexion (nom + avatar), puis l'attente du début de partie. La réception des
// questions arrive à l'étape suivante.

import { PLAYER_EMOJIS, PLAYER_EMOJI_LABELS, NAME_MAX_LENGTH } from './constants.js';
import { renderThemeSelect, wireThemeSelect } from './themeSwitcher.js';
import { relayWsUrl } from './relay.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function dispatchToast(message, kind = 'info') {
  document.dispatchEvent(new CustomEvent('qc:toast', { detail: { message, kind } }));
}

export function mountPlayer(rootEl, sessionId) {
  let selectedEmoji = PLAYER_EMOJIS[0];

  rootEl.innerHTML = `
    <section class="arcade arcade--player screen" data-screen="player">
      <div class="arcade__topbar">${renderThemeSelect()}</div>

      <header class="arcade__title">
        <h1>Rejoindre</h1>
        <p>Choisissez votre prénom et votre avatar.</p>
      </header>

      <form id="player-form" class="player-card" novalidate>
        <label class="player-card__label" for="player-name">Votre prénom</label>
        <input id="player-name" type="text" maxlength="${NAME_MAX_LENGTH}" autocomplete="off" placeholder="Ex. Alice" />

        <span class="player-card__label">Votre avatar</span>
        <div id="player-emojis" class="emoji-grid" role="radiogroup" aria-label="Avatar"></div>

        <p id="player-error" class="form-error" role="alert" hidden></p>
        <button id="btn-join" class="button button--primary button--large" type="submit">Rejoindre</button>
      </form>
    </section>
  `;

  wireThemeSelect(rootEl);

  const grid = rootEl.querySelector('#player-emojis');
  grid.innerHTML = PLAYER_EMOJIS.map(e => `
    <button type="button" role="radio" aria-checked="${e === selectedEmoji}"
      aria-label="${escapeHtml(PLAYER_EMOJI_LABELS[e] || 'Avatar')}" data-emoji="${e}"
      class="${e === selectedEmoji ? 'is-selected' : ''}">${e}</button>
  `).join('');

  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-emoji]');
    if (!btn) return;
    selectedEmoji = btn.dataset.emoji;
    grid.querySelectorAll('button').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-checked', String(on));
    });
  });

  rootEl.querySelector('#player-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = rootEl.querySelector('#player-name').value.trim();
    if (!name) {
      showError('Saisissez votre prénom pour rejoindre.');
      return;
    }
    showError('');
    join(sessionId, name, selectedEmoji);
  });
}

function showError(msg) {
  const el = document.querySelector('#player-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
}

function join(sessionId, name, emoji) {
  const btn = document.querySelector('#btn-join');
  btn.disabled = true;
  btn.textContent = 'Connexion…';
  let joined = false;

  const socket = new WebSocket(relayWsUrl(sessionId));

  socket.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'session.connected') {
      // Identifié par le relais : on annonce son identité de jeu (WS.md §18.5).
      socket.send(JSON.stringify({ type: 'lobby.join', payload: { name, emoji } }));
      joined = true;
      renderWaiting(name, emoji);
    }
    // game.question / game.reveal arriveront ici (étape suivante).
  });

  socket.addEventListener('error', () => {
    showError('Impossible de rejoindre la partie (session inexistante ou expirée ?).');
    btn.disabled = false;
    btn.textContent = 'Rejoindre';
  });

  socket.addEventListener('close', () => {
    if (!joined) {
      showError('Connexion perdue avant de rejoindre.');
      btn.disabled = false;
      btn.textContent = 'Rejoindre';
    } else {
      dispatchToast('Connexion perdue.', 'error');
    }
  });
}

function renderWaiting(name, emoji) {
  const card = document.querySelector('.player-card');
  card.innerHTML = `
    <span class="player-card__label">Connecté</span>
    <p class="player-waiting"><span aria-hidden="true">${emoji}</span> ${escapeHtml(name)} — en attente du début de la partie…</p>
    <p class="lobby-hint">Le maître du jeu lancera la partie quand tout le monde sera prêt.</p>
  `;
}
