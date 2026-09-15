// themeSwitcher.js — gestion du thème de couleurs (data-color-theme).
import { COLOR_THEMES, DEFAULT_COLOR_THEME } from './constants.js';

const LS_KEY = 'quizz-canape:color-theme';

function isValidTheme(id) {
  return id && Object.hasOwn(COLOR_THEMES, id);
}

export function getColorTheme() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return isValidTheme(raw) ? raw : DEFAULT_COLOR_THEME;
  } catch { return DEFAULT_COLOR_THEME; }
}

export function setColorTheme(id) {
  if (!isValidTheme(id)) return;
  document.documentElement.dataset.colorTheme = id;
  try { localStorage.setItem(LS_KEY, id); } catch { /* quota exceeded */ }
}

export function initColorTheme() {
  const theme = getColorTheme();
  document.documentElement.dataset.colorTheme = theme;
}

/**
 * Retourne le HTML d'un <select> de thème, avec la value actuelle sélectionnée.
 */
export function renderThemeSelect() {
  const current = getColorTheme();
  const options = Object.entries(COLOR_THEMES).map(([id, { label }]) =>
    `<option value="${id}" ${id === current ? 'selected' : ''}>${label}</option>`
  ).join('');
  return `
    <label class="theme-picker" aria-label="Thème de couleurs">
      <select id="color-theme-select" autocomplete="off">
        ${options}
      </select>
    </label>`;
}

/**
 * Branche l'écouteur change sur le select dans le DOM root fourni.
 */
export function wireThemeSelect(root) {
  const select = root.querySelector('#color-theme-select');
  if (!select) return;
  select.addEventListener('change', () => setColorTheme(select.value));
}