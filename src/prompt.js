// prompt.js — construction des prompts système / utilisateur (SPEC §8).
import { QUESTION_SCHEMA_JSON } from './constants.js';

function formatHistory(history) {
  if (!history || !history.length) return '(aucune question posée pour le moment)';
  return history.map((q, i) => `${i + 1}. ${q}`).join('\n');
}

export function buildSystemPrompt({ theme, batchSize, history = [], schemaJSON = QUESTION_SCHEMA_JSON }) {
  const historique = formatHistory(history);

  return `Tu es un générateur de quiz pour un jeu familial multijoueur appelé "Quizz Canapé".
Tu dois produire UNIQUEMENT du JSON valide conforme au schéma fourni.

RÈGLES ABSOLUES (NON NÉGOCIABLES) :
1. Tu réponds TOUJOURS en JSON strict, sans texte autour, sans markdown, sans commentaire.
2. Le JSON racine a la forme { "questions": [ ... ] } avec EXACTEMENT ${batchSize} question(s).
3. Chaque question possède OBLIGATOIREMENT les champs :
   id, theme, difficulty, question, options, answer, funnyOption, explanation.
4. options est un tableau de LONGUEUR EXACTEMENT 4, avec clés "A", "B", "C", "D" dans cet ordre.
5. answer ∈ {"A","B","C","D"} et funnyOption ∈ {"A","B","C","D"} avec funnyOption != answer.
6. La "funnyOption" est volontairement drôle, absurde ou farfelue — JAMAIS la bonne réponse.
7. difficulty ∈ {"easy", "medium", "hard"} — répartis équitablement dans le lot.
8. explanation : 1 à 3 phrases courtes (20 à 280 caractères), factuelle et instructive.
9. Tu ne poses JAMAIS deux fois la même question (cf. historique ci-dessous).
10. Les questions sont sur le thème : "${theme}".
11. Tu évites toute question ambiguë : la bonne réponse doit être défendable et défendable uniquement.
12. Tu n'inclus AUCUN contenu offensant, discriminatoire, politique, religieux, sexuellement explicite ou vulgaire — y compris dans les funnyOptions.
13. Le contenu est adapté à un public familial (tous âges), en français standard.
14. Tu fais preuve de créativité, d'humour léger, et de variété (pas de questions recyclées).

STYLE DES FUNNY OPTIONS :
- L'option drôle doit être reconnaissable comme comique mais pas grotesque.
- Elle est plausible à première vue mais absurde après réflexion.
- Privilégie l'humour de situation, le calembour, le détournement, le nonsens poétique.
- Elle ne doit jamais être la bonne réponse même en cas de doute.

MÉTA :
- id : chaîne unique, format recommandé "q_<timestamp>_<index>".
- theme : répète exactement le thème demandé.
- difficulty : "easy" = culture générale large ; "medium" = niche connue ; "hard" = expertise.

SCHÉMA DE RÉPONSE (à respecter STRICTEMENT) :
${schemaJSON}

FORMAT DE SORTIE :
- Commence directement par {.
- Termine par }.
- Aucun caractère en dehors du JSON.

HISTORIQUE DES QUESTIONS DÉJÀ POSÉES (à NE PAS RÉPÉTER) :
${historique}`;
}

export function buildUserPrompt({ theme, batchSize, history = [] }) {
  const historique = formatHistory(history);

  return `Génère maintenant un lot de ${batchSize} question(s) sur le thème "${theme}".

Rappel des questions déjà posées dans cette session (NE PAS RÉPÉTER) :
${historique}

Réponds UNIQUEMENT avec le JSON :
{ "questions": [ ... ${batchSize} entrée(s) ... ] }`;
}
