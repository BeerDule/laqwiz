// validation.js — validation du contrat `Question` (SPEC §6).

const OPTION_KEYS = ['A', 'B', 'C', 'D'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];

// Liste noire minimale, extensible (filtre humour grossier).
const FORBIDDEN = [
  /\b(nazi|hitler|fascisme)\b/i,
  /\b(pute|bitte|cul|foutre|ntm)\b/i,
  /\b(raciste|racisme)\b/i,
  /\b(pédo|pedo)\b/i,
];

function fisherYatesShallow(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Normalise un énoncé pour l'anti-doublon : minuscules, espaces compressés,
 * ponctuation supprimée, Unicode normalisé NFD puis accents supprimés.
 */
export function normalizeQuestionText(s) {
  if (typeof s !== 'string') return '';
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Retourne { ok: boolean, errors: string[], normalized?: Question }.
 * Si ok === true, `normalized` contient la question avec options
 * potentiellement réordonnées (mélange) pour répartir la position de `answer`.
 */
export function validateQuestion(q, idx = 0, opts = {}) {
  const errors = [];
  const rng = opts.rng || Math.random;

  // 1. Présence des champs
  if (!q || typeof q !== 'object') {
    return { ok: false, errors: ['objet invalide'] };
  }
  const FIELDS = [
    'id', 'theme', 'difficulty', 'question',
    'options', 'answer', 'funnyOption', 'explanation',
  ];
  for (const field of FIELDS) {
    if (!(field in q)) errors.push(`champ manquant: ${field}`);
  }
  if (errors.length) return { ok: false, errors };

  // 2. Types
  if (typeof q.id !== 'string' || !q.id.trim()) {
    errors.push('id doit être une string non vide');
  }
  if (typeof q.theme !== 'string' || !q.theme.trim() || q.theme.length > 60) {
    errors.push('theme invalide');
  }
  if (!DIFFICULTIES.includes(q.difficulty)) {
    errors.push('difficulty doit être easy|medium|hard');
  }
  if (typeof q.question !== 'string') {
    errors.push('question doit être une string');
  } else {
    const trimmed = q.question.trim();
    if (trimmed.length < 10 || trimmed.length > 240) {
      errors.push('question longueur 10-240');
    }
    if (!trimmed.endsWith('?')) {
      errors.push('question doit finir par "?"');
    }
  }

  // 3. Options
  if (!Array.isArray(q.options) || q.options.length !== 4) {
    errors.push('options doit contenir exactement 4 entrées');
  } else {
    q.options.forEach((opt, i) => {
      if (!opt || typeof opt !== 'object') {
        errors.push(`option[${i}] invalide`);
        return;
      }
      if (opt.key !== OPTION_KEYS[i]) {
        errors.push(`option[${i}].key doit être "${OPTION_KEYS[i]}"`);
      }
      if (typeof opt.text !== 'string') {
        errors.push(`option[${i}].text doit être string`);
      } else {
        const t = opt.text.trim();
        if (t.length < 1 || t.length > 120) {
          errors.push(`option[${i}].text longueur 1-120`);
        }
      }
    });
  }

  // 4. answer et funnyOption
  if (!OPTION_KEYS.includes(q.answer)) {
    errors.push('answer doit être A|B|C|D');
  }
  if (!OPTION_KEYS.includes(q.funnyOption)) {
    errors.push('funnyOption doit être A|B|C|D');
  }
  if (q.answer && q.funnyOption && q.answer === q.funnyOption) {
    errors.push('funnyOption doit être différent de answer');
  }

  // 5. explanation
  if (typeof q.explanation !== 'string') {
    errors.push('explanation doit être string');
  } else {
    const t = q.explanation.trim();
    if (t.length < 20 || t.length > 280) {
      errors.push('explanation longueur 20-280');
    }
  }

  // 6. Filtre humour grossier
  const funnyText = (q.options.find(o => o && o.key === q.funnyOption)?.text) || '';
  const toCheck = `${q.question || ''} ${(q.options || []).map(o => (o && o.text) || '').join(' ')} ${funnyText}`;
  if (FORBIDDEN.some(re => re.test(toCheck))) {
    errors.push('humour offensant détecté');
  }

  if (errors.length) return { ok: false, errors };

  // 7. Normalisation : réordonne options (Fisher-Yates) et met à jour answer/funnyOption
  const reordered = fisherYatesShallow(q.options.map(o => o.key), rng);
  const remap = Object.fromEntries(reordered.map((k, i) => [k, OPTION_KEYS[i]]));
  const newOptions = reordered.map((k, i) => ({
    key: OPTION_KEYS[i],
    text: q.options.find(o => o.key === k).text,
  }));
  const newAnswer = remap[q.answer];
  const newFunny = remap[q.funnyOption];

  return {
    ok: true,
    errors: [],
    normalized: {
      id: q.id,
      theme: q.theme,
      difficulty: q.difficulty,
      question: q.question.trim(),
      options: newOptions,
      answer: newAnswer,
      funnyOption: newFunny,
      explanation: q.explanation.trim(),
    },
  };
}

/**
 * rawJson : ce qu'on a extrait de la réponse LLM (string ou objet).
 * Retourne { questions: Question[], errors: string[] }.
 */
export function parseQuestions(rawJson) {
  let parsed;
  if (typeof rawJson === 'string') {
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return { questions: [], errors: ['JSON global invalide'] };
    }
  } else if (typeof rawJson === 'object' && rawJson !== null) {
    parsed = rawJson;
  } else {
    return { questions: [], errors: ['type racine invalide'] };
  }

  // Tolérance : accepte soit { questions: [...] }, soit [...] directement
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.questions)
      ? parsed.questions
      : null;
  if (!arr) return { questions: [], errors: ['tableau de questions introuvable'] };

  const out = [];
  const errors = [];
  arr.forEach((q, i) => {
    const r = validateQuestion(q, i);
    if (r.ok) out.push(r.normalized);
    else errors.push(`q[${i}]: ${r.errors.join(', ')}`);
  });

  return { questions: out, errors };
}
