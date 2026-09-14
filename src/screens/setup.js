// screens/setup.js — écran SETUP (joueurs, thème, règles) (SPEC §12.2).
import { getState, dispatch, subscribe } from '../state.js';
import {
  PLAYER_EMOJIS, PLAYER_COLORS, PRESET_THEMES,
  MIN_PLAYERS, MAX_PLAYERS, NAME_MAX_LENGTH,
  THEME_MIN_LENGTH, THEME_MAX_LENGTH,
  TARGET_SCORE_MIN, TARGET_SCORE_MAX,
} from '../constants.js';

let teardown = null;
let root = null;

// État local du formulaire (persisté uniquement à la soumission).
let players = [];
let idCounter = 0;
let selectedPreset = null;
let customTheme = '';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function maxNumericId(list) {
  let max = 0;
  for (const p of list) {
    const m = /^p(\d+)$/.exec(p.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

function freshId() {
  return `p${++idCounter}`;
}

function nextColor() {
  const used = new Set(players.map(p => p.color));
  return PLAYER_COLORS.find(c => !used.has(c))
    || PLAYER_COLORS[players.length % PLAYER_COLORS.length];
}

function nextEmoji() {
  const used = new Set(players.map(p => p.emoji));
  return PLAYER_EMOJIS.find(e => !used.has(e))
    || PLAYER_EMOJIS[players.length % PLAYER_EMOJIS.length];
}

function currentTheme() {
  return customTheme.trim() || selectedPreset || '';
}

function defaultPlayers() {
  return [
    { id: freshId(), name: '', emoji: PLAYER_EMOJIS[0], color: PLAYER_COLORS[0], score: 0 },
    { id: freshId(), name: '', emoji: PLAYER_EMOJIS[1], color: PLAYER_COLORS[1], score: 0 },
  ];
}

function initLocalState() {
  const s = getState();
  players = (s.players && s.players.length >= MIN_PLAYERS)
    ? s.players.map(p => ({ id: p.id, name: p.name || '', emoji: p.emoji, color: p.color, score: 0 }))
    : defaultPlayers();
  idCounter = maxNumericId(players);

  const theme = s.settings.theme || '';
  if (PRESET_THEMES.includes(theme)) {
    selectedPreset = theme;
    customTheme = '';
  } else {
    selectedPreset = null;
    customTheme = theme;
  }
}

function validateForm() {
  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    return { ok: false, msg: `${MIN_PLAYERS} à ${MAX_PLAYERS} joueurs requis.` };
  }
  const seen = new Set();
  for (const p of players) {
    const name = p.name.trim();
    if (!name || name.length > NAME_MAX_LENGTH) {
      return { ok: false, msg: 'Saisissez un prénom unique (1 à 18 caractères).', focusId: p.id };
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      return { ok: false, msg: 'Deux prénoms identiques sont refusés.', focusId: p.id };
    }
    seen.add(key);
  }
  const theme = currentTheme();
  if (!theme) return { ok: false, msg: 'Choisissez un thème.' };
  if (theme.length < THEME_MIN_LENGTH || theme.length > THEME_MAX_LENGTH) {
    return { ok: false, msg: `Le thème doit faire entre ${THEME_MIN_LENGTH} et ${THEME_MAX_LENGTH} caractères.` };
  }
  if (!getState().ui.isOnline) {
    return { ok: false, msg: 'Connexion requise pour générer les questions.' };
  }
  return { ok: true };
}

function renderPlayersList() {
  const list = root.querySelector('#players-list');
  list.innerHTML = '';
  players.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'player-card';
    card.dataset.id = p.id;
    const displayName = p.name.trim() || `Joueur ${i + 1}`;
    card.innerHTML = `
      <span class="player-card__number">${i + 1}</span>
      <button type="button" class="player-card__emoji" aria-label="Choisir l'emoji de ${escapeHtml(displayName)}">${p.emoji}</button>
      <input type="text" class="player-card__name" maxlength="${NAME_MAX_LENGTH}" value="${escapeHtml(p.name)}" placeholder="Prénom" autocomplete="off" aria-label="Prénom du joueur ${i + 1}" />
      <span class="player-card__color" style="background:${p.color}" aria-hidden="true"></span>
      ${players.length > MIN_PLAYERS ? `<button type="button" class="player-card__remove" aria-label="Supprimer ${escapeHtml(displayName)}">✕</button>` : ''}
    `;
    list.appendChild(card);
  });
  updatePlayerCount();
  updateAddButton();
}

function renderThemes() {
  const group = root.querySelector('#preset-themes');
  group.innerHTML = '';
  PRESET_THEMES.forEach(t => {
    const label = document.createElement('label');
    label.className = 'theme-chip';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'theme';
    radio.value = t;
    radio.checked = (t === selectedPreset);
    label.appendChild(radio);
    label.appendChild(document.createTextNode(t));
    group.appendChild(label);
  });
}

function renderSettings() {
  const s = getState().settings;
  root.querySelector('#target-score').value = s.targetScore;
  root.querySelector('#target-score-output').textContent = s.targetScore;
  root.querySelector('#two-point-lead').checked = s.twoPointLead;
  root.querySelector('#bonus-enabled').checked = s.bonusEnabled;
}

function removePlayer(id) {
  if (players.length <= MIN_PLAYERS) return;
  players = players.filter(p => p.id !== id);
  renderPlayersList();
  updateStartButton();
}

function addPlayer() {
  if (players.length >= MAX_PLAYERS) return;
  players.push({ id: freshId(), name: '', emoji: nextEmoji(), color: nextColor(), score: 0 });
  renderPlayersList();
  updateStartButton();
  const last = root.querySelector('#players-list .player-card:last-child .player-card__name');
  if (last) last.focus();
}

function wireEvents(signal) {
  const form = root.querySelector('#setup-form');
  const list = root.querySelector('#players-list');
  const group = root.querySelector('#preset-themes');
  const customInput = root.querySelector('#custom-theme');
  const slider = root.querySelector('#target-score');
  const addBtn = root.querySelector('#btn-add-player');

  addBtn.addEventListener('click', () => addPlayer(), { signal });

  list.addEventListener('input', (e) => {
    const input = e.target.closest('.player-card__name');
    if (!input) return;
    const card = input.closest('.player-card');
    const p = players.find(x => x.id === card.dataset.id);
    if (!p) return;
    p.name = input.value;
    const idx = players.indexOf(p);
    const display = p.name.trim() || `Joueur ${idx + 1}`;
    card.querySelector('.player-card__emoji')
      .setAttribute('aria-label', `Choisir l'emoji de ${escapeHtml(display)}`);
    updateStartButton();
  }, { signal });

  list.addEventListener('click', (e) => {
    const emojiBtn = e.target.closest('.player-card__emoji');
    if (emojiBtn) {
      const card = emojiBtn.closest('.player-card');
      const p = players.find(x => x.id === card.dataset.id);
      if (p) {
        const i = PLAYER_EMOJIS.indexOf(p.emoji);
        p.emoji = PLAYER_EMOJIS[(i + 1) % PLAYER_EMOJIS.length];
        emojiBtn.textContent = p.emoji;
      }
      return;
    }
    const removeBtn = e.target.closest('.player-card__remove');
    if (removeBtn) {
      removePlayer(removeBtn.closest('.player-card').dataset.id);
    }
  }, { signal });

  group.addEventListener('change', (e) => {
    if (e.target.name === 'theme') {
      selectedPreset = e.target.value;
      customTheme = '';
      customInput.value = '';
      updateStartButton();
    }
  }, { signal });

  customInput.addEventListener('input', () => {
    customTheme = customInput.value;
    if (customTheme.trim()) {
      selectedPreset = null;
      group.querySelectorAll('input[name="theme"]').forEach(r => { r.checked = false; });
    }
    updateStartButton();
  }, { signal });

  slider.addEventListener('input', () => {
    root.querySelector('#target-score-output').textContent = slider.value;
  }, { signal });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = validateForm();
    if (!v.ok) {
      showError(v.msg);
      if (v.focusId) {
        const input = root.querySelector(`.player-card[data-id="${v.focusId}"] .player-card__name`);
        if (input) input.focus();
      }
      return;
    }
    showError(null);
    const targetScore = parseInt(slider.value, 10);
    dispatch({ type: 'SET_PLAYERS', players });
    dispatch({
      type: 'SET_SETTINGS',
      patch: {
        theme: currentTheme(),
        targetScore,
        twoPointLead: root.querySelector('#two-point-lead').checked,
        bonusEnabled: root.querySelector('#bonus-enabled').checked,
      },
    });
    dispatch({ type: 'START_GAME', resetHistory: true });
  }, { signal });
}

export function renderSetup(rootEl) {
  unmountSetup();
  root = rootEl;
  initLocalState();

  root.innerHTML = `
    <section class="setup-screen screen" data-screen="setup" aria-labelledby="setup-title">
      <header class="hero-heading">
        <p class="eyebrow">QUIZ MULTIJOUEUR LOCAL</p>
        <h1 id="setup-title">Quizz <span class="accent">Canapé</span></h1>
        <p>Le savoir. La mauvaise foi. Le canapé.</p>
      </header>
      <form id="setup-form" novalidate>
        <fieldset class="panel players-panel">
          <legend>Les joueurs <span id="player-count-label">2/6</span></legend>
          <div id="players-list" class="players-list"></div>
          <button type="button" id="btn-add-player" class="button add-player">+ Ajouter un joueur</button>
        </fieldset>
        <fieldset class="panel theme-panel">
          <legend>Le thème</legend>
          <div id="preset-themes" role="radiogroup"></div>
          <label class="field-label" for="custom-theme">Ou inventez le vôtre</label>
          <input id="custom-theme" maxlength="60" autocomplete="off" placeholder="Ex. les inventions improbables" />
        </fieldset>
        <fieldset class="panel settings-panel">
          <legend>Les règles</legend>
          <label for="target-score">Score cible : <output id="target-score-output">15</output></label>
          <input id="target-score" type="range" min="${TARGET_SCORE_MIN}" max="${TARGET_SCORE_MAX}" step="1" value="15" />
          <label class="switch-row"><input id="two-point-lead" type="checkbox" /> <span>Il faut 2 points d'écart pour gagner</span></label>
          <label class="switch-row"><input id="bonus-enabled" type="checkbox" /> <span>Activer les questions bonus ×2</span></label>
        </fieldset>
        <p id="setup-error" class="form-error" role="alert" hidden></p>
        <button id="btn-start" class="button button--primary button--large" type="submit" disabled>Générer la partie</button>
      </form>
    </section>
  `;

  renderPlayersList();
  renderThemes();
  renderSettings();

  const cleanup = new AbortController();
  wireEvents(cleanup.signal);

  const unsub = subscribe(() => {
    if (!root) return;
    const s = getState();
    showError(s.ui.lastError ? s.ui.lastError.message : null);
    updateStartButton();
  });

  teardown = () => {
    unsub();
    cleanup.abort();
    root = null;
  };
  updateStartButton();
}

export function unmountSetup() {
  if (teardown) { teardown(); teardown = null; }
  root = null;
}



function showError(msg) {
  const el = root.querySelector('#setup-error');
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

function updateStartButton() {
  const btn = root.querySelector('#btn-start');
  const valid = validateForm().ok;
  btn.disabled = !valid;
}

function updatePlayerCount() {
  const label = root.querySelector('#player-count-label');
  if (label) label.textContent = `${players.length}/${MAX_PLAYERS}`;
}

function updateAddButton() {
  const btn = root.querySelector('#btn-add-player');
  btn.disabled = players.length >= MAX_PLAYERS;
  btn.textContent = players.length >= MAX_PLAYERS ? '6 joueurs maximum' : '+ Ajouter un joueur';
}
