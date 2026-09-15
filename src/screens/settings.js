// screens/settings.js — paramètres GLOBAUX de l'appareil (configuration LLM).
//
// Séparé de l'écran de réglages de partie, qui est propre à une session. Ce qui
// vit ici est valable pour toutes les sessions et toutes les parties de ce
// navigateur : identifiants du fournisseur, modèle, température, taille de lot.
import { getState, dispatch } from '../state.js';
import { renderThemeSelect, wireThemeSelect, getColorTheme } from '../themeSwitcher.js';
import { buildShareUrl } from '../shareConfig.js';
import { wipeLocalStorage } from '../storage.js';
import { clearArchive } from '../db.js';

let teardown = null;
let root = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function dispatchToast(message, kind = 'info') {
  document.dispatchEvent(new CustomEvent('qc:toast', { detail: { message, kind } }));
}

const SHELL = `
  <section class="arcade arcade--setup screen" data-screen="settings" aria-labelledby="settings-title">
    <header class="arcade__bar">
      <button id="btn-back" class="arcade-btn arcade-btn--icon" type="button" aria-label="Retour au menu">‹</button>
      <h1 id="settings-title">Paramètres</h1>
      ${renderThemeSelect()}
    </header>

    <form id="settings-form" novalidate autocomplete="off">
      <fieldset class="panel llm-panel">
        <legend>Modèle LLM</legend>
        <p class="llm-note">
          Valable pour toutes vos sessions sur cet appareil. La clé API est
          stockée dans ce navigateur (localStorage) et n'est jamais envoyée
          ailleurs qu'à votre fournisseur.
        </p>

        <label class="field-label" for="llm-base-url">URL du provider</label>
        <input id="llm-base-url" type="text" autocomplete="off" spellcheck="false"
          placeholder="https://api.openai.com/v1" />

        <label class="field-label" for="llm-api-key">Clé API</label>
        <input id="llm-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" />

        <label class="field-label" for="llm-model">Modèle</label>
        <input id="llm-model" type="text" autocomplete="off" spellcheck="false" placeholder="gpt-4o-mini" />

        <label class="field-label" for="llm-temp">Température : <output id="llm-temp-output">0.9</output></label>
        <input id="llm-temp" type="range" min="0" max="2" step="0.1" value="0.9" />

        <button id="btn-test-connection" type="button" class="button button--small">Tester la connexion</button>
        <span id="test-result" class="llm-test-result" aria-live="polite"></span>
      </fieldset>

      <fieldset class="panel">
        <legend>Partager cette configuration</legend>
        <p class="llm-note llm-share-warning">
          Le lien contient votre <strong>clé API en clair</strong>. À envoyer à
          vos propres appareils, pas à publier.
        </p>
        <button id="btn-share-config" type="button" class="button button--small">Copier un lien de configuration</button>
        <input id="share-url" class="share-url" type="text" readonly hidden aria-label="Lien de configuration" />
      </fieldset>

      <fieldset class="panel danger-zone">
        <legend>Reset d'usine</legend>
        <p class="llm-note">
          Remet l'appareil dans son état de sortie de boîte : sessions, parties
          terminées, parties en cours, statistiques, joueurs, thème et configuration
          LLM sont effacés. Rien n'est récupérable.
          <br />Vos <strong>modes de jeu sont conservés</strong>, y compris ceux que
          vous avez créés — supprimez-les un par un depuis les réglages de partie.
        </p>
        <button id="btn-cleanup" type="button" class="button button--danger">
          Reset d'usine
        </button>
      </fieldset>
    </form>
  </section>
`;

function renderValues() {
  const llm = getState().llm;
  root.querySelector('#llm-base-url').value = llm.baseUrl || '';
  root.querySelector('#llm-api-key').value = llm.apiKey || '';
  root.querySelector('#llm-model').value = llm.model || '';
  const temp = llm.temperature ?? 0.9;
  root.querySelector('#llm-temp').value = temp;
  root.querySelector('#llm-temp-output').textContent = Number(temp).toFixed(1);
}

/** Lit les champs. Utilisé pour enregistrer et pour tester : le MJ vient
 *  peut-être de saisir sa clé sans l'avoir encore validée. */
function readFields() {
  return {
    baseUrl: root.querySelector('#llm-base-url').value.trim(),
    apiKey: root.querySelector('#llm-api-key').value.trim(),
    model: root.querySelector('#llm-model').value.trim(),
    temperature: parseFloat(root.querySelector('#llm-temp').value),
  };
}

/** Enregistre à chaque frappe : pas de bouton « Valider » à oublier. */
function persist() {
  dispatch({ type: 'SET_LLM', patch: readFields() });
}

async function testConnection(btn, resultEl) {
  const { baseUrl, apiKey, model } = readFields();
  if (!baseUrl || !apiKey) {
    resultEl.textContent = 'Renseignez l\'URL et la clé API.';
    resultEl.className = 'llm-test-result llm-test-result--error';
    return;
  }
  btn.disabled = true;
  resultEl.textContent = 'Test en cours…';
  resultEl.className = 'llm-test-result';

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch('/api/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LLM-Base-URL': baseUrl,
        'X-LLM-Api-Key': apiKey,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: model || 'auto',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 1,
      }),
    });
    clearTimeout(tid);
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) throw new Error('Clé API invalide (401/403).');
      throw new Error(`Erreur ${resp.status} du provider.`);
    }
    resultEl.textContent = 'Connecté ✓';
    resultEl.className = 'llm-test-result llm-test-result--ok';
  } catch (err) {
    clearTimeout(tid);
    resultEl.textContent = err.name === 'AbortError'
      ? 'Délai dépassé (10 s). Vérifiez l\'URL.'
      : `Échec : ${err.message}`;
    resultEl.className = 'llm-test-result llm-test-result--error';
  } finally {
    btn.disabled = false;
  }
}

export function renderSettings(rootEl) {
  unmountSettings();
  root = rootEl;
  root.innerHTML = SHELL;
  renderValues();

  const cleanup = new AbortController();
  const { signal } = cleanup;
  wireThemeSelect(root);

  root.querySelector('#btn-back').addEventListener('click', () => {
    dispatch({ type: 'GOTO_HOME' });
  }, { signal });

  for (const id of ['#llm-base-url', '#llm-api-key', '#llm-model']) {
    root.querySelector(id).addEventListener('input', persist, { signal });
  }
  const temp = root.querySelector('#llm-temp');
  temp.addEventListener('input', () => {
    root.querySelector('#llm-temp-output').textContent = parseFloat(temp.value).toFixed(1);
    persist();
  }, { signal });

  const testBtn = root.querySelector('#btn-test-connection');
  testBtn.addEventListener('click', () => {
    testConnection(testBtn, root.querySelector('#test-result'));
  }, { signal });

  root.querySelector('#btn-share-config').addEventListener('click', async () => {
    const current = readFields();
    if (!current.apiKey && !current.baseUrl && !current.model) {
      dispatchToast('Renseignez au moins un champ avant de générer un lien.', 'error');
      return;
    }
    const url = buildShareUrl(current, getColorTheme(), window.location.href);
    const field = root.querySelector('#share-url');
    field.hidden = false;
    field.value = url;
    try {
      await navigator.clipboard.writeText(url);
      dispatchToast('Lien copié. Il contient votre clé API.', 'info');
    } catch {
      // Presse-papiers refusé (contexte non sécurisé, permission) : le champ
      // reste affiché pour une copie manuelle.
      field.select();
      dispatchToast('Copie automatique refusée — sélectionnez le lien ci-dessous.', 'error');
    }
  }, { signal });

  root.querySelector('#btn-cleanup').addEventListener('click', async () => {
    // Double confirmation : l'action est irréversible et détruit des parties
    // qu'on ne peut pas reconstituer. La seconde demande de taper un mot, pour
    // qu'un double-clic accidentel ne suffise pas.
    if (!window.confirm(
      'Réinitialiser cet appareil ?\n\n'
      + 'Sessions, parties terminées, parties en cours, statistiques, joueurs, '
      + 'thème et configuration LLM seront effacés. Vos modes de jeu sont conservés.\n\n'
      + 'Cette action est définitive.'
    )) return;
    if (window.prompt('Pour confirmer, tapez : EFFACER') !== 'EFFACER') {
      dispatchToast('Réinitialisation annulée.', 'info');
      return;
    }

    // L'archive d'abord. Si elle résiste, on s'arrête AVANT de toucher à
    // localStorage : mieux vaut un appareil intact qu'un appareil à moitié
    // réinitialisé, dont les réglages pointeraient vers des parties encore là.
    if (!await clearArchive()) {
      dispatchToast(
        'Impossible de vider la base. Fermez les autres onglets du jeu puis réessayez.',
        'error');
      return;
    }

    // Puis localStorage, et on recharge SANS rien faire entre les deux.
    // L'abonné de main.js réécrit joueurs, réglages et clé API à chaque
    // dispatch : la moindre navigation avant le rechargement ressuscitait ce
    // qu'on vient d'effacer, et laissait un appareil à l'état incohérent.
    wipeLocalStorage();
    window.location.reload();
  }, { signal });

  teardown = () => {
    cleanup.abort();
    root = null;
  };
}

export function unmountSettings() {
  if (teardown) { teardown(); teardown = null; }
  root = null;
}
