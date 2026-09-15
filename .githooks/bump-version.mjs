// .githooks/bump-version.mjs — avance la version de package.json d'un cran.
//
// Deux comportements, selon que la version porte un compteur de pré-version :
//
//   0.2.0-rc.1   ->  0.2.0-rc.2     compteur de pré-version
//   0.1.3-beta   ->  0.1.4-beta     patch, identifiant conservé
//   1.0.0        ->  1.0.1          patch
//
// Sur une ligne de release candidate, c'est le numéro de RC qui avance : le
// patch désigne la version qu'on prépare (0.2.0), il ne doit pas dériver à
// chaque commit, sinon `rc.1` resterait figé pour toujours.
//
// Remplacement ciblé plutôt qu'un aller-retour JSON.parse/stringify : celui-ci
// reformaterait tout le fichier (indentation, ordre des clés, retour final) et
// polluerait chaque commit d'un diff sans rapport.
//
// `npm version` ne convient pas : `patch` retire l'identifiant de pré-version
// au lieu de l'incrémenter (`0.1.0-beta` deviendrait `0.1.0`, une version
// stable annoncée par accident).
import { readFileSync, writeFileSync } from 'node:fs';

const chemin = new URL('../package.json', import.meta.url);
const brut = readFileSync(chemin, 'utf8');

const motif = /("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(")/;
const m = motif.exec(brut);
if (!m) {
  console.error('[version] format inattendu dans package.json, incrément annulé');
  process.exit(1);
}

const [, avant, majeur, mineur, patch, prerelease, apres] = m;
const ancienne = `${majeur}.${mineur}.${patch}${prerelease ? `-${prerelease}` : ''}`;

const identifiants = prerelease ? prerelease.split('.') : null;
const dernier = identifiants ? identifiants[identifiants.length - 1] : null;

let version;
if (identifiants && /^(0|[1-9]\d*)$/.test(dernier)) {
  identifiants[identifiants.length - 1] = String(Number(dernier) + 1);
  version = `${majeur}.${mineur}.${patch}-${identifiants.join('.')}`;
} else {
  version = `${majeur}.${mineur}.${Number(patch) + 1}${prerelease ? `-${prerelease}` : ''}`;
}

writeFileSync(chemin, brut.replace(motif, `${avant}${version}${apres}`));
console.log(`[version] ${ancienne} -> ${version}`);
