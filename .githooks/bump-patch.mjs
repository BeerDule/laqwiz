// .githooks/bump-patch.mjs — incrémente le patch de package.json.
//
// Remplacement ciblé plutôt qu'un aller-retour JSON.parse/stringify : celui-ci
// reformaterait tout le fichier (indentation, ordre des clés, retour final) et
// polluerait chaque commit d'un diff sans rapport.
//
// `npm version patch` ne convient pas ici : sur une préversion comme
// `0.1.0-beta`, npm retire l'identifiant au lieu d'incrémenter, ce qui
// donnerait `0.1.0` — une version stable annoncée par accident.
import { readFileSync, writeFileSync } from 'node:fs';

const chemin = new URL('../package.json', import.meta.url);
const brut = readFileSync(chemin, 'utf8');

const motif = /("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(")/;
const m = motif.exec(brut);
if (!m) {
  console.error(`[version] format inattendu dans package.json, incrément annulé`);
  process.exit(1);
}

const [, avant, majeur, mineur, patch, prerelease = '', apres] = m;
const version = `${majeur}.${mineur}.${Number(patch) + 1}${prerelease}`;
writeFileSync(chemin, brut.replace(motif, `${avant}${version}${apres}`));
console.log(`[version] ${m[2]}.${m[3]}.${m[4]}${prerelease} -> ${version}`);
