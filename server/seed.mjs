// server/seed.mjs — pré-remplit le cache de questions (thèmes de base × difficultés).
//
// Usage (clé LLM du .env, Node 24) :
//   node --env-file=.env server/seed.mjs [questionsParDifficulté]
//
// Génère `questionsParDifficulté` (défaut 50) questions pour chaque thème de base
// (PRESET_THEMES) × chaque difficulté granulaire (easy/medium/hard), public
// « general ». Le réglage « équilibré » (balanced) pioche ensuite dans les trois
// difficultés sans régénérer.
import { buildSystemPrompt, buildUserPrompt } from '../src/prompt.js';
import { QUESTION_SCHEMA_JSON, PRESET_THEMES } from '../src/constants.js';
import { addQuestions, extractQuestions } from './questionCache.mjs';

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const BATCH = 8;
const PER_DIFFICULTY = Math.max(1, Number(process.argv[2] || 50));

const baseUrl = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
const apiKey = process.env.LLM_API_KEY || '';
const model = process.env.LLM_MODEL || '';
const temperature = process.env.LLM_TEMPERATURE || '0.9';

if (!baseUrl || !apiKey || !model) {
  console.error('Config LLM manquante. Lancez avec : node --env-file=.env server/seed.mjs');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generateBatch(theme, difficulty, exclude) {
  const systemPrompt = buildSystemPrompt({
    theme, batchSize: BATCH, history: exclude,
    difficulty, audience: 'general', schemaJSON: QUESTION_SCHEMA_JSON,
  });
  const userPrompt = buildUserPrompt({
    theme, batchSize: BATCH, history: exclude, difficulty, audience: 'general',
  });
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: 'json_object' },
      max_tokens: 4096,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after')) || 8;
    console.log(`  (429, pause ${retryAfter} s)`);
    await sleep(retryAfter * 1000);
    return generateBatch(theme, difficulty, exclude);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
  }
  const envelope = await res.json();
  return extractQuestions(envelope?.choices?.[0]?.message?.content);
}

async function seedTheme(theme) {
  // Round-robin entre les difficultés : « équilibré » (ORDER BY created_at)
  // sert ainsi un mélange facile/moyen/difficile au lieu de tout le facile d'abord.
  const states = Object.fromEntries(DIFFICULTIES.map((d) => [d, { exclude: [], total: 0 }]));
  let allDone = false;
  while (!allDone) {
    allDone = true;
    for (const difficulty of DIFFICULTIES) {
      const st = states[difficulty];
      if (st.total >= PER_DIFFICULTY) continue;
      allDone = false;
      const questions = await generateBatch(theme, difficulty, st.exclude);
      if (!questions.length) throw new Error(`0 question pour ${difficulty}`);
      st.total += addQuestions({ theme, difficulty, audience: 'general', sourceKey: '' }, questions);
      st.exclude.push(...questions.map((q) => q.question));
      await sleep(500); // ménage le pool partagé du provider
    }
  }
  return DIFFICULTIES.map((d) => `${d}:${states[d].total}`).join(' · ');
}

console.log(`Seed : ${PRESET_THEMES.length} thèmes × 3 difficultés × ${PER_DIFFICULTY} questions`);
for (const theme of PRESET_THEMES) {
  try {
    const summary = await seedTheme(theme);
    console.log(`  ${theme} → ${summary}`);
  } catch (err) {
    console.error(`  [seed] ${theme} : ${err.message}`);
  }
}
console.log('Terminé.');
