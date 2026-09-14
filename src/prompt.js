// prompt.js — construction des prompts système / utilisateur (SPEC §8).
import { QUESTION_SCHEMA_JSON } from './constants.js';

function formatHistory(history) {
  if (!history || !history.length) return '(aucune question posée pour le moment)';
  return history.map((q, i) => `${i + 1}. ${q}`).join('\n');
}

const DIFFICULTY_RULES = {
  balanced: 'Les questions sont réparties équitablement entre "easy", "medium" et "hard".',
  easy: 'Toutes les questions sont de difficulté "easy" : culture générale très accessible, réponse évidente pour le grand public.',
  medium: 'Toutes les questions sont de difficulté "medium" : connaissances de niche moyennement connues.',
  hard: 'Toutes les questions sont de difficulté "hard" : niveau expert, connaissances pointues ou peu répandues.',
};

const AUDIENCE_RULES = {
  kids: 'Le contenu est strictement adapté aux enfants : aucun thème violent, anxiogène, politique, religieux ou à connotation sexuelle, aucun langage vulgaire ni insulte, humour bon enfant.',
  general: 'Le contenu est tout public : pas de violence graphique, pas de contenu sexuellement explicite, pas d\'insulte ni de vulgarité. L\'humour reste léger et familial.',
  nsfw: 'Le contenu peut être irrévérencieux, grivois ou vulgaire pour un public adulte (humour salace, sous-entendus). Restent interdits : le racisme, l\'homophobie, l\'incitation à la haine, la pédocriminalité et l\'apologie de la violence extrême.',
};

export function buildSystemPrompt({
  theme, batchSize, history = [], schemaJSON = QUESTION_SCHEMA_JSON,
  difficulty = 'balanced', audience = 'general',
}) {
  const historique = formatHistory(history);
  const difficultyRule = DIFFICULTY_RULES[difficulty] || DIFFICULTY_RULES.balanced;
  const audienceRule = AUDIENCE_RULES[audience] || AUDIENCE_RULES.general;

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
7. difficulty ∈ {"easy", "medium", "hard"}.
8. explanation : 1 à 3 phrases courtes (20 à 280 caractères), factuelle et instructive.
9. Tu ne poses JAMAIS deux fois la même question (cf. historique ci-dessous).
10. Les questions sont sur le thème : "${theme}".
11. Tu évites toute question ambiguë : la bonne réponse doit être défendable et défendable uniquement.
12. Difficulté du lot : ${difficultyRule}
13. Public visé : ${audienceRule}
14. Tu fais preuve de créativité, d'humour, et de variété (pas de questions recyclées).

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

export function buildUserPrompt({
  theme, batchSize, history = [], difficulty = 'balanced', audience = 'general',
}) {
  const historique = formatHistory(history);
  const difficultyRule = DIFFICULTY_RULES[difficulty] || DIFFICULTY_RULES.balanced;
  const audienceRule = AUDIENCE_RULES[audience] || AUDIENCE_RULES.general;

  return `Génère maintenant un lot de ${batchSize} question(s) sur le thème "${theme}".

Difficulté demandée : ${difficultyRule}
Public visé : ${audienceRule}

Rappel des questions déjà posées dans cette session (NE PAS RÉPÉTER) :
${historique}

Réponds UNIQUEMENT avec le JSON :
{ "questions": [ ... ${batchSize} entrée(s) ... ] }`;
}
