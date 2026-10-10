import { buildSystemPrompt, buildUserPrompt } from '../src/prompt.js';

let passed = 0;
let failed = 0;
const ok = (label) => { passed += 1; console.log(`✓ ${label}`); };
const fail = (label) => { failed += 1; console.error(`✗ ${label}`); };

const base = { theme: 'Cinéma & séries', batchSize: 8, difficulty: 'balanced' };
const first = buildUserPrompt(base);
const second = buildUserPrompt(base);
if (first !== second && first.includes('Angle éditorial pour ce lot :') && second.includes('Angle éditorial pour ce lot :')) {
  ok('chaque lot contient un angle éditorial aléatoire');
} else {
  fail('les angles éditoriaux ne varient pas');
}

const adultSystem = buildSystemPrompt({ ...base, audience: 'nsfw' });
const adultUser = buildUserPrompt({ ...base, audience: 'nsfw' });
if (adultSystem.includes('franchement coquin') && adultSystem.includes('politiquement incorrect')
  && adultUser.includes('franchement coquin') && adultUser.includes('sans dénigrer')) {
  ok('le public adulte reçoit les consignes coquines et irrévérencieuses dans les deux prompts');
} else {
  fail('les consignes de public adulte sont incomplètes');
}

const general = buildUserPrompt({ ...base, audience: 'general' });
if (general.includes('familial') && !general.includes('franchement coquin')) {
  ok('les consignes du public général restent familiales');
} else {
  fail('les consignes adultes débordent sur le public général');
}

console.log(`\n${passed} ok, ${failed} échec(s)`);
if (failed) process.exitCode = 1;
