// screens/lobby.js — écran LOBBY (multijoueur en ligne, WS.md §18).
//
// Le host y partage le lien d'invitation et voit les joueurs rejoindre. La
// diffusion des questions aux joueurs (phase suivante) n'est pas encore branchée.

import { getState, dispatch, subscribe } from '../state.js';
import { renderThemeSelect, wireThemeSelect } from '../themeSwitcher.js';
import { playerChips } from '../components/playerChip.js';
import { leaveRoomIfOnline, send, getConnInfo } from '../room.js';
import { connIndicatorHtml, wireConnIndicator } from '../connIndicator.js';
import { MAX_PLAYERS, MIN_PLAYERS } from '../constants.js';

let teardown = null;
let root = null;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function lobbyHtml(s) {
  const shareUrl = s.room?.shareUrl || '';
  const count = s.players.length;
  const roster = count
    ? playerChips(s.players, { className: 'arcade-avatar' })
    : '<span class="lobby-empty">En attente de joueurs…</span>';

  return `
    <section class="arcade arcade--lobby screen" data-screen="lobby">
      <div class="arcade__topbar">${connIndicatorHtml()}${renderThemeSelect()}</div>

      <header class="arcade__title">
        <h1>Lobby</h1>
        <p>Partagez le lien, les joueurs rejoignent la partie.</p>
      </header>

      <div class="lobby-card">
        <span class="lobby-card__label">Lien d'invitation</span>
        <div class="lobby-link">
          <input id="lobby-link" type="text" readonly value="${escapeHtml(shareUrl)}" />
          <button id="btn-copy" class="arcade-btn arcade-btn--small" type="button">Copier</button>
        </div>
        <div id="lobby-qr" class="lobby-qr"></div>
        <p class="lobby-qr-hint">Scannez avec un téléphone pour rejoindre.</p>
      </div>

      <div class="arcade-plaque">
        <span class="arcade-plaque__label">Joueurs connectés</span>
        <strong class="arcade-plaque__name">${count} / ${MAX_PLAYERS}</strong>
        <div class="arcade-plaque__roster">${roster}</div>
      </div>

      <nav class="arcade__menu" aria-label="Lobby">
        <button id="btn-start" class="arcade-btn arcade-btn--primary" disabled>▶ Démarrer la partie</button>
        <button id="btn-quit" class="arcade-btn">Quitter le lobby</button>
      </nav>
    </section>
  `;
}

function quit() {
  leaveRoomIfOnline();
  dispatch({ type: 'GOTO_HOME' });
}

function startGame() {
  // On prévient les joueurs, puis on lance la partie côté host (START_GAME
  // déclenche la génération des questions).
  send('game.start', {});
  dispatch({ type: 'START_GAME', resetHistory: true });
}

function copyLink() {
  const link = getState().room?.shareUrl;
  if (!link) return;
  navigator.clipboard?.writeText(link).then(() => {
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
    wireThemeSelect(root);
    wireConnIndicator(root, getConnInfo, signal);
    root.querySelector('#btn-start').addEventListener('click', startGame, { signal });
    root.querySelector('#btn-quit').addEventListener('click', quit, { signal });
    root.querySelector('#btn-copy').addEventListener('click', copyLink, { signal });
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
