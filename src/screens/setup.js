// screens/setup.js — écran SETUP (joueurs, thème, règles) (SPEC §12.2).
import { getState, dispatch, subscribe } from '../state.js';
import {
  PLAYER_EMOJIS, PLAYER_EMOJI_LABELS, PLAYER_COLORS, PRESET_THEMES,
  MIN_PLAYERS, MAX_PLAYERS, NAME_MAX_LENGTH,
  THEME_MIN_LENGTH, THEME_MAX_LENGTH,
  TARGET_SCORE_MIN, TARGET_SCORE_MAX,
  DIFFICULTY_CHOICES, AUDIENCE_CHOICES, TIMER_CHOICES, PUNISHER_CHOICES, MANCHE_CHOICES,
  SUDDEN_DEATH_CHOICES,
  MODE_NAME_MAX_LENGTH,
} from '../constants.js';
import { playerChip } from '../components/playerChip.js';
import { renderThemeSelect, wireThemeSelect } from '../themeSwitcher.js';
import { confirmDialog, promptDialog } from '../components/dialog.js';
import { searchArticles, parseArticleUrl } from '../wikipedia.js';
import { listResumes, listParties } from '../db.js';
import {
  loadModes, createMode, updateMode, removeMode, resetBuiltinMode, diffFromMode,
} from '../modes.js';

// Le mode BYOK — chaque joueur renseigne sa propre configuration LLM — est
// obligatoire en production par défaut, optionnel en développement.
// `LLM_CONFIG_REQUIRED=false` dans l'environnement de build le désactive, pour
// un déploiement dont le serveur porte déjà les identifiants (voir vite.config.js).
const REQUIRE_LLM_CONFIG = __REQUIRE_LLM_CONFIG__;

let teardown = null;
let root = null;

// État local du formulaire (persisté uniquement à la soumission).
let players = [];
// Mode sélectionné. `null` = réglages sans mode d'origine (« Personnalisé »).
let selectedModeId = null;
// Joueur dont la grille d'avatars est ouverte. Une seule à la fois.
let pickerFor = null;
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

/**
 * Grille de choix d'avatar.
 *
 * Remplace l'ancien défilement au clic : à trente avatars, atteindre le bon
 * demandait jusqu'à trente clics, sans retour en arrière. Les avatars déjà pris
 * par un autre joueur sont désactivés — deux joueurs identiques sur le plateau
 * rendraient l'attribution des points illisible.
 */
function emojiPickerHtml(player) {
  const pris = new Set(players.filter(x => x.id !== player.id).map(x => x.emoji));
  const cases = PLAYER_EMOJIS.map((e) => {
    const nom = PLAYER_EMOJI_LABELS[e] || e;
    const actif = e === player.emoji;
    return `<button type="button" class="emoji-picker__item${actif ? ' emoji-picker__item--on' : ''}"
      data-emoji="${e}" ${pris.has(e) ? 'disabled' : ''}
      aria-label="${escapeHtml(nom)}${pris.has(e) ? ' (déjà pris)' : ''}"
      aria-pressed="${actif}" title="${escapeHtml(nom)}">${e}</button>`;
  }).join('');
  return `<div class="emoji-picker" role="group" aria-label="Choisir un avatar">${cases}</div>`;
}

function renderPlayersList() {
  const list = root.querySelector('#players-list');
  list.innerHTML = '';
  players.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'player-card';
    card.dataset.id = p.id;
    card.style.setProperty('--pc', p.color || 'var(--color-accent-primary)');
    const displayName = p.name.trim() || `Joueur ${i + 1}`;
    card.innerHTML = `
      <span class="player-card__number">${i + 1}</span>
      <button type="button" class="player-card__emoji" aria-expanded="${p.id === pickerFor}" aria-label="Choisir l'emoji de ${escapeHtml(displayName)}">${p.emoji}</button>
      <input type="text" class="player-card__name" maxlength="${NAME_MAX_LENGTH}" value="${escapeHtml(p.name)}" placeholder="Prénom" autocomplete="off" aria-label="Prénom du joueur ${i + 1}" />
      <span class="player-card__color" style="background:${p.color}" aria-hidden="true"></span>
      ${players.length > MIN_PLAYERS ? `<button type="button" class="player-card__remove" aria-label="Supprimer ${escapeHtml(displayName)}">✕</button>` : ''}
      ${p.id === pickerFor ? emojiPickerHtml(p) : ''}
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

// ===== Historique des parties terminées de la session =====

const HISTORY_EMPTY = '<p class="history-empty">Aucune partie terminée dans cette session.</p>';

const choiceLabel = (choices, value) => choices.find(c => c.value === value)?.label ?? '—';

function formatDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'moins d’une minute';
  const h = Math.floor(min / 60);
  return h ? `${h} h ${String(min % 60).padStart(2, '0')}` : `${min} min`;
}

/** Réglages de la partie, tels qu'ils étaient à son lancement. */
function historyRules(st) {
  const mode = (getState().ui.modes || []).find(m => m.id === st.modeId);
  const wiki = st.sourceMode === 'wikipedia' && st.sourceTitle;
  const link = wiki && /^https?:\/\//.test(st.sourceUrl || '')
    ? `<a href="${escapeHtml(st.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(st.sourceTitle)}</a>`
    : escapeHtml(st.sourceTitle || '');
  const penalties = [
    st.penaltyNoAnswer && '−1 sans réponse',
    st.penaltyWrongAnswer && `Punisher ${choiceLabel(PUNISHER_CHOICES, st.punisherSeverity)}`,
  ].filter(Boolean).join(' · ');
  const rows = [
    ['Mode', mode ? `${mode.emoji} ${escapeHtml(mode.name)}` : '—'],
    ['Sujet', wiki ? `Wikipédia : ${link}` : escapeHtml(st.theme || '—')],
    ['Format', escapeHtml(choiceLabel(MANCHE_CHOICES, st.manchesTarget))],
    ['Score cible', `${st.targetScore ?? '—'} points${st.twoPointLead ? ', 2 points d’écart' : ''}`],
    ['Difficulté', escapeHtml(choiceLabel(DIFFICULTY_CHOICES, st.difficulty))],
    ['Public', escapeHtml(choiceLabel(AUDIENCE_CHOICES, st.audience))],
    ['Chronomètre', st.timerEnabled ? escapeHtml(choiceLabel(TIMER_CHOICES, st.timePerQuestion)) : 'Désactivé'],
    ['Questions bonus', st.bonusEnabled ? 'Oui (×2)' : 'Non'],
    ['Pénalités', escapeHtml(penalties || 'Aucune')],
    ['Mort subite', st.suddenDeathEnabled
      ? `Exclusion à ${escapeHtml(choiceLabel(SUDDEN_DEATH_CHOICES, st.suddenDeathStrikes))}`
      : 'Non'],
  ];
  return rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function historyCard(partie, number) {
  // Les parties archivées avant le gel du roster n'ont pas `players` : le
  // roster courant est alors la meilleure source.
  const byId = Object.fromEntries((partie.players || getState().players).map(p => [p.id, p]));
  const who = id => byId[id] || { name: 'Joueur retiré', emoji: '❔' };
  const manches = partie.manches || [];
  const won = partie.manchesWon || {};
  const ids = [...new Set(manches.flatMap(m => Object.keys(m.scores || {})))]
    .sort((a, b) => (won[b] || 0) - (won[a] || 0));
  const winner = who(partie.winnerId);
  const tally = ids.map(id => won[id] || 0).join(' – ');
  const duration = partie.endedAt && partie.startedAt ? formatDuration(partie.endedAt - partie.startedAt) : '—';
  const avatar = id => `${playerChip(who(id), { className: 'arcade-avatar' })}<span class="history-table__name">${escapeHtml(who(id).name)}</span>`;

  return `
    <article class="history-card">
      <header class="history-card__head">
        <h3 class="history-card__title">Partie ${number}</h3>
        <span class="history-card__when">${formatDateTime(partie.startedAt)} · durée ${duration}</span>
      </header>
      <p class="history-card__winner">
        🏆 ${playerChip(winner, { className: 'arcade-avatar' })}
        <span>${escapeHtml(winner.name)} remporte la partie${manches.length > 1 ? `, <span class="history-card__tally">${tally}</span> en manches` : ''}</span>
      </p>
      <dl class="history-card__rules">${historyRules(partie.settings || {})}</dl>
      <div class="history-card__table">
        <table class="history-table">
          <thead>
            <tr><th scope="col">Manche</th>${ids.map(id => `<th scope="col">${avatar(id)}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${manches.map(m => `
              <tr>
                <th scope="row">${(m.index ?? 0) + 1}</th>
                ${ids.map(id => `<td class="${m.winnerId === id ? 'is-win' : ''}">${m.scores?.[id] ?? '—'}${m.winnerId === id ? ' 🏅' : ''}</td>`).join('')}
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr><th scope="row">Manches gagnées</th>${ids.map(id => `<td>${won[id] || 0}</td>`).join('')}</tr>
          </tfoot>
        </table>
      </div>
    </article>
  `;
}

/** Recharge l'historique, la partie la plus récente en tête. */
function loadHistoryFor(sessionId) {
  if (!root?.querySelector('#history-list')) return;
  if (!sessionId) {
    root.querySelector('#history-list').innerHTML = HISTORY_EMPTY;
    return;
  }
  listParties(sessionId).then((parties) => {
    const list = root?.querySelector('#history-list');
    if (!list || getState().session?.id !== sessionId) return;
    const done = parties.filter(p => p.winnerId);
    list.innerHTML = done.length
      ? done.map((p, i) => historyCard(p, i + 1)).reverse().join('')
      : HISTORY_EMPTY;
  });
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
  loadHistoryFor(sessionId);
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

/**
 * Les onze règles telles que le formulaire les affiche À CET INSTANT.
 *
 * Le formulaire est la vérité tant qu'on n'a pas soumis : c'est lui qu'on
 * compare au mode sélectionné pour le badge « (modifié) », et lui qu'on
 * enregistre quand le MJ crée un mode à partir de ses réglages.
 */
function readRules() {
  const pick = (name, fallback) =>
    root.querySelector(`input[name="${name}"]:checked`)?.value ?? fallback;
  return {
    targetScore: parseInt(root.querySelector('#target-score').value, 10),
    twoPointLead: root.querySelector('#two-point-lead').checked,
    bonusEnabled: root.querySelector('#bonus-enabled').checked,
    difficulty: pick('difficulty', 'balanced'),
    audience: pick('audience', 'general'),
    timerEnabled: root.querySelector('#timer-enabled').checked,
    timePerQuestion: parseInt(pick('timePerQuestion', 60), 10),
    penaltyNoAnswer: root.querySelector('#penalty-no-answer').checked,
    penaltyWrongAnswer: root.querySelector('#penalty-wrong-answer').checked,
    punisherSeverity: pick('punisherSeverity', 'punitive'),
    manchesTarget: parseInt(pick('manchesTarget', 3), 10),
    suddenDeathEnabled: root.querySelector('#sudden-death').checked,
    suddenDeathStrikes: parseInt(pick('suddenDeathStrikes', 3), 10),
  };
}

/** Écrit des règles dans le formulaire, groupes dépendants compris. */
function writeRules(r) {
  const check = (name, value) => {
    const el = root.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  };
  root.querySelector('#target-score').value = r.targetScore;
  root.querySelector('#target-score-output').textContent = r.targetScore;
  root.querySelector('#two-point-lead').checked = r.twoPointLead;
  root.querySelector('#bonus-enabled').checked = r.bonusEnabled;
  root.querySelector('#timer-enabled').checked = r.timerEnabled;
  root.querySelector('#penalty-no-answer').checked = r.penaltyNoAnswer;
  root.querySelector('#penalty-wrong-answer').checked = r.penaltyWrongAnswer;
  root.querySelector('#sudden-death').checked = r.suddenDeathEnabled;
  check('difficulty', r.difficulty);
  check('audience', r.audience);
  check('timePerQuestion', r.timePerQuestion);
  check('punisherSeverity', r.punisherSeverity);
  check('manchesTarget', r.manchesTarget);
  root.querySelector('#timer-duration-group').hidden = !r.timerEnabled;
  root.querySelector('#punisher-severity-group').hidden = !r.penaltyWrongAnswer;
  check('suddenDeathStrikes', r.suddenDeathStrikes);
  root.querySelector('#sudden-death-group').hidden = !r.suddenDeathEnabled;
  refreshAdvanced(r);
}

/**
 * Compteur d'options actives sur le résumé de l'accordéon.
 *
 * L'accordéon reste fermé au montage, y compris quand un mode active des
 * options à l'intérieur. Ce compteur est donc le SEUL indice que des règles
 * sont en vigueur derrière le volet : choisir « Canap' ocalypse » change
 * chrono, pénalités et mort subite sans rien déplier. Ne pas le retirer sans
 * ouvrir l'accordéon à la place.
 */
function refreshAdvanced(r) {
  const compte = root.querySelector('#advanced-count');
  if (!compte) return;
  const actives = [r.bonusEnabled, r.timerEnabled, r.penaltyNoAnswer,
    r.penaltyWrongAnswer, r.suddenDeathEnabled].filter(Boolean).length;
  compte.hidden = actives === 0;
  compte.textContent = String(actives);
  compte.setAttribute('aria-label', `${actives} option${actives > 1 ? 's' : ''} active${actives > 1 ? 's' : ''}`);
}

/** Le mode sélectionné, ou null s'il a été supprimé entre-temps. */
function currentMode() {
  return (getState().ui.modes || []).find(m => m.id === selectedModeId) || null;
}

function renderModes() {
  const modes = getState().ui.modes || [];
  const list = root.querySelector('#modes-list');
  if (!list) return;

  // Le catalogue arrive de façon asynchrone : tant qu'il est vide, ne rien
  // afficher vaut mieux qu'une rangée vide qui sauterait une seconde plus tard.
  if (!modes.length) {
    list.innerHTML = '';
    root.querySelector('#mode-status').textContent = '';
    root.querySelector('#mode-actions').innerHTML = '';
    return;
  }

  list.innerHTML = modes.map(m => `
    <button type="button" class="mode-card${m.id === selectedModeId ? ' mode-card--on' : ''}"
      data-mode="${escapeHtml(m.id)}" role="radio"
      aria-checked="${m.id === selectedModeId}"
      ${m.tagline ? `data-tooltip="${escapeHtml(m.tagline)}"` : ''}>
      <span class="mode-card__emoji" aria-hidden="true">${escapeHtml(m.emoji)}</span>
      <span class="mode-card__name">${escapeHtml(m.name)}</span>
    </button>`).join('')
    + `<button type="button" class="mode-card mode-card--new" data-mode-new="1">
        <span class="mode-card__emoji" aria-hidden="true">+</span>
        <span class="mode-card__name">Créer</span>
      </button>`;

  renderModeStatus();
}

/** Badge « (modifié) » et boutons de gestion du mode sélectionné. */
function renderModeStatus() {
  const mode = currentMode();
  const statut = root.querySelector('#mode-status');
  const actions = root.querySelector('#mode-actions');
  if (!statut || !actions) return;

  if (!mode) {
    statut.textContent = selectedModeId
      ? 'Ce mode a été supprimé. Les règles ci-dessous restent en place.'
      : 'Réglages personnalisés.';
    actions.innerHTML = '<button type="button" class="button button--small" data-mode-act="saveas">Enregistrer comme mode</button>';
    return;
  }

  const ecarts = diffFromMode(readRules(), mode);
  statut.textContent = ecarts.length
    ? `${mode.emoji} ${mode.name} — modifié (${ecarts.length} règle${ecarts.length > 1 ? 's' : ''})`
    : `${mode.emoji} ${mode.name}${mode.tagline ? ` — ${mode.tagline}` : ''}`;

  const boutons = [];
  if (ecarts.length) {
    boutons.push('<button type="button" class="button button--small" data-mode-act="saveas">Enregistrer comme nouveau mode</button>');
    boutons.push(`<button type="button" class="button button--small" data-mode-act="update">Mettre à jour « ${escapeHtml(mode.name)} »</button>`);
    boutons.push('<button type="button" class="button button--small" data-mode-act="revert">Annuler mes retouches</button>');
  }
  boutons.push('<button type="button" class="button button--small" data-mode-act="rename">Renommer</button>');
  if (mode.builtin && mode.dirty) {
    boutons.push('<button type="button" class="button button--small" data-mode-act="reset">Réinitialiser</button>');
  }
  if (!mode.builtin) {
    boutons.push('<button type="button" class="button button--small button--danger" data-mode-act="delete">Supprimer</button>');
  }
  actions.innerHTML = boutons.join('');
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
  writeRules(s);

  const wikiOn = s.sourceMode === 'wikipedia' && !!s.sourceTitle;
  root.querySelector('#wiki-enabled').checked = wikiOn;
  root.querySelector('#wiki-group').hidden = !wikiOn;
  wikiPick = wikiOn
    ? { lang: s.sourceLang || 'fr', title: s.sourceTitle, url: s.sourceUrl || '' }
    : null;
  if (wikiOn) root.querySelector('#wiki-search').value = s.sourceTitle;
  showWikiChoice();
  selectedModeId = s.modeId || null;
  renderModes();
}

function closePicker() {
  if (!pickerFor) return;
  pickerFor = null;
  renderPlayersList();
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

/** Demande nom puis emoji. Renvoie null si le MJ annule ou laisse vide. */
async function askModeIdentity(nomActuel = '', emojiActuel = '') {
  const nom = await promptDialog({
    title: 'Nom du mode',
    label: `Nom du mode (${MODE_NAME_MAX_LENGTH} caractères max)`,
    value: nomActuel,
    maxLength: MODE_NAME_MAX_LENGTH,
    confirmLabel: 'Suivant',
  });
  if (nom === null) return null;
  const emoji = await promptDialog({
    title: 'Emoji du mode',
    label: 'Emoji du mode (laissez vide pour 🎲)',
    value: emojiActuel,
    required: false,
    confirmLabel: 'Créer',
  });
  if (emoji === null) return null;
  return { name: nom, emoji: emoji.trim() || emojiActuel || '🎲' };
}

/** Recharge le catalogue depuis la base et le pousse dans l'état. */
function refreshModes() {
  return loadModes().then(modes => {
    dispatch({ type: 'SET_MODES', modes });
    return modes;
  });
}

function wireModes(signal) {
  // Délégation : cartes et boutons sont réécrits à chaque rendu.
  root.querySelector('#modes-list').addEventListener('click', async (e) => {
    const neuf = e.target.closest('[data-mode-new]');
    if (neuf) {
      const ident = await askModeIdentity();
      if (!ident) return;
      createMode(ident.name, ident.emoji, readRules())
        .then(mode => refreshModes().then(() => {
          selectedModeId = mode.id;
          renderModes();
          dispatchToast(`Mode « ${mode.name} » créé.`);
        }));
      return;
    }
    const carte = e.target.closest('[data-mode]');
    if (!carte) return;
    const mode = (getState().ui.modes || []).find(m => m.id === carte.dataset.mode);
    if (!mode) return;
    selectedModeId = mode.id;
    // Seules les règles sont recopiées : le thème et l'article Wikipédia
    // choisis juste avant ne doivent pas sauter parce qu'on durcit les règles.
    writeRules(mode.settings);
    renderModes();
    updateStartButton();
  }, { signal });

  root.querySelector('#mode-actions').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-mode-act]');
    if (!btn) return;
    const acte = btn.dataset.modeAct;
    const mode = currentMode();

    if (acte === 'saveas') {
      const ident = await askModeIdentity();
      if (!ident) return;
      createMode(ident.name, ident.emoji, readRules())
        .then(cree => refreshModes().then(() => {
          selectedModeId = cree.id;
          renderModes();
          dispatchToast(`Mode « ${cree.name} » créé.`);
        }));
      return;
    }
    if (!mode) return;

    if (acte === 'update') {
      updateMode(mode, { settings: readRules() })
        .then(() => refreshModes().then(() => {
          renderModes();
          dispatchToast(`« ${mode.name} » mis à jour.`);
        }));
    } else if (acte === 'revert') {
      writeRules(mode.settings);
      renderModeStatus();
      updateStartButton();
    } else if (acte === 'rename') {
      const ident = await askModeIdentity(mode.name, mode.emoji);
      if (!ident) return;
      updateMode(mode, ident).then(() => refreshModes().then(renderModes));
    } else if (acte === 'reset') {
      resetBuiltinMode(mode.id).then(frais => refreshModes().then(() => {
        writeRules(frais.settings);
        renderModes();
        updateStartButton();
        dispatchToast(`« ${frais.name} » réinitialisé.`);
      }));
    } else if (acte === 'delete') {
      if (!await confirmDialog({
        title: 'Supprimer le mode',
        message: `Supprimer le mode « ${mode.name} » ? Les règles actuelles restent en place.`,
        confirmLabel: 'Supprimer',
        danger: true,
      })) return;
      removeMode(mode).then(() => refreshModes().then(() => {
        // Les règles du formulaire ne bougent pas : on supprime une étiquette,
        // pas la partie que le MJ est en train de préparer.
        selectedModeId = null;
        renderModes();
        dispatchToast(`Mode « ${mode.name} » supprimé.`);
      }));
    }
  }, { signal });

  // Toute retouche d'une règle rafraîchit le badge « modifié ».
  root.querySelector('.settings-panel').addEventListener('input', renderModeStatus, { signal });
  root.querySelector('.settings-panel').addEventListener('change', renderModeStatus, { signal });
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
    const choix = e.target.closest('.emoji-picker__item');
    if (choix) {
      const id = choix.closest('.player-card').dataset.id;
      const p = players.find(x => x.id === id);
      if (p) p.emoji = choix.dataset.emoji;
      closePicker();
      // Le focus revient au déclencheur : sans cela il repartait en haut de
      // page, la grille venant d'être retirée du document.
      root.querySelector(`.player-card[data-id="${id}"] .player-card__emoji`)?.focus();
      return;
    }
    const emojiBtn = e.target.closest('.player-card__emoji');
    if (emojiBtn) {
      const id = emojiBtn.closest('.player-card').dataset.id;
      pickerFor = pickerFor === id ? null : id;
      renderPlayersList();
      root.querySelector(`.player-card[data-id="${id}"] .emoji-picker__item:not([disabled])`)?.focus();
      return;
    }
    const removeBtn = e.target.closest('.player-card__remove');
    if (removeBtn) {
      removePlayer(removeBtn.closest('.player-card').dataset.id);
    }
  }, { signal });

  // Échap et clic à l'extérieur ferment la grille.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !pickerFor) return;
    const id = pickerFor;
    closePicker();
    root.querySelector(`.player-card[data-id="${id}"] .player-card__emoji`)?.focus();
  }, { signal });

  document.addEventListener('click', (e) => {
    if (!pickerFor || !root) return;
    if (e.target.closest('.emoji-picker') || e.target.closest('.player-card__emoji')) return;
    closePicker();
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
  root.querySelector('#resume-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-resume-action]');
    if (!btn) return;
    const partieId = btn.closest('.resume-item')?.dataset.partie;
    if (!partieId) return;
    const snapshot = (getState().ui.resumables || []).find(r => r.partieId === partieId);
    if (!snapshot) return;

    if (btn.dataset.resumeAction === 'resume') {
      dispatch({ type: 'RESUME_PARTIE', snapshot });
    } else if (await confirmDialog({
      title: 'Supprimer la partie interrompue',
      message: 'Supprimer définitivement cette partie interrompue ?',
      confirmLabel: 'Supprimer',
      danger: true,
    })) {
      dispatch({ type: 'DISCARD_RESUME', partieId });
      renderResumeBanner();
    }
  }, { signal });

  wireModes(signal);

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

  const suddenDeathToggle = root.querySelector('#sudden-death');
  suddenDeathToggle.addEventListener('change', () => {
    root.querySelector('#sudden-death-group').hidden = !suddenDeathToggle.checked;
  }, { signal });

  // Le compte du résumé suit chaque bascule. Sur `.settings-panel` plutôt que
  // sur chaque case : la délégation survit à un redessin.
  root.querySelector('.settings-panel').addEventListener('change', () => {
    refreshAdvanced(readRules());
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
    dispatch({ type: 'SET_PLAYERS', players });
    dispatch({
      type: 'SET_SETTINGS',
      patch: {
        ...readRules(),
        theme: currentTheme(),
        modeId: selectedModeId,
        sourceMode: activeWikiPick() ? 'wikipedia' : 'theme',
        sourceTitle: activeWikiPick()?.title || '',
        sourceLang: activeWikiPick()?.lang || 'fr',
        sourceUrl: activeWikiPick()?.url || '',
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
        <h1 id="setup-title">Réglages</h1>
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
          <legend>👥 Joueurs <span id="player-count-label">2/6</span></legend>
          <div id="players-list" class="players-list"></div>
          <button type="button" id="btn-add-player" class="button add-player-btn">+ Ajouter un joueur</button>
        </fieldset>
        <fieldset class="panel theme-panel">
          <legend>🎯 Thème</legend>
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
        <fieldset class="panel modes-panel">
          <legend>🎮 Mode de jeu</legend>
          <div id="modes-list" class="modes-grid" role="radiogroup" aria-label="Mode de jeu"></div>
          <p id="mode-status" class="mode-status" aria-live="polite"></p>
          <div id="mode-actions" class="mode-actions"></div>
        </fieldset>
        <fieldset class="panel settings-panel">
          <legend>🎲 Règles</legend>
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
          <!-- Réglages avancés repliés par défaut. Ils restent DANS
               .settings-panel : les écouteurs du badge « modifié » y sont
               délégués, les sortir du conteneur les couperait en silence. -->
          <details class="rules-advanced" id="rules-advanced">
            <summary class="rules-advanced__summary">Vacheries<span id="advanced-count" class="rules-advanced__count" hidden></span></summary>
            <div class="rules-advanced__body">
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
            <label class="toggle-row"><input id="sudden-death" type="checkbox" /> <span class="toggle-track"></span> Mort subite : exclusion de la manche après N fautes</label>
            <div class="rule-group" id="sudden-death-group" hidden>
              <span class="rule-group__label" id="sudden-death-label">Fautes avant exclusion</span>
              <div class="choice-group" role="radiogroup" aria-labelledby="sudden-death-label">
                ${SUDDEN_DEATH_CHOICES.map(c => `
                  <label class="choice-chip">
                    <input type="radio" name="suddenDeathStrikes" value="${c.value}" />
                    <span>${escapeHtml(c.label)}</span>
                  </label>
                `).join('')}
              </div>
              <p class="rule-group__hint">Une mauvaise réponse <strong>ou</strong> une absence de réponse compte. Le joueur exclu ne gagne ni ne perd plus rien jusqu\u2019à la fin de la manche, puis revient à la suivante.</p>
            </div>
            </div>
          </details>
        </fieldset>
        <p id="setup-error" class="form-error" role="alert" hidden></p>
        <button id="btn-start" class="button button--primary button--large" type="submit" disabled>▶ Générer la partie</button>
        <fieldset class="panel history-panel">
          <legend>📜 Historique de la session</legend>
          <div id="history-list" class="history-list">${HISTORY_EMPTY}</div>
        </fieldset>
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
  let lastModeKey = '';
  const unsub = subscribe(() => {
    if (!root) return;
    const s = getState();
    showError(s.ui.lastError ? s.ui.lastError.message : null);
    updateStartButton();

    // Le catalogue est semé en IndexedDB au démarrage : au montage de cet
    // écran il est souvent encore vide. Sans ce suivi, les cartes n'apparaissent
    // qu'au prochain passage sur les réglages.
    const modeKey = (s.ui.modes || []).map(m => `${m.id}:${m.name}:${m.emoji}`).join(',');
    if (modeKey !== lastModeKey) {
      lastModeKey = modeKey;
      renderModes();
    }

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
