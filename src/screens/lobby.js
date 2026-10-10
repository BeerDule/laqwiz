// screens/lobby.js — écran LOBBY (multijoueur en ligne, WS.md §18).
//
// Le host y partage le lien d'invitation et voit les joueurs rejoindre. La
// diffusion des questions aux joueurs (phase suivante) n'est pas encore branchée.

import { getState, dispatch, subscribe } from '../state.js';
import { playerChip } from '../components/playerChip.js';
import { leaveRoomIfOnline, send, getConnInfo, broadcastRoster } from '../room.js';
import { connIndicatorHtml, wireConnIndicator } from '../connIndicator.js';
import { ensureAccountForGame } from '../accountGate.js';
import { MAX_LOBBY_PLAYERS, MIN_PLAYERS, HOST_PLAYER_ID, PLAYER_EMOJIS, NAME_MAX_LENGTH } from '../constants.js';

let teardown = null;
let root = null;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let hostDraft = { name: '', open: false };

function nextFreeEmoji(players) {
  const used = new Set(players.map(p => p.emoji));
  return PLAYER_EMOJIS.find(e => !used.has(e)) || PLAYER_EMOJIS[0];
}

function hostJoinHtml(s) {
  const host = s.players.find(p => p.id === HOST_PLAYER_ID);
  if (host) {
    return `
      <div class="lobby-host lobby-host--joined">
        <span class="lobby-host__label">Tu joues aussi&nbsp;:</span>
        ${playerChip(host, { className: 'arcade-avatar' })}
        <button id="btn-host-leave" class="arcade-btn arcade-btn--small" type="button">Quitter la partie</button>
      </div>`;
  }
  return `
    <div class="lobby-host">
      <button id="btn-host-join" class="arcade-btn arcade-btn--small" type="button" ${hostDraft.open ? 'hidden' : ''}>🎭 Je joue aussi</button>
      <div id="host-join-form" class="lobby-host__form" ${hostDraft.open ? '' : 'hidden'}>
        <input id="host-name" type="text" maxlength="${NAME_MAX_LENGTH}" placeholder="Ton prénom"
          autocomplete="off" aria-label="Ton prénom" value="${escapeHtml(hostDraft.name)}" />
        <button id="btn-host-confirm" class="arcade-btn arcade-btn--small" type="button" ${hostDraft.name ? '' : 'disabled'}>Rejoindre</button>
      </div>
    </div>`;
}

function rosterHtml(players) {
  if (!players.length) return '<span class="lobby-empty">En attente de joueurs…</span>';
  return `<div class="lobby-roster">${players.map(p => `
    <span class="lobby-roster__item">
      <span class="lobby-roster__dot" style="--pc:${p.color || 'var(--color-accent-primary)'}" aria-hidden="true"></span>
      <span class="lobby-roster__emoji" aria-hidden="true">${p.emoji}</span>
      <span class="lobby-roster__name">${escapeHtml(p.name)}</span>
    </span>`).join('')}</div>`;
}

function lobbyHtml(s) {
  const shareUrl = s.room?.shareUrl || '';
  const count = s.players.length;
  const hint = count < MIN_PLAYERS
    ? `<p class="lobby-start-hint">Il faut au moins ${MIN_PLAYERS} joueurs pour commencer.</p>`
    : '';

  return `
    <section class="arcade arcade--lobby screen" data-screen="lobby">
      <div class="arcade__topbar">${connIndicatorHtml()}</div>

      <header class="arcade__title">
        <h1>Lobby</h1>
        <p>Partagez le lien, les joueurs rejoignent la partie.</p>
      </header>

      <div class="lobby-layout">
        <div class="lobby-card">
          <span class="lobby-card__label">Lien d'invitation</span>
          <div class="lobby-link">
            <input id="lobby-link" type="text" readonly value="${escapeHtml(shareUrl)}" />
            <button id="btn-copy" class="arcade-btn arcade-btn--small" type="button">Copier</button>
          </div>
          <div id="lobby-qr" class="lobby-qr"></div>
          <p class="lobby-qr-hint">Scannez avec un téléphone pour rejoindre.</p>
        </div>

        <div class="lobby-panel">
          <div class="arcade-plaque">
            <span class="arcade-plaque__label">Joueurs connectés</span>
            <strong class="arcade-plaque__name">${count} / ${MAX_LOBBY_PLAYERS}</strong>
            ${rosterHtml(s.players)}
          </div>
          ${hostJoinHtml(s)}
        </div>
      </div>

      <nav class="arcade__menu" aria-label="Lobby">
        <button id="btn-start" class="arcade-btn arcade-btn--primary" disabled>▶ Démarrer la partie</button>
        ${hint}
        <button id="btn-quit" class="arcade-btn">Quitter le lobby</button>
      </nav>
    </section>
  `;
}

function quit() {
  leaveRoomIfOnline();
  dispatch({ type: 'GOTO_HOME' });
}

async function startGame() {
  // Mode payant : consomme un crédit avant de lancer (la partie utilise la clé
  // serveur si le MJ n'a pas de clé BYOK). Annule si le compte manque.
  if (!await ensureAccountForGame()) return;
  // On prévient les joueurs du démarrage, puis on lance la partie côté host
  // (START_GAME déclenche la génération des questions).
  send('game.start', {});
  dispatch({ type: 'START_GAME', resetHistory: true });
}

function copyLink() {
  const link = getState().room?.shareUrl;
  if (!link) return;
  navigator.clipboard?.writeText(link).then(() => {
    const btn = root?.querySelector('#btn-copy');
    if (btn) {
      btn.textContent = 'Copié ✓';
      setTimeout(() => { btn.textContent = 'Copier'; }, 2000);
    }
    document.dispatchEvent(new CustomEvent('qc:toast', { detail: { message: 'Lien copié.', kind: 'info' } }));
  }).catch(() => {});
}

function signature() {
  const s = getState();
  return `${s.room?.shareUrl || ''}|${(s.players || []).map(p => p.id).join(',')}`;
}

async function renderQr(shareUrl) {
  const container = root.querySelector('#lobby-qr');
  if (!container || !shareUrl) return;
  // Générateur vendu (MIT) chargé à la demande : zéro dépendance npm runtime.
  const mod = await import('../vendor/qrcode.js');
  const qrcode = mod.default;
  const qr = qrcode(0, 'M');
  qr.addData(shareUrl);
  qr.make();
  container.innerHTML = qr.createSvgTag({
    cellSize: 4,
    margin: 2,
    scalable: true,
    alt: "QR code du lien d'invitation",
  });
}

export function renderLobby(rootEl) {
  unmountLobby();
  root = rootEl;

  let lastSig = '';
  let abort = () => {};

  function render() {
    root.innerHTML = lobbyHtml(getState());
    const cleanup = new AbortController();
    const { signal } = cleanup;
    wireConnIndicator(root, getConnInfo, signal);
    root.querySelector('#btn-start').addEventListener('click', startGame, { signal });
    root.querySelector('#btn-quit').addEventListener('click', quit, { signal });
    root.querySelector('#btn-copy').addEventListener('click', copyLink, { signal });
    // Un clic/focus sélectionne tout le lien : copie manuelle en un geste.
    root.querySelector('#lobby-link').addEventListener('focus', (e) => e.target.select(), { signal });

    const hostJoin = root.querySelector('#btn-host-join');
    const hostName = root.querySelector('#host-name');
    const hostConfirm = root.querySelector('#btn-host-confirm');
    const hostLeave = root.querySelector('#btn-host-leave');
    hostJoin?.addEventListener('click', () => {
      hostDraft.open = true;
      abort();
      render();
      root.querySelector('#host-name')?.focus();
    }, { signal });
    hostName?.addEventListener('input', () => {
      hostDraft.name = hostName.value.trim();
      if (hostConfirm) hostConfirm.disabled = !hostDraft.name;
    }, { signal });
    hostConfirm?.addEventListener('click', () => {
      const name = hostName.value.trim();
      if (!name) return;
      dispatch({ type: 'ROOM_ADD_HOST', name, emoji: nextFreeEmoji(getState().players) });
      broadcastRoster();
      hostDraft = { name: '', open: false };
    }, { signal });
    hostLeave?.addEventListener('click', () => {
      dispatch({ type: 'ROOM_REMOVE_HOST' });
      broadcastRoster();
    }, { signal });

    root.querySelector('#btn-start').disabled = getState().players.length < MIN_PLAYERS;
    abort = () => cleanup.abort();
    renderQr(getState().room?.shareUrl);
  }

  render();
  lastSig = signature();

  const unsub = subscribe(() => {
    if (!root) return;
    const sig = signature();
    if (sig !== lastSig) {
      lastSig = sig;
      abort();
      render();
    }
  });

  teardown = () => {
    unsub();
    abort();
    root = null;
  };
}

export function unmountLobby() {
  if (teardown) { teardown(); teardown = null; }
  root = null;
}
