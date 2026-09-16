// player.js — point d'entrée « joueur » (multijoueur en ligne, WS.md §18).
//
// Ouvert via /game/<sessionId>. Écran de connexion minimal : un prénom, un
// avatar choisi dans une frise défilante, puis l'attente du début de partie.
// La réception des questions arrive à l'étape suivante.

import { PLAYER_EMOJIS, PLAYER_EMOJI_LABELS, NAME_MAX_LENGTH } from './constants.js';
import { relayWsUrl } from './relay.js';

let socket = null;
let myPlayerId = null;
let myName = '';
let myEmoji = '';

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
    submitJoin(name, selectedEmoji);
  });

  // Connexion au relais, une seule fois pour tout l'écran.
  socket = new WebSocket(relayWsUrl(sessionId));
  socket.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'session.connected') {
      myPlayerId = msg.payload.playerId;
    } else {
      handleMessage(msg);
    }
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

  const send = () => socket.send(JSON.stringify({ type: 'lobby.join', payload: { name, emoji } }));
  if (socket?.readyState === WebSocket.OPEN) {
    send();
  } else {
    socket.addEventListener('open', send, { once: true });
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'lobby.join.rejected':
      if (msg.payload?.targetId === myPlayerId) {
        showError(reasonMessage(msg.payload.reason));
        resetSubmit();
      }
      break;
    case 'lobby.roster': {
      const players = msg.payload?.players || [];
      // On n'est « connecté » que si NOTRE identité (id du relais) figure dans
      // le roster : les broadcasts liés aux autres joueurs ne doivent pas nous
      // faire quitter le formulaire avant notre propre acceptation.
      if (players.some(p => p.id === myPlayerId)) renderWaiting(players);
      break;
    }
    case 'game.start':
      renderStarted();
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
  `;
}

function renderStarted() {
  const body = document.querySelector('.join__body');
  body.innerHTML = `
    <p class="join-waiting__emoji" aria-hidden="true">${myEmoji}</p>
    <p class="join-waiting">La partie commence&nbsp;!</p>
    <p class="join-waiting-hint">Les questions vont arriver…</p>
  `;
}
