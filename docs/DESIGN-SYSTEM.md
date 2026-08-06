# Design system

Toutes les valeurs visuelles de l'application sont déclarées dans
[`src/styles/tokens.css`](../src/styles/tokens.css). **Aucun composant ne
contient de couleur, de rayon, d'ombre ou d'espacement en dur.** Si une valeur
manque, on l'ajoute aux jetons — on ne l'écrit pas dans un `.tsx`.

## Fichiers

| Fichier | Rôle |
|---|---|
| `tokens.css` | jetons : couleurs, surfaces, états, provenance, typographie, espacements, rayons, ombres, durées, plans, cibles tactiles |
| `base.css` | réinitialisation, fond global, zones sûres, hauteurs, focus, impression |
| `components.css` | boutons, champs, cartes, badges, pastilles, tableaux, modales, feuilles, infobulles, bandeaux |
| `layout.css` | ossature, navigations, grilles de section, graphe, ventilation, matériel |

L'ordre d'import (`src/main.tsx`) est significatif : jetons, socle, composants,
mise en page.

## Couleurs

Quatre niveaux de surface seulement — `--bg`, `--bg-raised`, `--surface`,
`--surface-sunken` — séparés par une luminosité suffisante pour rester
distinguables sur un écran mat comme sur un téléphone en plein jour.

`--bg` est la **couleur de référence** : elle est reprise à l'identique par
`html`, `body`, `#root`, la balise `theme-color` et le manifest PWA. Une
divergence entre ces valeurs produit un flash blanc au lancement de
l'application installée. Un test le vérifie (`src/pwa/pwa.test.ts`).

### Contrastes

Mesurés sur `--surface` (#1b1f26), le fond sur lequel ces couleurs s'affichent
réellement — et non sur `--bg`, qui donnerait des valeurs flatteuses mais
fausses :

| Jeton | Contraste | Usage |
|---|---|---|
| `--text` | 17,4:1 | texte principal |
| `--text-2` | 6,5:1 | texte secondaire |
| `--text-3` | 5,3:1 | libellés de 11 px, unités, axes |

Le calcul est refait à chaque exécution des tests
(`src/ui/accessibility.test.tsx`) : modifier un jeton sous le seuil AA fait
échouer la suite.

### L'état n'est jamais porté par la seule couleur

Règle appliquée partout (WCAG 1.4.1) :

- les pastilles d'état changent **de forme** selon la gravité — disque pour
  normal, losange pour attention, carré arrondi pour critique, cercle vide pour
  inconnu ;
- une valeur simulée est **soulignée en pointillés** en plus d'être colorée ;
- l'entrée de navigation active porte une **barre d'accent** et
  `aria-current="page"` ;
- toute pastille est accompagnée d'un libellé textuel.

### Provenance des données

Cinq jetons dédiés (`--data-real`, `--data-simulated`, `--data-missing`,
`--data-error`) matérialisent une règle centrale : **une valeur simulée,
indisponible ou issue d'un capteur absent ne prend jamais l'apparence d'une
mesure réelle.** Voir [`src/ui/Measure.tsx`](../src/ui/Measure.tsx).

## Typographie

Piles système uniquement. **Aucune police distante n'est téléchargée** : le
serveur doit rester autonome sur un réseau local isolé, et l'application ne doit
dépendre d'aucune ressource extérieure.

Échelle : `--fs-xs` (11 px) à `--fs-2xl` (28 px). Les valeurs sont en `rem`,
donc sensibles au réglage de taille de texte du système.

## Cibles tactiles

`--touch: 44px` est le minimum recommandé par WCAG 2.2. La bascule ne dépend
**pas de la largeur** mais de la nature du pointeur :

```css
@media (pointer: coarse) {
  :root { --control-h: var(--touch); --touch-sm: var(--touch); }
}
```

Un écran tactile de 1920 px reste un écran tactile. Les champs passent en outre
à 16 px sur pointeur grossier : en dessous, iOS zoome de force à la mise au
point, ce qui décale toute la page. C'est ce réglage qui rend inutile le blocage
du zoom, et donc qui permet de rester conforme à WCAG 1.4.4.

## Préférences système

Les jetons réagissent directement à trois préférences :

| Préférence | Effet |
|---|---|
| `pointer: coarse` | cibles à 44 px, champs à 16 px |
| `prefers-reduced-motion: reduce` | durées à 0, animations en boucle supprimées |
| `prefers-contrast: more` | bordures plus franches, texte secondaire éclairci |

## Plans (z-index)

Une seule échelle, de `--z-base` à `--z-toast`. Aucun `z-index` littéral
ailleurs : c'est ce qui garantit qu'aucun élément ne passe derrière la
navigation basse ni devant une modale par accident.

## Ombres et animations

Ombres volontairement discrètes, aucun flou coûteux : l'application repeint des
données en continu, et une ombre portée large sur un élément qui change toutes
les deux secondes coûte cher sans rien apporter.

Aucune animation en boucle en dehors de la pastille critique, elle-même
désactivable par préférence utilisateur (section Paramètres) **et** par
préférence système.

## Ajouter un composant

1. Chercher d'abord une classe existante — `.card`, `.panel`, `.badge`,
   `.banner`, `.kv`, `.data-table` couvrent la plupart des besoins.
2. Si une nouvelle règle est nécessaire, l'écrire dans `components.css` (élément
   réutilisable) ou `layout.css` (mise en page d'une section).
3. N'employer que des jetons. Une valeur littérale dans une règle est un signal
   qu'il manque un jeton.
4. Vérifier le contraste sur `--surface`, pas seulement sur `--bg`.
