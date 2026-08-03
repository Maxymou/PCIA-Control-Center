# Architecture responsive

L'interface n'est pas une version desktop rétrécie par des media queries : la
**structure** change avec la taille de l'écran, et certaines fonctions ont une
présentation mobile distincte plutôt qu'une version dégradée.

## Points de rupture

Déclarés à trois endroits, à garder synchronisés :
[`tokens.css`](../src/styles/tokens.css) (commentaire de référence),
[`layout.css`](../src/styles/layout.css) et
[`useBreakpoint.ts`](../src/ui/useBreakpoint.ts).

| Nom | Largeur | Structure |
|---|---|---|
| mobile | < 768 px | une colonne, navigation basse, panneaux en feuilles |
| tablette | 768–1279 px | deux colonnes, navigation latérale réduite aux icônes |
| desktop | ≥ 1280 px | vue dense, navigation latérale déployée, panneaux persistants |

La **largeur** décide de la structure ; la **nature du pointeur** décide de
l'ergonomie (taille des cibles, disponibilité du survol). Les deux notions ne se
confondent jamais.

## Ossature

```
.app-viewport                    hauteur = --app-height
├── header                       peint la zone d'encoche haute
├── .app-body
│   ├── .app-nav                 ≥ 768 px seulement
│   └── main.app-main
│       ├── bandeau de liaison   visible depuis toutes les sections
│       └── section courante
└── .bottom-nav                  < 768 px seulement, peint la zone basse
```

La navigation basse **appartient au flux** du shell : elle ne recouvre pas le
contenu, ne crée pas de double marge, et ne bouge pas à l'ouverture du clavier —
la hauteur du shell étant `--app-height`, qui ne suit pas le clavier.

## Présentations distinctes, jamais dégradées

| Fonction | Desktop | Mobile |
|---|---|---|
| Services et connexions | graphe React Flow complet, panneau latéral permanent | vue liste triée par gravité + feuille de détail ; bascule vers le graphe possible |
| Cartes de synthèse | grille fluide `auto-fit` | deux colonnes (`--card-min` réduit) |
| Tableau de ventilation | tableau à cinq colonnes | une carte par sortie, aucune colonne supprimée |
| Réglage d'un point de courbe | glissement à la souris | glissement au doigt + champs numériques |
| Zoom du graphe | barre d'outils | boutons flottants à portée du pouce |
| Détail d'un élément | panneau latéral de 340 px | feuille mobile |

La bascule graphe ↔ liste suit la taille de l'écran par défaut. **Dès que
l'utilisateur choisit explicitement, son choix est respecté** et ne change plus
tout seul, y compris en rotation.

## Grilles

Aucune grille à nombre de colonnes figé. Le motif employé partout :

```css
grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
```

Les anciennes grilles `repeat(6, 1fr)` et `1.1fr 0.9fr 1.4fr` débordaient sous
1280 px — c'est ce que `body { min-width: 1280px }` masquait.

## Débordement horizontal

Le document ne défile **jamais** horizontalement. Les contenus larges défilent
dans leur propre conteneur :

- tableaux : `.table-scroll` ;
- barre d'outils du graphe : défilement horizontal sous 768 px, plutôt que
  plusieurs lignes qui mangeraient la hauteur utile ;
- graphe : zoom et déplacement propres.

Vérifié à chaque campagne de captures : `document.scrollWidth` doit rester égal
à `clientWidth` aux trois tailles.

## Zones sûres

Quatre variables déclarées une seule fois dans
[`base.css`](../src/styles/base.css) :

```css
--sat  encoche haute      --sab  indicateur d'accueil
--sal  bord gauche        --sar  bord droit
```

Aucun composant n'appelle `env()` directement. C'est ce qui évite les doubles
marges quand deux conteneurs imbriqués tentent chacun leur compensation.

Qui peint quoi :

| Élément | Zone |
|---|---|
| en-tête | `--sat` |
| navigation basse | `--sab` |
| `.app-main`, navigation latérale | `--sal`, `--sar` (paysage) |
| pied de feuille mobile | `--sab` |
| boutons flottants du graphe | `--sab` |

## Contrôler le rendu

Le serveur en mode démonstration suffit :

```bash
npm run build
PCIA_MODE=demo PCIA_DB=./tmp.db PCIA_RUNTIME_DIR=./run npm run server
```

Puis, dans un navigateur, réduire la fenêtre ou employer l'émulation d'appareil.
Trois tailles couvrent les cas utiles : **1600×950**, **900×1100**, **390×844**.

Points à vérifier à chaque taille :

1. `document.documentElement.scrollWidth === clientWidth` ;
2. aucune erreur dans la console ;
3. `--app-height` renseignée et cohérente ;
4. toutes les commandes atteignables sans survol ;
5. la navigation change bien de forme aux seuils.

### Audit d'accessibilité

L'audit est mené avec axe-core dans un vrai navigateur, sur chaque section, en
desktop et en mobile, ainsi qu'avec une modale ouverte. La procédure et le
script sont décrits dans le rapport de refonte ; le résultat attendu est **zéro
violation** pour les niveaux `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` et
`wcag22aa`.

Les garanties qui se dégraderaient le plus discrètement sont figées par
`src/ui/accessibility.test.tsx`, exécuté par `npm test`.
