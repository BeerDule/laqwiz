// player.js — point d'entrée « joueur » (multijoueur en ligne, WS.md §18).
//
// Ouvert via /game/<sessionId>. Écran de connexion minimal : un prénom, un
// avatar choisi dans une frise défilante, puis l'attente du début de partie.
// La réception des questions arrive à l'étape suivante.

import { PLAYER_EMOJIS, PLAYER_EMOJI_LABELS, NAME_MAX_LENGTH } from './constants.js';
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

  rootEl.querySelector('#player-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = rootEl.querySelector('#player-name').value.trim();
    if (!name) {
      showError('Indique ton prénom pour rejoindre.');
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
  const body = document.querySelector('.join__body');
  body.innerHTML = `
    <p class="join-waiting__emoji" aria-hidden="true">${emoji}</p>
    <p class="join-waiting">${escapeHtml(name)}, tu es connecté·e&nbsp;!</p>
    <p class="join-waiting-hint">En attente du début de la partie…</p>
  `;
}
