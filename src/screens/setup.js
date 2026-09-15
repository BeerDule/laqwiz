// screens/setup.js — écran SETUP (joueurs, thème, règles) (SPEC §12.2).
import { getState, dispatch, subscribe } from '../state.js';
import {
  PLAYER_EMOJIS, PLAYER_COLORS, PRESET_THEMES,
  MIN_PLAYERS, MAX_PLAYERS, NAME_MAX_LENGTH,
  THEME_MIN_LENGTH, THEME_MAX_LENGTH,
  TARGET_SCORE_MIN, TARGET_SCORE_MAX,
  DIFFICULTY_CHOICES, AUDIENCE_CHOICES, TIMER_CHOICES, PUNISHER_CHOICES, MANCHE_CHOICES,
} from '../constants.js';
import { renderThemeSelect, wireThemeSelect } from '../themeSwitcher.js';
import { searchArticles, parseArticleUrl } from '../wikipedia.js';
import { listResumes } from '../db.js';

// Le mode BYOK — chaque joueur renseigne sa propre configuration LLM — est
// obligatoire en production par défaut, optionnel en développement.
// `LLM_CONFIG_REQUIRED=false` dans l'environnement de build le désactive, pour
// un déploiement dont le serveur porte déjà les identifiants (voir vite.config.js).
const REQUIRE_LLM_CONFIG = __REQUIRE_LLM_CONFIG__;

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

// Même mécanisme que dans game.js : main.js écoute `qc:toast` et affiche.
function dispatchToast(message, kind = 'info') {
  document.dispatchEvent(new CustomEvent('qc:toast', { detail: { message, kind } }));
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

/**
 * L'article choisi ne compte que tant que la case est cochée. On garde `wikiPick`
 * intact pour qu'un décochage suivi d'un recochage retrouve la sélection, mais
 * sans ce filtre le formulaire partirait en mode article alors que le MJ croit
 * l'avoir désactivé.
 */
function activeWikiPick() {
  return root?.querySelector('#wiki-enabled')?.checked ? wikiPick : null;
}

/** Priorité : article Wikipédia > thème libre > thème prédéfini. */
function currentTheme() {
  const wiki = activeWikiPick();
  if (wiki) return wiki.title;
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
  // Le mode article exige un choix explicite : une recherche tapée mais jamais
  // validée ne doit pas lancer une partie silencieusement sans source.
  if (root.querySelector('#wiki-enabled')?.checked && !activeWikiPick()) {
    return { ok: false, msg: 'Choisissez un article dans la liste, ou collez son URL.' };
  }
  const theme = currentTheme();
  if (!theme) return { ok: false, msg: 'Choisissez un thème.' };
  // Un titre d'article vient de Wikipédia et peut légitimement dépasser la
  // limite prévue pour un thème saisi à la main.
  if (!activeWikiPick() && (theme.length < THEME_MIN_LENGTH || theme.length > THEME_MAX_LENGTH)) {
    return { ok: false, msg: `Le thème doit faire entre ${THEME_MIN_LENGTH} et ${THEME_MAX_LENGTH} caractères.` };
  }
  if (!getState().ui.isOnline) {
    return { ok: false, msg: 'Connexion requise pour générer les questions.' };
  }
  // La configuration LLM n'est plus saisie ici : elle est globale à l'appareil
  // (menu principal > Paramètres). On vérifie seulement qu'elle existe.
  if (REQUIRE_LLM_CONFIG) {
    const { baseUrl, apiKey, model } = getState().llm;
    if (!baseUrl || !apiKey || !model) {
      return { ok: false, msg: 'Configurez votre modèle LLM depuis Paramètres, au menu principal.' };
    }
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
  const select = root.querySelector('#theme-select');
  if (selectedPreset) select.value = selectedPreset;
  if (customTheme) root.querySelector('#custom-theme').value = customTheme;
}

// --- Source Wikipédia ---

let wikiPick = null;   // { lang, title, url } choisi par le MJ
let wikiDebounce = null;
let wikiSeq = 0;       // ignore les réponses arrivées dans le désordre

function showWikiChoice() {
  const el = root.querySelector('#wiki-chosen');
  const results = root.querySelector('#wiki-results');
  results.hidden = true;
  results.innerHTML = '';
  root.querySelector('#wiki-search').setAttribute('aria-expanded', 'false');
  if (!wikiPick) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.innerHTML = `Article retenu : <strong>${escapeHtml(wikiPick.title)}</strong>
    <span class="wiki-lang">${escapeHtml(wikiPick.lang)}.wikipedia.org</span>`;
}

function renderWikiResults(items) {
  const results = root.querySelector('#wiki-results');
  const input = root.querySelector('#wiki-search');
  if (!items.length) {
    results.hidden = true;
    results.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    return;
  }
  results.innerHTML = items.map(it => `
    <li role="option" tabindex="0" data-title="${escapeHtml(it.title)}" data-url="${escapeHtml(it.url)}">
      ${escapeHtml(it.title)}
    </li>`).join('');
  results.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

async function runWikiSearch(raw) {
  const pasted = parseArticleUrl(raw);
  if (pasted) { // une URL collée n'a pas besoin de la recherche
    wikiPick = { ...pasted, url: raw.trim() };
    root.querySelector('#wiki-search').value = pasted.title;
    showWikiChoice();
    return;
  }
  const seq = ++wikiSeq;
  try {
    const items = await searchArticles(raw);
    if (seq !== wikiSeq || !root) return; // une frappe plus récente a pris la main
    renderWikiResults(items);
  } catch {
    if (seq === wikiSeq && root) renderWikiResults([]);
  }
}

function wireWikiSearch(signal) {
  const toggle = root.querySelector('#wiki-enabled');
  const group = root.querySelector('#wiki-group');
  const input = root.querySelector('#wiki-search');
  const results = root.querySelector('#wiki-results');

  toggle.addEventListener('change', () => {
    group.hidden = !toggle.checked;
  }, { signal });

  input.addEventListener('input', () => {
    wikiPick = null;
    showWikiChoice();
    clearTimeout(wikiDebounce);
    const value = input.value;
    // Anti-rebond : sans ça, chaque frappe déclenche un appel à Wikipédia.
    wikiDebounce = setTimeout(() => runWikiSearch(value), 250);
  }, { signal });

  const choose = (li) => {
    wikiPick = {
      lang: parseArticleUrl(li.dataset.url)?.lang || 'fr',
      title: li.dataset.title,
      url: li.dataset.url,
    };
    input.value = li.dataset.title;
    showWikiChoice();
  };
  results.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-title]');
    if (li) choose(li);
  }, { signal });
  results.addEventListener('keydown', (e) => {
    const li = e.target.closest('li[data-title]');
    if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose(li); }
  }, { signal });
}

/**
 * Recharge les parties interrompues DE LA SESSION COURANTE.
 *
 * L'écran ne peut pas se contenter de ce que `ui.resumables` contient : ouvrir
 * une session vide cette liste (elle appartient à une session), et selon le
 * chemin emprunté — accueil, gestionnaire, sortie de partie — personne ne la
 * repeuplait. Charger ici rend l'écran autonome quel que soit le chemin.
 */
let lastLoadedSessionId = null;
function loadResumesFor(sessionId) {
  lastLoadedSessionId = sessionId;
  if (!sessionId) {
    dispatch({ type: 'SET_RESUMABLES', snapshots: [] });
    return;
  }
  listResumes(sessionId).then((snapshots) => {
    // L'écran a pu être démonté, ou la session changer, pendant la lecture.
    if (!root || getState().session?.id !== sessionId) return;
    dispatch({ type: 'SET_RESUMABLES', snapshots });
  });
}

/**
 * Liste des parties interrompues de la session. Masquée quand il n'y en a
 * aucune — le bandeau restait affiché à vide tant que `resumable` n'était pas
 * nettoyé après une victoire.
 */
function renderResumeBanner() {
  const el = root.querySelector('#resume-banner');
  if (!el) return;
  const list = getState().ui.resumables || [];
  el.hidden = list.length === 0;
  if (!list.length) return;

  root.querySelector('#resume-list').innerHTML = list.map(r => {
    const manche = (r.partie?.mancheIndex ?? 0) + 1;
    const total = r.partie?.manchesTarget ?? '?';
    // Prénom inclus : entre deux parties de la même session, les emojis se
    // ressemblent et le score seul ne dit pas de quelle tablée il s'agit.
    // L'échappement est appliqué plus bas, sur la chaîne entière.
    const scores = (r.players || [])
      .map(p => `${p.emoji} ${p.name || 'Joueur'} ${p.score ?? 0}`)
      .join(' · ');
    let quand = '';
    try {
      quand = new Date(r.savedAt).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    } catch { /* horodatage illisible */ }
    return `
      <li class="resume-item" data-partie="${escapeHtml(r.partieId)}">
        <span class="resume-item__label">Manche ${manche}/${total}${scores ? ` · ${escapeHtml(scores)}` : ''}${quand ? ` · ${quand}` : ''}</span>
        <button class="button button--primary" type="button" data-resume-action="resume">Reprendre</button>
        <button class="button button--ghost button--danger" type="button" data-resume-action="drop">Supprimer</button>
      </li>`;
  }).join('');
}

function renderSettings() {
  const { settings: s, session } = getState();
  loadResumesFor(getState().session?.id ?? null);
  renderResumeBanner();

  const banner = root.querySelector('#session-banner');
  if (banner) {
    banner.hidden = !session;
    if (session) root.querySelector('#session-name').value = session.name;
  }
  root.querySelector('#target-score').value = s.targetScore;
  root.querySelector('#target-score-output').textContent = s.targetScore;
  root.querySelector('#two-point-lead').checked = s.twoPointLead;
  root.querySelector('#bonus-enabled').checked = s.bonusEnabled;
  root.querySelector('#timer-enabled').checked = s.timerEnabled;
  root.querySelector('#penalty-no-answer').checked = s.penaltyNoAnswer;
  root.querySelector('#penalty-wrong-answer').checked = s.penaltyWrongAnswer;

  const wikiOn = s.sourceMode === 'wikipedia' && !!s.sourceTitle;
  root.querySelector('#wiki-enabled').checked = wikiOn;
  root.querySelector('#wiki-group').hidden = !wikiOn;
  wikiPick = wikiOn
    ? { lang: s.sourceLang || 'fr', title: s.sourceTitle, url: s.sourceUrl || '' }
    : null;
  if (wikiOn) root.querySelector('#wiki-search').value = s.sourceTitle;
  showWikiChoice();
  const mancheInput = root.querySelector(
    `input[name="manchesTarget"][value="${s.manchesTarget || 3}"]`
  );
  if (mancheInput) mancheInput.checked = true;
  root.querySelector('#punisher-severity-group').hidden = !s.penaltyWrongAnswer;
  const punisherInput = root.querySelector(
    `input[name="punisherSeverity"][value="${s.punisherSeverity || 'punitive'}"]`
  );
  if (punisherInput) punisherInput.checked = true;
  root.querySelector('#timer-duration-group').hidden = !s.timerEnabled;
  const timerInput = root.querySelector(
    `input[name="timePerQuestion"][value="${s.timePerQuestion || 60}"]`
  );
  if (timerInput) timerInput.checked = true;
  const difficultyInput = root.querySelector(
    `input[name="difficulty"][value="${s.difficulty || 'balanced'}"]`
  );
  if (difficultyInput) difficultyInput.checked = true;
  const audienceInput = root.querySelector(
    `input[name="audience"][value="${s.audience || 'general'}"]`
  );
  if (audienceInput) audienceInput.checked = true;
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
  const select = root.querySelector('#theme-select');
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

  select.addEventListener('change', () => {
    selectedPreset = select.value || null;
    customTheme = '';
    customInput.value = '';
    updateStartButton();
  }, { signal });

  customInput.addEventListener('input', () => {
    customTheme = customInput.value;
    if (customTheme.trim()) {
      selectedPreset = null;
      select.value = '';
    }
    updateStartButton();
  }, { signal });

  slider.addEventListener('input', () => {
    root.querySelector('#target-score-output').textContent = slider.value;
  }, { signal });

  root.querySelector('#btn-sessions').addEventListener('click', () => {
    dispatch({ type: 'GOTO_SESSIONS' });
  }, { signal });

  root.querySelector('#btn-home').addEventListener('click', () => {
    dispatch({ type: 'GOTO_HOME' });
  }, { signal });

  // Délégation : la liste est réécrite à chaque rendu, un écouteur par bouton
  // serait perdu au premier redessin.
  root.querySelector('#resume-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-resume-action]');
    if (!btn) return;
    const partieId = btn.closest('.resume-item')?.dataset.partie;
    if (!partieId) return;
    const snapshot = (getState().ui.resumables || []).find(r => r.partieId === partieId);
    if (!snapshot) return;

    if (btn.dataset.resumeAction === 'resume') {
      dispatch({ type: 'RESUME_PARTIE', snapshot });
    } else if (window.confirm('Supprimer définitivement cette partie interrompue ?')) {
      dispatch({ type: 'DISCARD_RESUME', partieId });
      renderResumeBanner();
    }
  }, { signal });

  wireWikiSearch(signal);

  // `change` et non `input` : chaque renommage écrit la session dans IndexedDB.
  // Un dispatch par frappe ferait une transaction par caractère.
  const sessionName = root.querySelector('#session-name');
  sessionName.addEventListener('change', () => {
    const s = getState();
    if (!s.session) return;
    const name = sessionName.value.trim().slice(0, 60);
    if (!name) { sessionName.value = s.session.name; return; } // pas de nom vide
    if (name === s.session.name) return;
    dispatch({ type: 'RENAME_SESSION', id: s.session.id, name });
  }, { signal });

  const timerToggle = root.querySelector('#timer-enabled');
  timerToggle.addEventListener('change', () => {
    root.querySelector('#timer-duration-group').hidden = !timerToggle.checked;
  }, { signal });

  const punisherToggle = root.querySelector('#penalty-wrong-answer');
  punisherToggle.addEventListener('change', () => {
    root.querySelector('#punisher-severity-group').hidden = !punisherToggle.checked;
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
        difficulty: root.querySelector('input[name="difficulty"]:checked')?.value || 'balanced',
        audience: root.querySelector('input[name="audience"]:checked')?.value || 'general',
        timerEnabled: root.querySelector('#timer-enabled').checked,
        timePerQuestion: parseInt(root.querySelector('input[name="timePerQuestion"]:checked')?.value, 10) || 60,
        penaltyNoAnswer: root.querySelector('#penalty-no-answer').checked,
        penaltyWrongAnswer: root.querySelector('#penalty-wrong-answer').checked,
        manchesTarget: parseInt(root.querySelector('input[name="manchesTarget"]:checked')?.value, 10) || 3,
        sourceMode: activeWikiPick() ? 'wikipedia' : 'theme',
        sourceTitle: activeWikiPick()?.title || '',
        sourceLang: activeWikiPick()?.lang || 'fr',
        sourceUrl: activeWikiPick()?.url || '',
        punisherSeverity: root.querySelector('input[name="punisherSeverity"]:checked')?.value || 'punitive',
        // La configuration LLM ne transite plus par ce formulaire : elle est
        // globale à l'appareil et vit dans sa propre tranche d'état.
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
    <section class="setup-screen screen arcade arcade--setup" data-screen="setup" aria-labelledby="setup-title">
      <header class="arcade__bar setup-header">
        <button id="btn-home" class="arcade-btn arcade-btn--icon" type="button" aria-label="Retour au menu">‹</button>
        <h1 id="setup-title">Réglages de partie</h1>
        <button id="btn-sessions" class="arcade-btn arcade-btn--small" type="button">Sessions</button>
        ${renderThemeSelect()}
      </header>
      <!-- Hors du form : Entrée dans ce champ ne doit pas lancer la partie.
           L'attribut autocomplete est posé ici, celui du formulaire ne couvrant
           que ses propres descendants. (Pas de backtick dans ce commentaire : il
           vit dans un template literal.) -->
      <!-- Reprise d'une partie interrompue. C'est ici qu'on atterrit en quittant
           l'écran de jeu, donc c'est ici que la proposition doit être. -->
      <div id="resume-banner" class="arcade-plaque arcade-plaque--slim resume-banner" hidden>
        <span class="resume-banner__label">Parties interrompues</span>
        <ul id="resume-list" class="resume-list"></ul>
      </div>
      <div id="session-banner" class="arcade-plaque arcade-plaque--slim session-banner" hidden>
        <label class="field-label" for="session-name">Nom de la session</label>
        <input id="session-name" type="text" maxlength="60" autocomplete="off"
          spellcheck="false" placeholder="Session sans nom" />
      </div>
      <!-- autocomplete="off" sur le formulaire, pas seulement sur les champs :
           Firefox restaure l'état des cases, radios et curseurs au rechargement,
           et la soumission LIT le DOM. Sans ça, une partie peut démarrer avec des
           réglages restaurés par le navigateur que personne n'a choisis. -->
      <form id="setup-form" novalidate autocomplete="off">
        <fieldset class="panel players-panel">
          <legend>Joueurs <span id="player-count-label">2/6</span></legend>
          <div id="players-list" class="players-list"></div>
          <button type="button" id="btn-add-player" class="button add-player-btn">+ Ajouter un joueur</button>
        </fieldset>
        <fieldset class="panel theme-panel">
          <legend>Thème</legend>
          <div class="theme-select-group">
            <select id="theme-select" aria-label="Choisir un thème prédéfini">
              <option value="">— Choisir un thème —</option>
              ${PRESET_THEMES.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
            </select>
            <label class="field-label" for="custom-theme">Ou inventez le vôtre</label>
            <input id="custom-theme" maxlength="${THEME_MAX_LENGTH}" autocomplete="off" placeholder="Ex. les inventions improbables" />
          </div>
          <label class="toggle-row"><input id="wiki-enabled" type="checkbox" /> <span class="toggle-track"></span> Composer les questions depuis une page Wikipédia</label>
          <div class="wiki-group" id="wiki-group" hidden>
            <label class="field-label" for="wiki-search">Article source</label>
            <div class="wiki-search-wrap">
              <input id="wiki-search" type="search" autocomplete="off" spellcheck="false"
                placeholder="Cherchez un article, ou collez son URL"
                role="combobox" aria-expanded="false" aria-controls="wiki-results" aria-autocomplete="list" />
              <ul id="wiki-results" class="wiki-results" role="listbox" hidden></ul>
            </div>
            <p id="wiki-chosen" class="wiki-chosen" hidden></p>
          </div>
        </fieldset>
        <fieldset class="panel settings-panel">
          <legend>Règles</legend>
          <div class="rule-group">
            <span class="rule-group__label" id="difficulty-label">Difficulté</span>
            <div class="choice-group" role="radiogroup" aria-labelledby="difficulty-label">
              ${DIFFICULTY_CHOICES.map(c => `
                <label class="choice-chip">
                  <input type="radio" name="difficulty" value="${c.value}" />
                  <span>${escapeHtml(c.label)}</span>
                </label>
              `).join('')}
            </div>
          </div>
          <div class="rule-group">
            <span class="rule-group__label" id="audience-label">Public</span>
            <div class="choice-group" role="radiogroup" aria-labelledby="audience-label">
              ${AUDIENCE_CHOICES.map(c => `
                <label class="choice-chip">
                  <input type="radio" name="audience" value="${c.value}" />
                  <span>${escapeHtml(c.label)}</span>
                </label>
              `).join('')}
            </div>
          </div>
          <div class="rule-group">
            <span class="rule-group__label" id="manches-label">Format de la partie</span>
            <div class="choice-group" role="radiogroup" aria-labelledby="manches-label">
              ${MANCHE_CHOICES.map(c => `
                <label class="choice-chip">
                  <input type="radio" name="manchesTarget" value="${c.value}" />
                  <span>${escapeHtml(c.label)}</span>
                </label>
              `).join('')}
            </div>
          </div>
          <label for="target-score">Score cible par manche : <output id="target-score-output">15</output></label>
          <input id="target-score" type="range" min="${TARGET_SCORE_MIN}" max="${TARGET_SCORE_MAX}" step="1" value="15" />
          <label class="toggle-row"><input id="two-point-lead" type="checkbox" /> <span class="toggle-track"></span> Il faut 2 points d'écart pour gagner</label>
          <label class="toggle-row"><input id="bonus-enabled" type="checkbox" /> <span class="toggle-track"></span> Activer les questions bonus ×2</label>
          <label class="toggle-row"><input id="timer-enabled" type="checkbox" /> <span class="toggle-track"></span> Mode chronomètre</label>
          <div class="rule-group" id="timer-duration-group" hidden>
            <span class="rule-group__label" id="timer-label">Temps par question</span>
            <div class="choice-group" role="radiogroup" aria-labelledby="timer-label">
              ${TIMER_CHOICES.map(c => `
                <label class="choice-chip">
                  <input type="radio" name="timePerQuestion" value="${c.value}" />
                  <span>${escapeHtml(c.label)}</span>
                </label>
              `).join('')}
            </div>
          </div>
          <label class="toggle-row"><input id="penalty-no-answer" type="checkbox" /> <span class="toggle-track"></span> −1 point si le joueur n'a pas répondu</label>
          <label class="toggle-row"><input id="penalty-wrong-answer" type="checkbox" /> <span class="toggle-track"></span> Mode punisher : −1 point en cas de mauvaise réponse</label>
          <div class="rule-group" id="punisher-severity-group" hidden>
            <span class="rule-group__label" id="punisher-label">Sévérité</span>
            <div class="choice-group" role="radiogroup" aria-labelledby="punisher-label">
              ${PUNISHER_CHOICES.map(c => `
                <label class="choice-chip">
                  <input type="radio" name="punisherSeverity" value="${c.value}" />
                  <span>${escapeHtml(c.label)}</span>
                </label>
              `).join('')}
            </div>
          </div>
        </fieldset>
        <p id="setup-error" class="form-error" role="alert" hidden></p>
        <button id="btn-start" class="button button--primary button--large" type="submit" disabled>Générer la partie</button>
      </form>
    </section>
  `;

  renderPlayersList();
  renderThemes();
  renderSettings();
  wireThemeSelect(root);

  const cleanup = new AbortController();
  wireEvents(cleanup.signal);

  // La session et les instantanés arrivent de façon asynchrone (IndexedDB) :
  // sans ces deux suivis, le panneau restait figé sur son état de montage.
  let lastResumeKey = '';
  const unsub = subscribe(() => {
    if (!root) return;
    const s = getState();
    showError(s.ui.lastError ? s.ui.lastError.message : null);
    updateStartButton();

    const sessionId = s.session?.id ?? null;
    if (sessionId !== lastLoadedSessionId) loadResumesFor(sessionId);

    const key = (s.ui.resumables || []).map(r => r.partieId).join(',');
    if (key !== lastResumeKey) {
      lastResumeKey = key;
      renderResumeBanner();
    }
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
