#!/usr/bin/env node
// mock-llm.mjs — serveur OpenAI-compatible de DÉMO (aucune dépendance, Node stdlib).
// Renvoie des questions pré-écrites pour jouer au Quizz Canapé SANS clé API, SANS réseau.
// Lancement : `node demo/mock-llm.mjs` puis `npm run dev` (le .env pointe sur le mock).

import http from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const LATENCY_MS = Number(process.env.LATENCY_MS || 1200); // pour voir l'écran de chargement
const BATCH = 5;

// 15 questions valides (schéma SPEC §6). `answer`/`funnyOption` référencent des
// clés d'options ; `funnyOption` doit différer de `answer`.
const POOL = [
  { id: 'q1', theme: 'Sciences & nature', difficulty: 'easy',
    question: 'Quel animal est le plus gros mammifère terrestre ?',
    options: [ { key: 'A', text: "L'éléphant d'Afrique" }, { key: 'B', text: 'La girafe' }, { key: 'C', text: 'Le rhinocéros blanc' }, { key: 'D', text: "L'hippopotame" } ],
    answer: 'A', funnyOption: 'D',
    explanation: "Avec près de 6 tonnes, l'éléphant d'Afrique est le plus lourd animal terrestre. L'hippopotame est costaud, mais il reste loin derrière." },
  { id: 'q2', theme: 'Cinéma & séries', difficulty: 'easy',
    question: 'Dans quelle saga entend-on « Que la Force soit avec toi » ?',
    options: [ { key: 'A', text: 'Star Wars' }, { key: 'B', text: 'Retour vers le futur' }, { key: 'C', text: 'Avatar' }, { key: 'D', text: 'Les Goonies' } ],
    answer: 'A', funnyOption: 'D',
    explanation: "Cette phrase culte est prononcée par les Jedi dans la saga Star Wars de George Lucas. Elle est devenue l'une des répliques les plus connues du cinéma." },
  { id: 'q3', theme: 'Histoire', difficulty: 'medium',
    question: 'En quelle année le mur de Berlin est-il tombé ?',
    options: [ { key: 'A', text: '1989' }, { key: 'B', text: '1979' }, { key: 'C', text: '1991' }, { key: 'D', text: '1968' } ],
    answer: 'A', funnyOption: 'B',
    explanation: "Le mur de Berlin est tombé le 9 novembre 1989, marquant la fin de la division de l'Allemagne et le début de la réunification." },
  { id: 'q4', theme: 'Gastronomie', difficulty: 'easy',
    question: 'De quoi est composée la frangipane de la galette des rois ?',
    options: [ { key: 'A', text: 'Amandes' }, { key: 'B', text: 'Chocolat' }, { key: 'C', text: 'Pistaches' }, { key: 'D', text: 'Noix de coco' } ],
    answer: 'A', funnyOption: 'D',
    explanation: "La frangipane est une crème d'amandes, base de la galette des rois. La noix de coco n'a rien à faire dans une vraie frangipane." },
  { id: 'q5', theme: 'Musique', difficulty: 'easy',
    question: 'Combien de cordes possède une guitare classique ?',
    options: [ { key: 'A', text: '6' }, { key: 'B', text: '4' }, { key: 'C', text: '5' }, { key: 'D', text: '7' } ],
    answer: 'A', funnyOption: 'D',
    explanation: "La guitare classique possède six cordes : mi, la, ré, sol, si, mi. Pas sept, même si certains en rêvent." },
  { id: 'q6', theme: 'Jeux vidéo', difficulty: 'easy',
    question: 'Quel plombier moustachu sauve la princesse Peach ?',
    options: [ { key: 'A', text: 'Mario' }, { key: 'B', text: 'Luigi' }, { key: 'C', text: 'Sonic' }, { key: 'D', text: 'Wario' } ],
    answer: 'A', funnyOption: 'C',
    explanation: "Mario, le célèbre plombier de Nintendo, sauve la princesse Peach des griffes de Bowser. Sonic court vite, mais il est chez Sega." },
  { id: 'q7', theme: 'Sport', difficulty: 'medium',
    question: 'Combien de joueurs compte une équipe de rugby à XV sur le terrain ?',
    options: [ { key: 'A', text: '15' }, { key: 'B', text: '11' }, { key: 'C', text: '13' }, { key: 'D', text: '7' } ],
    answer: 'A', funnyOption: 'D',
    explanation: "Une équipe de rugby à XV aligne quinze joueurs. À XIII, il n'y en a que treize, et à sept, seulement sept." },
  { id: 'q8', theme: 'Culture générale', difficulty: 'easy',
    question: 'Quelle planète est surnommée la planète rouge ?',
    options: [ { key: 'A', text: 'Mars' }, { key: 'B', text: 'Vénus' }, { key: 'C', text: 'Jupiter' }, { key: 'D', text: 'Saturne' } ],
    answer: 'A', funnyOption: 'C',
    explanation: "Mars doit sa couleur rouge à l'oxyde de fer présent à sa surface. Jupiter est géante, mais elle n'est pas rouge." },
  { id: 'q9', theme: 'Cinéma & séries', difficulty: 'medium',
    question: "Qui a réalisé « E.T. l'extra-terrestre » ?",
    options: [ { key: 'A', text: 'Steven Spielberg' }, { key: 'B', text: 'George Lucas' }, { key: 'C', text: 'Tim Burton' }, { key: 'D', text: 'James Cameron' } ],
    answer: 'A', funnyOption: 'C',
    explanation: "Steven Spielberg a réalisé E.T. en 1982. Tim Burton signerait plutôt des films plus sombres et décalés." },
  { id: 'q10', theme: 'Sciences & nature', difficulty: 'medium',
    question: 'Combien de pattes possède une araignée ?',
    options: [ { key: 'A', text: '8' }, { key: 'B', text: '6' }, { key: 'C', text: '10' }, { key: 'D', text: '4' } ],
    answer: 'A', funnyOption: 'C',
    explanation: "Une araignée possède huit pattes, ce qui la distingue des insectes qui n'en ont que six." },
  { id: 'q11', theme: 'Histoire', difficulty: 'easy',
    question: "Quel monument parisien fut construit pour l'Exposition universelle de 1889 ?",
    options: [ { key: 'A', text: 'La tour Eiffel' }, { key: 'B', text: "L'Arc de triomphe" }, { key: 'C', text: 'Le Louvre' }, { key: 'D', text: 'Notre-Dame' } ],
    answer: 'A', funnyOption: 'D',
    explanation: "La tour Eiffel fut construite pour l'Exposition universelle de 1889. Notre-Dame, elle, est bien plus ancienne." },
  { id: 'q12', theme: 'Gastronomie', difficulty: 'medium',
    question: 'Quel fromage est originaire de Normandie ?',
    options: [ { key: 'A', text: 'Le camembert' }, { key: 'B', text: 'Le roquefort' }, { key: 'C', text: 'La mimolette' }, { key: 'D', text: 'Le comté' } ],
    answer: 'A', funnyOption: 'C',
    explanation: "Le camembert est originaire de Normandie. Le roquefort vient de l'Aveyron, la mimolette du Nord." },
  { id: 'q13', theme: 'Musique', difficulty: 'medium',
    question: 'Quel instrument possède 88 touches ?',
    options: [ { key: 'A', text: 'Le piano' }, { key: 'B', text: "L'orgue" }, { key: 'C', text: "L'accordéon" }, { key: 'D', text: 'Le synthétiseur' } ],
    answer: 'A', funnyOption: 'C',
    explanation: "Le piano moderne compte 88 touches : 52 blanches et 36 noires. L'accordéon, lui, se joue en tirant sur un soufflet." },
  { id: 'q14', theme: 'Jeux vidéo', difficulty: 'medium',
    question: 'Dans Minecraft, quel matériau faut-il fondre pour obtenir du verre ?',
    options: [ { key: 'A', text: 'Le sable' }, { key: 'B', text: 'La pierre' }, { key: 'C', text: 'La terre' }, { key: 'D', text: 'Le gravier' } ],
    answer: 'A', funnyOption: 'D',
    explanation: "Dans Minecraft, fondre du sable dans un four permet d'obtenir du verre. Le gravier ne donne que du gravier." },
  { id: 'q15', theme: 'Sport', difficulty: 'easy',
    question: 'Combien de joueurs forment une équipe de football sur le terrain ?',
    options: [ { key: 'A', text: '11' }, { key: 'B', text: '10' }, { key: 'C', text: '9' }, { key: 'D', text: '12' } ],
    answer: 'A', funnyOption: 'D',
    explanation: "Une équipe de football aligne onze joueurs sur le terrain, gardien de but compris." },
];

let calls = 0;

function buildBatch() {
  const start = (calls * BATCH) % POOL.length;
  const slice = [];
  for (let i = 0; i < BATCH; i++) slice.push(POOL[(start + i) % POOL.length]);
  return slice;
}

function openaiEnvelope(questions) {
  return {
    id: `chatcmpl-demo-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'quizz-demo',
    choices: [ { index: 0, message: { role: 'assistant', content: JSON.stringify({ questions }) }, finish_reason: 'stop' } ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

const server = http.createServer(async (req, res) => {
  for await (const chunk of req) { /* noop */ }
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mock: true, questions: POOL.length }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } }));
    return;
  }
  const questions = buildBatch();
  calls += 1;
  console.log(`[mock] requête #${calls} -> ${questions.length} questions (${req.url})`);
  await new Promise(r => setTimeout(r, LATENCY_MS));
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(openaiEnvelope(questions)));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] LLM de démo prêt sur http://127.0.0.1:${PORT} (${POOL.length} questions)`);
});
