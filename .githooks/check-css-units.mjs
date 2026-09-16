#!/usr/bin/env node
// .githooks/check-css-units.mjs — refuse toute longueur en px dans les feuilles
// de `src/styles/`. Le design system est intégralement en `em` (voir AGENTS.md,
// « Toutes les longueurs en em ») : une valeur en px ne suit ni le corps de texte
// du conteneur ni le zoom du navigateur, et rompt la mise à l'échelle par bloc.
//
// Lit le contenu MIS EN SCÈNE (`git show :fichier`), pas le fichier de travail :
// c'est ce qui part dans le commit qui compte.
//
// Échappatoire : SKIP_CSS_UNITS=1 git commit
import { execFileSync } from 'node:child_process';

if (process.env.SKIP_CSS_UNITS === '1') process.exit(0);

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

const stagedFiles = git('diff', '--cached', '--name-only', '--diff-filter=ACM')
  .split('\n')
  .filter((f) => /^src\/styles\/.+\.css$/.test(f));

if (!stagedFiles.length) process.exit(0);

// Les px cités dans un commentaire sont de la documentation (« 8px -> 14px »),
// pas des valeurs appliquées : on ne les compte pas.
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

const fautes = [];
for (const file of stagedFiles) {
  const lignes = stripComments(git('show', `:${file}`)).split('\n');
  lignes.forEach((ligne, i) => {
    if (/(?<![\w-])\d*\.?\d+px\b/.test(ligne)) {
      fautes.push(`  ${file}:${i + 1}  ${ligne.trim()}`);
    }
  });
}

if (fautes.length) {
  console.error(
    `\n✗ ${fautes.length} longueur(s) en px dans src/styles/ — le design system est en em :\n\n`
    + fautes.join('\n')
    + '\n\nConvertir en em : valeur_px / font-size_effectif_de_l_element.'
    + '\nUn filet de 1 ou 2 px s\'écrit .1em (voir AGENTS.md).'
    + '\nContournement explicite : SKIP_CSS_UNITS=1 git commit\n'
  );
  process.exit(1);
}
